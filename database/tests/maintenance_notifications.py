#!/usr/bin/env python3
"""Exercise maintenance notifications through independent PostgreSQL sessions.

Uses the audit container's psql, so no Python database driver is required. The
listener executes a command barrier after every writer operation to consume
actual committed LISTEN/NOTIFY messages without relying on a fixed sleep.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time
import uuid


ROOT = Path(__file__).resolve().parents[2]
CONTAINER = os.environ.get(
    "AERALYTH_TEST_CONTAINER", "aeralyth-audit-db-suite-20260912"
)
NOTIFICATION = re.compile(
    r'Asynchronous notification "aeralyth_maintenance" with payload "([^"]*)"'
)


class Psql:
    def __init__(self, database: str):
        self.process = subprocess.Popen(
            [
                "docker", "exec", "-i", CONTAINER, "psql", "-X", "-qAt",
                "-v", "ON_ERROR_STOP=1", "-P", "pager=off", "-U", "aeralyth",
                "-d", database,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        self.lines: queue.Queue[str | None] = queue.Queue()

        def read_output() -> None:
            assert self.process.stdout is not None
            for line in self.process.stdout:
                self.lines.put(line.rstrip("\n"))
            self.lines.put(None)

        self.reader = threading.Thread(target=read_output, daemon=True)
        self.reader.start()
        self.run("SELECT 1;")

    def run(self, sql: str) -> list[str]:
        marker = f"audit_barrier_{uuid.uuid4().hex}"
        assert self.process.stdin is not None
        self.process.stdin.write(f"{sql.rstrip()}\n\\echo {marker}\n")
        self.process.stdin.flush()
        output: list[str] = []
        deadline = time.monotonic() + 30
        while True:
            try:
                line = self.lines.get(timeout=max(0.001, deadline - time.monotonic()))
            except queue.Empty as error:
                raise AssertionError(f"psql command barrier timed out: {output}") from error
            if line is None:
                raise AssertionError(f"psql exited before command barrier: {output}")
            if line == marker:
                return output
            output.append(line)

    def notifications(self) -> list[str]:
        # A new query makes psql process pending backend messages before its echo.
        output = self.run("SELECT 1;")
        return [match.group(1) for line in output if (match := NOTIFICATION.search(line))]

    def close(self) -> None:
        if self.process.poll() is None:
            assert self.process.stdin is not None
            self.process.stdin.write("\\q\n")
            self.process.stdin.flush()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)


def docker(*arguments: str, input_text: str | None = None) -> str:
    result = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, *arguments],
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=True,
    )
    return result.stdout


def main() -> int:
    if not CONTAINER.startswith("aeralyth-audit-db-"):
        raise SystemExit("AERALYTH_TEST_CONTAINER must name an isolated aeralyth-audit-db-* container")
    database = f"aeralyth_audit_notify_{os.getpid()}_{uuid.uuid4().hex[:12]}"
    migration = ROOT / "database/init/036_maintenance_notifications.sql"
    if not migration.is_file():
        raise SystemExit("Maintenance notification migration 036 is missing")
    source_hash = hashlib.sha256(migration.read_bytes()).hexdigest()
    created = False
    listener: Psql | None = None
    writer: Psql | None = None
    checks = 0
    try:
        docker("createdb", "-U", "aeralyth", database)
        created = True
        print(f"Container: {CONTAINER}\nDatabase: {database}", flush=True)
        print(f"Migration 036 SHA256: {source_hash}", flush=True)
        for earlier in sorted((ROOT / "database/init").glob("[0-9][0-9][0-9]_*.sql")):
            if earlier.name >= migration.name:
                break
            docker(
                "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "aeralyth",
                "-d", database, input_text=earlier.read_text(),
            )
        writer = Psql(database)
        listener = Psql(database)
        listener.run("LISTEN aeralyth_maintenance;")
        assert listener.notifications() == []

        # Reproduce the original bug before applying the fix. No rows are needed.
        writer.run("UPDATE storage_deletion_jobs SET locked_until = now() WHERE FALSE;")
        before = listener.notifications()
        assert before == ["storage_deletion_jobs"], before
        print("PASS: baseline 023 trigger reproduced a notification for an empty worker UPDATE", flush=True)
        checks += 1
        writer.run(migration.read_text())
        assert listener.notifications() == []

        # Dedicated owners avoid an active tree job fencing unrelated fixtures.
        writer.run("""
INSERT INTO users (id, username, password_hash, role) VALUES
 ('usr_notify_owner', 'notify-owner', 'not-a-login-hash', 'user'),
 ('usr_notify_delete', 'notify-delete', 'not-a-login-hash', 'user'),
 ('usr_notify_delete_two', 'notify-delete-two', 'not-a-login-hash', 'user'),
 ('usr_notify_tree', 'notify-tree', 'not-a-login-hash', 'user'),
 ('usr_notify_tree_two', 'notify-tree-two', 'not-a-login-hash', 'user');
INSERT INTO storage_deletion_jobs (object_key) VALUES ('users/notify/delete');
INSERT INTO user_deletion_jobs (user_id) VALUES ('usr_notify_delete');
INSERT INTO file_uploads (id, file_id, owner_id, original_name, object_key, size_bytes, upload_mode, expires_at)
 VALUES ('up_notify_file', 'fil_notify_upload', 'usr_notify_owner', 'Upload', 'users/notify/files/upload', 1, 'local', now()+interval '1 day');
INSERT INTO vault_uploads (id,node_id,owner_id,entry_type,generation_number,generation_id,object_key,ciphertext_length,chunk_count,upload_mode)
 VALUES ('up_notify_vault','fil_notify_vault','usr_notify_owner','file',1,decode(repeat('11',16),'hex'),'users/notify/vault/upload',1,1,'single');
INSERT INTO invitations (id, invited_username, role, token_hash, created_by, expires_at)
 VALUES ('inv_notify', 'notify-invite', 'user', 'notify-invitation-token', 'usr_notify_owner', now()+interval '1 day');
INSERT INTO sessions (id,user_id,token_hash,csrf_token,expires_at)
 VALUES ('ses_notify','usr_notify_owner',decode(repeat('11',32),'hex'),'notify-csrf',now()+interval '1 day');
INSERT INTO files (id,owner_id,original_name,storage_name,size_bytes,entry_type)
 VALUES ('fil_notify','usr_notify_owner','Notify.txt','notify/file',1,'file'),
 ('fil_notify_tree_root','usr_notify_tree','Tree root','notify/tree-root',0,'folder'),
 ('fil_notify_tree_two','usr_notify_tree_two','Tree root two','notify/tree-root-two',0,'folder');
INSERT INTO tree_operation_jobs (owner_id,root_id,action)
 VALUES ('usr_notify_tree','fil_notify_tree_root','delete');
""")
        listener.notifications()

        # table, row predicate, scheduling column, unrelated update, actual update,
        # actual insert, whether an UPDATE trigger is intentionally installed
        cases = [
            ("storage_deletion_jobs", "object_key='users/notify/delete'", "available_at",
             "last_error='audit metadata'", "available_at=available_at-interval '1 minute'",
             "INSERT INTO storage_deletion_jobs(object_key) VALUES ('users/notify/delete-two')", True),
            ("user_deletion_jobs", "user_id='usr_notify_delete'", "available_at",
             "processed_rows=processed_rows+1", "available_at=available_at-interval '1 minute'",
             "INSERT INTO user_deletion_jobs(user_id) VALUES ('usr_notify_delete_two')", True),
            ("file_uploads", "id='up_notify_file'", "expires_at", "mime_type='text/plain'",
             "expires_at=expires_at-interval '1 minute'",
             "INSERT INTO file_uploads(id,file_id,owner_id,original_name,object_key,size_bytes,upload_mode,expires_at) VALUES ('up_notify_file_two','fil_notify_upload_two','usr_notify_owner','Upload two','users/notify/files/upload-two',1,'local',now()+interval '1 day')", True),
            ("vault_uploads", "id='up_notify_vault'", "expires_at", "created_at=created_at-interval '1 second'",
             "expires_at=expires_at-interval '1 minute'",
             "INSERT INTO vault_uploads(id,node_id,owner_id,entry_type,generation_number,generation_id,object_key,ciphertext_length,chunk_count,upload_mode) VALUES ('up_notify_vault_two','fil_notify_vault_two','usr_notify_owner','file',1,decode(repeat('22',16),'hex'),'users/notify/vault/upload-two',1,1,'single')", True),
            ("invitations", "id='inv_notify'", "expires_at", "invited_username='changed-invite-name'",
             "expires_at=expires_at-interval '1 minute'",
             "INSERT INTO invitations(id,invited_username,role,token_hash,created_by,expires_at) VALUES ('inv_notify_two','notify-invite-two','user','notify-invitation-two','usr_notify_owner',now()+interval '1 day')", True),
            ("sessions", "id='ses_notify'", "expires_at", "csrf_token='changed-csrf'",
             "expires_at=expires_at-interval '1 minute'",
             "INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES ('ses_notify_two','usr_notify_owner',decode(repeat('22',32),'hex'),now()+interval '1 day')", True),
            ("files", "id='fil_notify'", "state", "original_name='Renamed.txt'",
             "state='trashed',trashed_at=now()",
             "INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type) VALUES ('fil_notify_two','usr_notify_owner','Second.txt','notify/file-two',1,'file')", True),
            ("users", "id='usr_notify_owner'", "trash_retention_minutes", "display_name='Notification test'",
             "trash_retention_minutes=trash_retention_minutes-1",
             "INSERT INTO users(id,username,password_hash,role) VALUES ('usr_notify_added','notify-added','not-a-login-hash','user')", True),
            ("tree_operation_jobs", "owner_id='usr_notify_tree'", "available_at", "processed_nodes=processed_nodes+1",
             "available_at=available_at-interval '1 minute'",
             "INSERT INTO tree_operation_jobs(owner_id,root_id,action) VALUES ('usr_notify_tree_two','fil_notify_tree_two','delete')", False),
        ]

        def assert_messages(label: str, expected: list[str]) -> None:
            nonlocal checks
            messages = listener.notifications()
            assert messages == expected, f"{label}: expected {expected}, received {messages}"
            checks += 1
            print(f"PASS: {label}: {messages}", flush=True)

        for table, predicate, column, unrelated, actual, insert, update_notifies in cases:
            writer.run(f"INSERT INTO {table} SELECT * FROM {table} WHERE FALSE;")
            assert_messages(f"{table} zero-row INSERT", [])
            writer.run(f"UPDATE {table} SET {column}={column} WHERE FALSE;")
            assert_messages(f"{table} zero-row UPDATE", [])
            writer.run(f"UPDATE {table} SET {column}={column} WHERE {predicate};")
            assert_messages(f"{table} no-op UPDATE", [])
            writer.run(f"UPDATE {table} SET {unrelated} WHERE {predicate};")
            assert_messages(f"{table} unrelated metadata UPDATE", [])

            # Actual scheduling changes must remain invisible until transaction commit.
            writer.run(f"BEGIN; UPDATE {table} SET {actual} WHERE {predicate};")
            assert_messages(f"{table} scheduling UPDATE before COMMIT", [])
            writer.run("COMMIT;")
            assert_messages(f"{table} scheduling UPDATE after COMMIT", [table] if update_notifies else [])

            # Roll back each real INSERT first; then commit exactly the same operation.
            writer.run(f"BEGIN; {insert};")
            assert_messages(f"{table} real INSERT before COMMIT", [])
            writer.run("ROLLBACK;")
            assert_messages(f"{table} INSERT after ROLLBACK", [])
            writer.run(f"{insert};")
            assert_messages(f"{table} committed real INSERT", [] if table == "users" else [table])

        writer.run("""
BEGIN;
UPDATE sessions SET expires_at=expires_at-interval '1 minute' WHERE id='ses_notify';
UPDATE sessions SET expires_at=expires_at-interval '1 minute' WHERE id='ses_notify';
COMMIT;
""")
        assert_messages("same-table changes coalesce to one committed notification", ["sessions"])
        writer.run("""
BEGIN;
SAVEPOINT discarded_work;
UPDATE sessions SET expires_at=expires_at-interval '1 minute' WHERE id='ses_notify';
ROLLBACK TO SAVEPOINT discarded_work;
COMMIT;
""")
        assert_messages("rolled-back UPDATE savepoint emits no notification", [])
        writer.run("""
INSERT INTO storage_deletion_jobs(object_key)
VALUES ('users/notify/batch-one'),('users/notify/batch-two');
""")
        assert_messages("multirow INSERT emits one statement notification", ["storage_deletion_jobs"])
        empty_claim = """
WITH empty_jobs AS (SELECT id FROM storage_deletion_jobs WHERE FALSE FOR UPDATE SKIP LOCKED)
UPDATE storage_deletion_jobs AS target SET locked_until=now()+interval '5 minutes'
FROM empty_jobs WHERE target.id=empty_jobs.id;
"""
        writer.run(empty_claim * 64)
        assert_messages("64 empty maintenance claims produce no self-wake notifications", [])
        writer.run(migration.read_text())
        assert_messages("migration 036 replay emits no work notification", [])
        assert hashlib.sha256(migration.read_bytes()).hexdigest() == source_hash
        print(f"PASS: {checks} actual LISTEN/NOTIFY assertions; migration hash unchanged", flush=True)
        return 0
    finally:
        for session in [writer, listener]:
            if session is not None:
                session.close()
        if created:
            docker("dropdb", "-U", "aeralyth", "--if-exists", "--force", database)
            print(f"Cleaned generated audit database {database}", flush=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        print(error.stdout or str(error), file=sys.stderr)
        raise SystemExit(1) from error
