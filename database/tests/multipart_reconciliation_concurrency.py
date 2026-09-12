"""Exercise reconciliation against a writer that already holds the upload row.

Run only against a disposable audit database after migration 035. No production
resources are read or changed. Docker container/database can be overridden.
"""
import os
import subprocess
import time

container = os.environ.get("AERALYTH_TEST_CONTAINER", "aeralyth-audit-20260912")
database = os.environ.get("AERALYTH_TEST_DATABASE", "aeralyth_audit_storage")
if not database.startswith("aeralyth_audit"):
    raise SystemExit("This regression requires a disposable aeralyth_audit database")
command = ["docker", "exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "aeralyth", "-d", database]


def sql(statement):
    result = subprocess.run(command, input=statement, text=True, capture_output=True, timeout=15)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def send(process, statement):
    process.stdin.write(statement + "\n")
    process.stdin.flush()


def marker(process, expected):
    for line in process.stdout:
        if line.strip() == expected:
            return
    raise RuntimeError(f"psql exited before {expected}: {process.stderr.read()}")


user = "usr_multipart_lock_audit"
namespace = "audit-multipart-lock"
writer = None
reconciler = None
try:
    sql("""
    INSERT INTO users(id,username,password_hash,role)
    VALUES ('usr_multipart_lock_audit','multipart_lock_audit','unused','user');
    INSERT INTO file_uploads(id,file_id,owner_id,original_name,object_key,size_bytes,upload_mode,status,expires_at)
    VALUES ('up_lock_audit','fil_lock_audit','usr_multipart_lock_audit','lock',
    'users/lock/files/object',1,'multipart','initializing',now()+interval '1 hour');
    INSERT INTO multipart_reconciliation_progress(namespace,lease_token,lease_until)
    VALUES ('audit-multipart-lock','lock-leader',now()+interval '120 seconds');
    """)
    writer = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    send(writer, "BEGIN; SET LOCAL statement_timeout='5s'; SELECT id FROM file_uploads WHERE id='up_lock_audit' FOR UPDATE;\n\\echo WRITER_LOCKED")
    marker(writer, "WRITER_LOCKED")
    reconciler = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    send(reconciler, "SET application_name='aeralyth_orphan_lock_regression'; SET statement_timeout='5s';\n\\echo RECONCILER_STARTED\nSELECT prepare_multipart_orphan_group('audit-multipart-lock','lock-leader',ARRAY['users/lock/files/object'],ARRAY['provider-active']);\n\\echo RECONCILER_FINISHED\n\\q")
    marker(reconciler, "RECONCILER_STARTED")
    deadline = time.monotonic() + 3
    while sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='aeralyth_orphan_lock_regression' AND wait_event_type='Lock';") != "1":
        if time.monotonic() >= deadline:
            raise RuntimeError("reconciler did not wait on the held upload row")
        time.sleep(0.01)
    # Old code deadlocked here: the reconciler held the advisory identity lock,
    # and this BEFORE UPDATE trigger needed it while owning the upload row.
    send(writer, "UPDATE file_uploads SET status='pending',multipart_upload_id='provider-active' WHERE id='up_lock_audit'; COMMIT;\n\\echo WRITER_FINISHED\n\\q")
    writer_out, writer_err = writer.communicate(timeout=10)
    recon_out, recon_err = reconciler.communicate(timeout=10)
    if writer.returncode or reconciler.returncode:
        raise RuntimeError(f"concurrent writer/reconciler failed: {writer_err} {recon_err}")
    assert "WRITER_FINISHED" in writer_out
    assert "RECONCILER_FINISHED" in recon_out
    assert sql("SELECT multipart_upload_id FROM file_uploads WHERE id='up_lock_audit';") == "provider-active"
    assert sql("SELECT count(*) FROM multipart_orphan_abort_claims WHERE namespace='audit-multipart-lock';") == "0"
    print("PASS: concurrent initializer completes while reconciliation waits; active upload remains protected")
finally:
    for process in (writer, reconciler):
        if process is not None and process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
    sql(f"DELETE FROM users WHERE id='{user}'; DELETE FROM multipart_orphan_abort_claims WHERE namespace='{namespace}'; DELETE FROM multipart_reconciliation_progress WHERE namespace='{namespace}';")
