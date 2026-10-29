#!/usr/bin/env python3
"""Exercise migration 038 through independent PostgreSQL sessions.

Reuses the psql harness of maintenance_notifications.py, so it needs the same
isolated audit container and no Python database driver.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import uuid

from maintenance_notifications import CONTAINER, ROOT, Psql, docker


def main() -> int:
    if not CONTAINER.startswith("aeralyth-audit-db-"):
        raise SystemExit("AERALYTH_TEST_CONTAINER must name an isolated aeralyth-audit-db-* container")
    database = f"aeralyth_audit_quiet_notify_{os.getpid()}_{uuid.uuid4().hex[:12]}"
    migration = ROOT / "database/init/038_quiet_maintenance_notifications.sql"
    if not migration.is_file():
        raise SystemExit("Quiet maintenance notification migration 038 is missing")
    source_hash = hashlib.sha256(migration.read_bytes()).hexdigest()
    created = False
    listener: Psql | None = None
    writer: Psql | None = None
    checks = 0
    try:
        docker("createdb", "-U", "aeralyth", database)
        created = True
        print(f"Container: {CONTAINER}\nDatabase: {database}", flush=True)
        print(f"Migration 038 SHA256: {source_hash}", flush=True)
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

        writer.run("""
INSERT INTO users (id, username, password_hash, role) VALUES
 ('usr_quiet_owner', 'quiet-owner', 'not-a-login-hash', 'user'),
 ('usr_quiet_tree', 'quiet-tree', 'not-a-login-hash', 'user');
INSERT INTO files (id,owner_id,original_name,storage_name,size_bytes,entry_type)
 VALUES ('fil_quiet_tree_root','usr_quiet_tree','Tree root','quiet/tree-root',0,'folder');
INSERT INTO file_uploads (id, file_id, owner_id, original_name, object_key, size_bytes, upload_mode, expires_at)
 VALUES ('up_quiet_file', 'fil_quiet_upload', 'usr_quiet_owner', 'Upload', 'users/quiet/files/upload', 1, 'local', now()+interval '1 day'),
 ('up_quiet_file_two', 'fil_quiet_upload_two', 'usr_quiet_owner', 'Upload two', 'users/quiet/files/upload-two', 1, 'local', now()+interval '2 days');
INSERT INTO vault_uploads (id,node_id,owner_id,entry_type,generation_number,generation_id,object_key,ciphertext_length,chunk_count,upload_mode)
 VALUES ('up_quiet_vault','fil_quiet_vault','usr_quiet_owner','file',1,decode(repeat('11',16),'hex'),'users/quiet/vault/upload',1,1,'single'),
 ('up_quiet_vault_two','fil_quiet_vault_two','usr_quiet_owner','file',1,decode(repeat('22',16),'hex'),'users/quiet/vault/upload-two',1,1,'single');
UPDATE vault_uploads SET expires_at = expires_at + interval '1 day' WHERE id = 'up_quiet_vault_two';
INSERT INTO invitations (id, invited_username, role, token_hash, created_by, expires_at)
 VALUES ('inv_quiet', 'quiet-invite', 'user', 'quiet-invitation-token', 'usr_quiet_owner', now()+interval '1 day'),
 ('inv_quiet_two', 'quiet-invite-two', 'user', 'quiet-invitation-token-two', 'usr_quiet_owner', now()+interval '2 days');
INSERT INTO sessions (id,user_id,token_hash,csrf_token,expires_at)
 VALUES ('ses_quiet','usr_quiet_owner',decode(repeat('11',32),'hex'),'quiet-csrf',now()+interval '1 day'),
 ('ses_quiet_two','usr_quiet_owner',decode(repeat('22',32),'hex'),'quiet-csrf-two',now()+interval '2 days');
INSERT INTO storage_deletion_jobs (object_key) VALUES ('users/quiet/delete');
""")
        listener.notifications()
        writer.run(migration.read_text())
        assert listener.notifications() == []

        def assert_messages(label: str, expected: list[str]) -> None:
            nonlocal checks
            messages = listener.notifications()
            assert messages == expected, f"{label}: expected {expected}, received {messages}"
            checks += 1
            print(f"PASS: {label}: {messages}", flush=True)

        # table, first row, second row (one day later), status change or None
        cases = [
            ("file_uploads", "up_quiet_file", "up_quiet_file_two", "status='aborting'"),
            ("vault_uploads", "up_quiet_vault", "up_quiet_vault_two", "status='aborting'"),
            ("invitations", "inv_quiet", "inv_quiet_two", "status='revoked'"),
            ("sessions", "ses_quiet", "ses_quiet_two", None),
        ]
        for table, first, second, status_change in cases:
            writer.run(f"UPDATE {table} SET expires_at=expires_at WHERE FALSE;")
            assert_messages(f"{table} zero-row UPDATE", [])
            writer.run(f"UPDATE {table} SET expires_at=expires_at WHERE id='{first}';")
            assert_messages(f"{table} no-op UPDATE", [])
            writer.run(f"UPDATE {table} SET expires_at=expires_at+interval '1 hour' WHERE id='{first}';")
            assert_messages(f"{table} lease renewal moving the deadline later", [])
            writer.run(
                f"UPDATE {table} SET expires_at=expires_at+interval '1 minute' "
                f"WHERE id IN ('{first}','{second}');"
            )
            # The bound is conservative when the moved rows' ranges overlap.
            assert_messages(f"{table} overlapping multirow renewal", [table])
            writer.run(
                f"UPDATE {table} SET expires_at=expires_at+interval '1 day' WHERE id='{first}';"
                f"UPDATE {table} SET expires_at=expires_at+interval '5 days' WHERE id='{second}';"
            )
            assert_messages(f"{table} separate renewals in autocommit statements", [])
            writer.run(
                f"UPDATE {table} SET expires_at=CASE WHEN id='{first}' "
                f"THEN expires_at+interval '1 hour' ELSE expires_at-interval '1 hour' END "
                f"WHERE id IN ('{first}','{second}');"
            )
            assert_messages(f"{table} one deadline later and one earlier", [table])
            writer.run(f"BEGIN; UPDATE {table} SET expires_at=expires_at-interval '1 minute' WHERE id='{first}';")
            assert_messages(f"{table} earlier deadline before COMMIT", [])
            writer.run("COMMIT;")
            assert_messages(f"{table} earlier deadline after COMMIT", [table])
            if status_change is not None:
                writer.run(
                    f"UPDATE {table} SET {status_change}, expires_at=expires_at+interval '1 hour' "
                    f"WHERE id='{first}';"
                )
                assert_messages(f"{table} status change with a later deadline", [table])

        writer.run("UPDATE storage_deletion_jobs SET available_at=available_at+interval '1 minute';")
        assert_messages("tables without a deadline argument keep their projection", ["storage_deletion_jobs"])
        writer.run("""
INSERT INTO tree_operation_jobs (owner_id,root_id,action)
VALUES ('usr_quiet_tree','fil_quiet_tree_root','delete');
""")
        assert_messages("tree operation jobs no longer notify maintenance", [])
        writer.run(migration.read_text())
        assert_messages("migration 038 replay emits no work notification", [])
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
