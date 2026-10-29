"""Run against an isolated migrated test database via DATABASE_URL and optional PSQL."""
import os
import subprocess
import uuid

COMMAND = [os.environ.get("PSQL", "psql"), os.environ["DATABASE_URL"], "-XqAt", "-v", "ON_ERROR_STOP=1"]
FIXTURE_SUFFIX = uuid.uuid4().hex[:12]

def run(sql):
    return subprocess.run(COMMAND, input=sql.replace("parent_concurrency_", "parent_concurrency_" + FIXTURE_SUFFIX + "_"), text=True, capture_output=True, check=True).stdout

def session():
    return subprocess.Popen(COMMAND, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

def send(process, sql):
    process.stdin.write(sql.replace("parent_concurrency_", "parent_concurrency_" + FIXTURE_SUFFIX + "_") + "\n")
    process.stdin.flush()

def marker(process, expected):
    while True:
        line = process.stdout.readline()
        if not line:
            raise RuntimeError(process.stderr.read())
        if line.strip() == expected:
            return

run("""
INSERT INTO users(id,username,password_hash,role,status)
VALUES('parent_concurrency_owner','parent_concurrency_owner','not-a-login-hash','user','active');
INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type)
VALUES('parent_concurrency_root','parent_concurrency_owner','root','parent-concurrency/root',0,'folder');
""")
processes = []
try:
    first, second = session(), session()
    processes.extend([first, second])
    for process in [first, second]:
        send(process, """
        BEGIN;
        SET LOCAL statement_timeout='5s';
        SELECT pg_advisory_xact_lock_shared(hashtextextended('aeralyth:file-parent-lifecycle:parent_concurrency_root',0));
        SELECT id FROM files WHERE id='parent_concurrency_root' FOR KEY SHARE;
        \echo BOTH_PARENT_READERS_CAN_ENTER
        """)
        marker(process, "BOTH_PARENT_READERS_CAN_ENTER")
    busy = subprocess.run(COMMAND, input="\\set VERBOSITY verbose\nUPDATE files SET state='trashed' WHERE id='parent_concurrency_root';\n".replace("parent_concurrency_", "parent_concurrency_" + FIXTURE_SUFFIX + "_"), text=True, capture_output=True, timeout=10)
    if busy.returncode == 0 or "40001" not in busy.stderr:
        raise RuntimeError(f"Raw lifecycle update did not reject the row/advisory inversion: {busy.stdout} {busy.stderr}")
    print("Raw parent lifecycle update with concurrent child holders rejected immediately with 40001")
    for number, process in enumerate([first, second]):
        send(process, f"""
        INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id)
        VALUES('parent_concurrency_child_{number}','parent_concurrency_owner','child','parent-concurrency/child/{number}',1,'file','parent_concurrency_root');
        COMMIT;
        """)
    for process in [first, second]:
        stdout, stderr = process.communicate(timeout=10)
        if process.returncode:
            raise RuntimeError(f"Concurrent upload failed: {stdout} {stderr}")
    # Active parents do not track children (039); entering the trash counts them.
    count = run("UPDATE files SET state='trashed' WHERE id='parent_concurrency_root'; SELECT trash_child_count FROM files WHERE id='parent_concurrency_root';").strip()
    if count != "2":
        raise RuntimeError(f"Derived parent child count mismatch: {count}")
    print("Two concurrent sibling insertions, both holding compatible parent locks, committed; trashing the parent counted child_count=2")

    for isolation, code in [("REPEATABLE READ", "40001"), ("READ COMMITTED", "23514")]:
        run("UPDATE files SET state='active' WHERE id='parent_concurrency_root';")
        writer = session()
        processes.append(writer)
        send(writer, "\\set VERBOSITY verbose\nBEGIN ISOLATION LEVEL " + isolation + ";\nSELECT state FROM files WHERE id='parent_concurrency_root';\n\\echo OLD_PARENT_SNAPSHOT")
        marker(writer, "OLD_PARENT_SNAPSHOT")
        run("UPDATE files SET state='trashed',trashed_at=now() WHERE id='parent_concurrency_root';")
        send(writer, "INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id) VALUES('parent_concurrency_late','parent_concurrency_owner','late','parent-concurrency/late',1,'file','parent_concurrency_root');")
        stdout, stderr = writer.communicate(timeout=10)
        if code not in stderr or writer.returncode == 0:
            raise RuntimeError(f"{isolation} did not reject stale parent with {code}: {stdout} {stderr}")
        print(f"{isolation}: pre-trash parent snapshot publication rejected with {code}")
finally:
    for process in processes:
        if process.poll() is None:
            process.kill()
            process.communicate()
    run("DELETE FROM users WHERE id='parent_concurrency_owner';")
