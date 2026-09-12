"""Run against an isolated migrated test database via DATABASE_URL and optional PSQL."""
import os
import subprocess
import uuid

COMMAND = [os.environ.get("PSQL", "psql"), os.environ["DATABASE_URL"], "-XqAt", "-v", "ON_ERROR_STOP=1"]
FIXTURE_SUFFIX = uuid.uuid4().hex[:12]

def run(sql):
    result = subprocess.run(COMMAND, input=sql.replace("tree_concurrency_", "tree_concurrency_" + FIXTURE_SUFFIX + "_"), text=True, capture_output=True, check=True)
    return result.stdout

def session():
    return subprocess.Popen(COMMAND, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

def send(process, sql):
    process.stdin.write(sql.replace("tree_concurrency_", "tree_concurrency_" + FIXTURE_SUFFIX + "_") + "\n")
    process.stdin.flush()

def marker(process, expected):
    while True:
        line = process.stdout.readline()
        if not line:
            raise RuntimeError(process.stderr.read())
        if line.strip() == expected:
            return

for isolation, code in [("REPEATABLE READ", "40001"), ("READ COMMITTED", "55000")]:
    run("""
    INSERT INTO users(id,username,password_hash,role,status)
    VALUES('tree_concurrency_owner','tree_concurrency_owner','not-a-login-hash','user','active');
    INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id) VALUES
      ('tree_concurrency_root','tree_concurrency_owner','root','tree_concurrency/root',0,'folder',NULL),
      ('tree_concurrency_child','tree_concurrency_owner','child','tree_concurrency/child',1,'file','tree_concurrency_root');
    """)
    writer = session()
    publisher = session()
    try:
        send(writer, "\\set VERBOSITY verbose\nBEGIN ISOLATION LEVEL " + isolation + ";\nSELECT version FROM tree_operation_owners WHERE owner_id='tree_concurrency_owner';\n\\echo SNAPSHOT_READY")
        marker(writer, "SNAPSHOT_READY")
        send(publisher, "BEGIN;\nINSERT INTO tree_operation_jobs(owner_id,root_id,action) VALUES('tree_concurrency_owner','tree_concurrency_root','trash');\n\\echo FENCE_UNCOMMITTED")
        marker(publisher, "FENCE_UNCOMMITTED")
        send(writer, "UPDATE files SET original_name='must be rejected' WHERE id='tree_concurrency_child';")
        send(publisher, "COMMIT;\n\\echo FENCE_COMMITTED")
        marker(publisher, "FENCE_COMMITTED")
        stdout, stderr = writer.communicate(timeout=10)
        if code not in stderr or writer.returncode == 0:
            raise RuntimeError(f"{isolation} did not fail with {code}: {stdout} {stderr}")
        publisher.communicate(timeout=10)
        print(f"{isolation}: writer with pre-fence snapshot rejected with {code}")
    finally:
        for process in [writer, publisher]:
            if process.poll() is None:
                process.kill()
                process.communicate()
        run("DELETE FROM users WHERE id='tree_concurrency_owner';")
