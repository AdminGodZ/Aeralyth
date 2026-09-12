#!/usr/bin/env python3
"""Run expired-upload claim SQL against real tree fences and competing locks.

The SQL comes from the Rust worker and its shared owner gate. Each run creates
a disposable database in the audit container, applies every current migration,
and drops only that generated database. No Python PostgreSQL driver is needed.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import time
import uuid


ROOT = Path(__file__).resolve().parents[2]
CONTAINER = os.environ.get(
    "AERALYTH_TEST_CONTAINER", "aeralyth-audit-db-suite-20260912"
)
DATABASE = f"aeralyth_audit_expired_claims_{os.getpid()}_{uuid.uuid4().hex[:10]}"


def rust_query(path: Path, name: str) -> str:
    source = path.read_text()
    prefix = rf"\bconst\s+{re.escape(name)}\s*:\s*&str\s*=\s*"
    quoted = re.search(prefix + r'("(?:[^"\\]|\\.)*")\s*;', source, re.S)
    if quoted:
        return json.loads(quoted.group(1), strict=False)
    raw = re.search(prefix + r'r#"(.*?)"#\s*;', source, re.S)
    if raw:
        return raw.group(1)
    raise AssertionError(f"Cannot find SQL constant {name} in {path}")


def docker(*arguments: str, input_text: str | None = None) -> str:
    result = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, *arguments],
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=60,
        check=True,
    )
    return result.stdout


def literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def array(values: list[str]) -> str:
    return "ARRAY[" + ",".join(literal(value) for value in values) + "]::text[]"


class Psql:
    def __init__(self) -> None:
        self.process = subprocess.Popen(
            [
                "docker", "exec", "-i", CONTAINER, "psql", "-X", "-qAt",
                "-v", "ON_ERROR_STOP=1", "-P", "pager=off", "-U", "aeralyth",
                "-d", DATABASE,
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
        self.run("SET statement_timeout='3s'; SET client_min_messages=warning;")

    def run(self, sql: str) -> list[str]:
        marker = f"expired_claim_barrier_{uuid.uuid4().hex}"
        assert self.process.stdin is not None
        self.process.stdin.write(f"{sql.rstrip()}\n\\echo {marker}\n")
        self.process.stdin.flush()
        output: list[str] = []
        deadline = time.monotonic() + 10
        while True:
            try:
                line = self.lines.get(timeout=max(0.001, deadline - time.monotonic()))
            except queue.Empty as error:
                raise AssertionError(f"psql command timed out: {output}") from error
            if line is None:
                raise AssertionError(f"psql exited before command barrier: {output}")
            if line == marker:
                return output
            output.append(line)

    def close(self) -> None:
        if self.process.poll() is None:
            assert self.process.stdin is not None
            try:
                self.process.stdin.write("ROLLBACK;\n\\q\n")
                self.process.stdin.flush()
                self.process.wait(timeout=5)
            except (BrokenPipeError, subprocess.TimeoutExpired):
                self.process.kill()
                self.process.wait(timeout=5)


def prepare(session: Psql, queries: dict[str, str]) -> None:
    for kind in ("file", "vault"):
        session.run(
            f"PREPARE candidate_{kind}(bigint, timestamptz, text, timestamptz) AS {queries[f'candidate_{kind}']};"
        )
        session.run(
            f"PREPARE claim_{kind}(text[], text[]) AS {queries[f'claim_{kind}']};"
        )
    session.run(f"PREPARE claim_owners(text[]) AS {queries['owners']};")


def candidates(
    session: Psql,
    kind: str,
    limit: int = 25,
    cursor: tuple[str | None, str | None, str] | None = None,
) -> list[list[str]]:
    timestamp, upload_id, cutoff = (
        (literal(value) if value is not None else "NULL" for value in cursor)
        if cursor else ("NULL", "NULL", "clock_timestamp()")
    )
    output = session.run(
        f"EXECUTE candidate_{kind}({limit},{timestamp},{upload_id},{cutoff});"
    )
    return [line.split("|") for line in output]


def admitted_owners(session: Psql, rows: list[list[str]]) -> list[str]:
    owners = sorted({row[1] for row in rows})
    return session.run(f"EXECUTE claim_owners({array(owners)});")


def claim(session: Psql, kind: str, rows: list[list[str]], owners: list[str]) -> set[str]:
    output = session.run(
        f"EXECUTE claim_{kind}({array([row[0] for row in rows])},{array(owners)});"
    )
    return {line.split("|")[0] for line in output}


def claim_tick(
    session: Psql, kind: str, cursor: tuple[str | None, str | None, str] | None = None
) -> tuple[set[str], tuple[str | None, str | None, str] | None, int]:
    claimed: set[str] = set()
    pages = 0
    session.run("BEGIN ISOLATION LEVEL READ COMMITTED;")
    if cursor is None:
        cursor = (None, None, session.run("SELECT clock_timestamp();")[0])
    for _ in range(4):
        rows = candidates(session, kind, 25 - len(claimed), cursor)
        if not rows:
            cursor = None
            break
        pages += 1
        assert len(rows) <= 25 - len(claimed), rows
        end_of_queue = len(rows) < 25 - len(claimed)
        cursor = (rows[-1][2], rows[-1][0], cursor[2])
        owners = admitted_owners(session, rows)
        if owners:
            claimed.update(claim(session, kind, rows, owners))
        if end_of_queue:
            cursor = None
            break
        if len(claimed) == 25:
            break
    session.run("COMMIT;")
    return claimed, cursor, pages


def insert_owner(session: Psql, owner: str) -> None:
    session.run(f"""
INSERT INTO users(id,username,password_hash,role)
VALUES ({literal(owner)},{literal(owner)},'not-a-login-hash','user');
INSERT INTO files(id,owner_id,original_name,storage_name,size_bytes,entry_type,parent_id)
VALUES ({literal(owner + '_root')},{literal(owner)},'root',{literal(owner + '/root')},0,'folder',NULL),
       ({literal(owner + '_parent')},{literal(owner)},'parent',{literal(owner + '/parent')},0,'folder',{literal(owner + '_root')}),
       ({literal(owner + '_child')},{literal(owner)},'child',{literal(owner + '/child')},1,'file',{literal(owner + '_parent')}),
       ({literal(owner + '_sibling')},{literal(owner)},'sibling',{literal(owner + '/sibling')},0,'folder',NULL);
INSERT INTO share_links(id,token_hash,owner_id,root_file_id,access_scope,permission)
VALUES ({literal(owner + '_link')},{literal(owner + '_token')},{literal(owner)},
        {literal(owner + '_parent')},'public','editor');
""")


def insert_upload(
    session: Psql,
    kind: str,
    owner: str,
    suffix: str,
    reference: str | None = None,
    *,
    status: str = "pending",
    future: bool = False,
    age: int = 1,
) -> str:
    upload_id = f"{owner}_{kind}_{suffix}"
    node_id = owner + "_child" if reference in ("file_id", "node_id") else upload_id + "_node"
    parent_id = owner + ("_parent" if reference == "parent_id" else "_sibling")
    expiry = "now()+interval '1 day'" if future else f"now()-interval '{age} hours'"
    if kind == "file":
        replacement = literal(owner + "_child") if reference == "replacement_file_id" else "NULL"
        link = literal(owner + "_link") if reference == "share_link_id" else "NULL"
        session.run(f"""
INSERT INTO file_uploads(id,file_id,owner_id,parent_id,original_name,object_key,
                         size_bytes,upload_mode,status,expires_at,write_expires_at,
                         replacement_file_id,share_link_id)
VALUES ({literal(upload_id)},{literal(node_id)},{literal(owner)},{literal(parent_id)},
        {literal(suffix)},{literal('users/' + upload_id)},1,'single',{literal(status)},
        {expiry},now()+interval '2 hours',{replacement},{link});
""")
    else:
        session.run(f"""
INSERT INTO vault_uploads(id,node_id,owner_id,parent_id,entry_type,generation_number,
                          generation_id,object_key,ciphertext_length,chunk_count,
                          upload_mode,status,expires_at,write_expires_at)
VALUES ({literal(upload_id)},{literal(node_id)},{literal(owner)},{literal(parent_id)},
        'file',1,decode(repeat('11',16),'hex'),{literal('users/' + upload_id)},1,1,
        'single',{literal(status)},{expiry},now()+interval '2 hours');
""")
    return upload_id


def publish_fence(session: Psql, owner: str) -> None:
    session.run(f"""
INSERT INTO tree_operation_jobs(owner_id,root_id,action)
VALUES ({literal(owner)},{literal(owner + '_root')},'trash');
""")


def clean_owner(session: Psql, owner: str) -> None:
    session.run(f"""
DELETE FROM tree_operation_jobs WHERE owner_id={literal(owner)};
DELETE FROM users WHERE id={literal(owner)};
DELETE FROM storage_deletion_jobs WHERE object_key LIKE {literal('users/' + owner + '_%')};
""")


def test_active_fence(worker: Psql, writer: Psql, kind: str) -> None:
    owner = f"expired_active_{kind}"
    insert_owner(writer, owner)
    references = (
        ["file_id", "parent_id", "replacement_file_id", "share_link_id"]
        if kind == "file" else ["node_id", "parent_id"]
    )
    fenced = {
        insert_upload(writer, kind, owner, reference, reference, age=3)
        for reference in references
    }
    # More fenced rows than four complete pages require cursor progress across
    # worker calls, while every raw candidate page remains bounded to 25 rows.
    fenced.update(
        insert_upload(writer, kind, owner, f"old_{index}", "parent_id", age=2)
        for index in range(126)
    )
    statuses = ["initializing", "pending", "aborting"]
    if kind == "vault":
        statuses.append("completing")
    expected = {
        insert_upload(writer, kind, owner, f"healthy_{status}", status=status)
        for status in statuses
    }
    near_deadline = None
    if kind == "vault":
        near_deadline = insert_upload(writer, kind, owner, "healthy_near_deadline")
        writer.run(
            "UPDATE vault_uploads SET write_expires_at=now()+interval '1 minute' "
            f"WHERE id={literal(near_deadline)};"
        )
        expected.add(near_deadline)
    excluded = {
        insert_upload(writer, kind, owner, "future", future=True),
        insert_upload(writer, kind, owner, "aborted", status="aborted"),
        insert_upload(
            writer, kind, owner, "terminal",
            status="completed" if kind == "file" else "published",
        ),
    }
    if kind == "file":
        excluded.add(insert_upload(writer, kind, owner, "completing", status="completing"))
    publish_fence(writer, owner)
    worker.run("BEGIN ISOLATION LEVEL READ COMMITTED;")
    rows = candidates(worker, kind)
    assert len(rows) == 25 and {row[0] for row in rows} <= fenced, rows
    owners = admitted_owners(worker, rows)
    assert owners == [owner], owners
    assert claim(worker, kind, rows, owners) == set()
    # Passing all fixture IDs checks the UPDATE's fence and state predicates
    # independently of the candidate scan and the worker's cursor bookkeeping.
    all_rows = [[upload_id, owner] for upload_id in sorted(expected | fenced | excluded)]
    assert claim(worker, kind, all_rows, owners) == expected
    assert worker.run(
        f"SELECT count(*) FROM {kind}_uploads WHERE id=ANY({array(sorted(fenced))}) "
        "AND expires_at < now() AND status='pending';"
    ) == [str(len(fenced))]
    if kind == "file":
        queued = worker.run("SELECT object_key FROM storage_deletion_jobs ORDER BY object_key;")
        assert set(queued) == {"users/" + upload_id for upload_id in expected}, queued
    else:
        assert worker.run(
            f"SELECT count(*) FROM vault_uploads WHERE id=ANY({array(sorted(expected))}) "
            "AND status='aborting' AND expires_at >= write_expires_at;"
        ) == [str(len(expected))]
        assert near_deadline is not None
        assert worker.run(
            "SELECT status,expires_at = write_expires_at,write_expires_at > now() "
            f"FROM vault_uploads WHERE id={literal(near_deadline)};"
        ) == ["aborting|t|t"]
    worker.run("ROLLBACK;")
    writer.run(f"UPDATE tree_operation_jobs SET status='running' WHERE owner_id={literal(owner)};")
    first, cursor, first_pages = claim_tick(worker, kind)
    assert first == set() and cursor is not None and first_pages == 4
    second, cursor, second_pages = claim_tick(worker, kind, cursor)
    assert second == expected and cursor is None and second_pages == 2, (second, cursor, second_pages)
    clean_owner(writer, owner)
    print(f"PASS: {kind} returns at most 25 candidates per page and advances past over 100 fenced uploads across worker calls", flush=True)


def test_contention(worker: Psql, writer: Psql, blocker: Psql, kind: str, lock: str) -> None:
    owner = f"expired_{kind}_{lock}"
    other = owner + "_other"
    insert_owner(writer, owner)
    insert_owner(writer, other)
    busy = insert_upload(writer, kind, owner, "busy", age=3)
    same_owner = insert_upload(writer, kind, owner, "sibling", age=2)
    unrelated = insert_upload(writer, kind, other, "healthy")
    blocker.run("BEGIN;")
    if lock == "advisory":
        blocker.run(
            "SELECT pg_advisory_xact_lock(hashtextextended(" +
            literal("aeralyth:tree-operation:" + owner) + ",0));"
        )
    elif lock == "owner_row":
        blocker.run(
            f"SELECT owner_id FROM tree_operation_owners WHERE owner_id={literal(owner)} FOR UPDATE;"
        )
    else:
        blocker.run(f"SELECT id FROM {kind}_uploads WHERE id={literal(busy)} FOR UPDATE;")
    worker.run("BEGIN ISOLATION LEVEL READ COMMITTED;")
    rows = candidates(worker, kind)
    assert {row[0] for row in rows} == {busy, same_owner, unrelated}, rows
    owners = admitted_owners(worker, rows)
    expected = {same_owner, unrelated} if lock == "upload_row" else {unrelated}
    expected_owners = {owner, other} if lock == "upload_row" else {other}
    assert set(owners) == expected_owners, owners
    assert claim(worker, kind, rows, owners) == expected
    worker.run("ROLLBACK;")
    blocker.run("ROLLBACK;")
    # Releasing the contender makes all previously skipped work claimable.
    worker.run("BEGIN;")
    rows = candidates(worker, kind)
    assert claim(worker, kind, rows, admitted_owners(worker, rows)) == {busy, same_owner, unrelated}
    worker.run("ROLLBACK;")
    clean_owner(writer, owner)
    clean_owner(writer, other)
    print(f"PASS: {kind} {lock} contention skips busy work and resumes after lock release", flush=True)


def test_published_between_statements(worker: Psql, writer: Psql, kind: str) -> None:
    owner = f"expired_race_{kind}"
    insert_owner(writer, owner)
    fenced = insert_upload(writer, kind, owner, "newly_fenced", "parent_id", age=3)
    healthy = insert_upload(writer, kind, owner, "healthy")
    worker.run("BEGIN ISOLATION LEVEL READ COMMITTED;")
    rows = candidates(worker, kind)
    assert {row[0] for row in rows} == {fenced, healthy}, rows
    # Commit publication after discovery, before taking the owner gate. The
    # claim must read the fence from a fresh statement snapshot and skip it.
    publish_fence(writer, owner)
    owners = admitted_owners(worker, rows)
    assert owners == [owner], owners
    assert claim(worker, kind, rows, owners) == {healthy}
    assert worker.run(
        f"SELECT status,expires_at < now() FROM {kind}_uploads WHERE id={literal(fenced)};"
    ) == ["pending|t"]
    worker.run("ROLLBACK;")
    clean_owner(writer, owner)
    print(f"PASS: {kind} fresh claim snapshot excludes a fence published after candidate selection", flush=True)


def test_refill(worker: Psql, writer: Psql, blocker: Psql, kind: str, lock: str) -> None:
    owner = f"expired_refill_{kind}_{lock}"
    other = owner + "_other"
    insert_owner(writer, owner)
    insert_owner(writer, other)
    busy = {
        insert_upload(writer, kind, owner, f"busy_{index}", age=3)
        for index in range(30)
    }
    writer.run(
        f"UPDATE {kind}_uploads SET expires_at='2000-01-01 00:00:00+00' "
        f"WHERE id=ANY({array(sorted(busy))});"
    )
    healthy = insert_upload(writer, kind, other, "healthy")
    blocker.run("BEGIN;")
    if lock == "advisory":
        blocker.run(
            "SELECT pg_advisory_xact_lock(hashtextextended(" +
            literal("aeralyth:tree-operation:" + owner) + ",0));"
        )
    else:
        blocker.run(
            f"SELECT id FROM {kind}_uploads WHERE id=ANY({array(sorted(busy))}) FOR UPDATE;"
        )
    claimed, cursor, rounds = claim_tick(worker, kind)
    assert claimed == {healthy}, (kind, lock, claimed)
    assert rounds == 2 and cursor is None, (kind, lock, rounds, cursor)
    blocker.run("ROLLBACK;")
    first, cursor, pages = claim_tick(worker, kind, cursor)
    assert len(first) == 25 and first <= busy and pages == 1 and cursor is not None
    second, cursor, pages = claim_tick(worker, kind, cursor)
    assert first.isdisjoint(second) and first | second == busy
    assert cursor is None and pages == 1
    clean_owner(writer, owner)
    clean_owner(writer, other)
    print(f"PASS: {kind} refills past 30 uploads held by {lock} contention within two candidate pages", flush=True)


def test_continuous_arrivals(worker: Psql, writer: Psql, kind: str) -> None:
    owner = f"expired_arrivals_{kind}"
    insert_owner(writer, owner)
    old = {
        insert_upload(writer, kind, owner, f"old_{index}", "parent_id", age=3)
        for index in range(110)
    }
    publish_fence(writer, owner)
    claimed, cursor, pages = claim_tick(worker, kind)
    assert claimed == set() and pages == 4 and cursor is not None
    first_cutoff = cursor[2]
    writer.run(f"DELETE FROM tree_operation_jobs WHERE owner_id={literal(owner)};")
    arrivals: set[str] = set()

    def add_arrivals(tick: int) -> None:
        batch = {
            insert_upload(writer, kind, owner, f"arrival_{tick}_{index}")
            for index in range(25)
        }
        writer.run(
            f"UPDATE {kind}_uploads SET expires_at=clock_timestamp() "
            f"WHERE id=ANY({array(sorted(batch))});"
        )
        assert writer.run(
            f"SELECT count(*) FROM {kind}_uploads WHERE id=ANY({array(sorted(batch))}) "
            f"AND expires_at>{literal(first_cutoff)}::timestamptz "
            "AND expires_at<=clock_timestamp();"
        ) == [str(len(batch))]
        arrivals.update(batch)

    # Keep adding a full claim batch before every call. These uploads are due,
    # but belong to a later sweep because their expiry follows the first cutoff.
    add_arrivals(0)
    claimed, cursor, pages = claim_tick(worker, kind, cursor)
    assert len(claimed) == 10 and claimed <= old and pages == 1 and cursor is None
    # Wrapping now makes the 100 uploads skipped while fenced reachable again.
    for tick in range(1, 5):
        add_arrivals(tick)
        batch, cursor, pages = claim_tick(worker, kind, cursor)
        assert len(batch) == 25 and batch <= old and pages == 1
        assert claimed.isdisjoint(batch)
        claimed.update(batch)
    assert claimed == old
    assert writer.run(
        f"SELECT count(*) FROM {kind}_uploads WHERE id=ANY({array(sorted(arrivals))}) "
        "AND expires_at<=now() AND status='pending';"
    ) == [str(len(arrivals))]
    clean_owner(writer, owner)
    print(f"PASS: {kind} sweep cutoff wraps and reclaims all 110 previously fenced uploads despite 25 new arrivals per call", flush=True)


def main() -> int:
    if not CONTAINER.startswith("aeralyth-audit-db-"):
        raise SystemExit("AERALYTH_TEST_CONTAINER must name an isolated aeralyth-audit-db-* container")
    definitions = {
        "owners": (ROOT / "backend/src/upload_completion.rs", "UPLOAD_CLAIM_OWNERS_QUERY"),
    }
    for kind in ("file", "vault"):
        definitions[f"candidate_{kind}"] = (
            ROOT / "backend/src/storage.rs", f"CANDIDATE_EXPIRED_{kind.upper()}_UPLOADS_QUERY"
        )
        definitions[f"claim_{kind}"] = (
            ROOT / "backend/src/storage.rs", f"CLAIM_EXPIRED_{kind.upper()}_UPLOADS_QUERY"
        )
    queries = {key: rust_query(*definition) for key, definition in definitions.items()}
    migrations = {
        path: path.read_text()
        for path in sorted((ROOT / "database/init").glob("[0-9][0-9][0-9]_*.sql"))
    }
    source_hash = hashlib.sha256(json.dumps(queries, sort_keys=True).encode()).hexdigest()
    created = False
    sessions: list[Psql] = []
    try:
        docker("createdb", "-U", "aeralyth", DATABASE)
        created = True
        print(f"Container: {CONTAINER}\nDatabase: {DATABASE}\nWorker SQL SHA256: {source_hash}", flush=True)
        for migration in migrations.values():
            docker(
                "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "aeralyth",
                "-d", DATABASE, input_text=migration,
            )
        print(f"Applied all {len(migrations)} current migration files", flush=True)
        for _ in range(3):
            sessions.append(Psql())
        worker, writer, blocker = sessions
        prepare(worker, queries)
        for kind in ("file", "vault"):
            test_active_fence(worker, writer, kind)
            for lock in ("advisory", "owner_row", "upload_row"):
                test_contention(worker, writer, blocker, kind, lock)
            test_published_between_statements(worker, writer, kind)
            for lock in ("advisory", "upload_row"):
                test_refill(worker, writer, blocker, kind, lock)
            test_continuous_arrivals(worker, writer, kind)
        for name, definition in definitions.items():
            assert rust_query(*definition) == queries[name], f"{name} changed during verification"
        assert set((ROOT / "database/init").glob("[0-9][0-9][0-9]_*.sql")) == set(migrations), (
            "The migration file set changed during verification"
        )
        for path, contents in migrations.items():
            assert path.read_text() == contents, f"{path.name} changed during verification"
        print("PASS: all 16 expired-upload claim scenarios; exact worker SQL and migration sources unchanged", flush=True)
        return 0
    finally:
        for session in sessions:
            session.close()
        if created:
            docker("dropdb", "-U", "aeralyth", "--if-exists", "--force", DATABASE)
            print(f"Cleaned generated audit database {DATABASE}", flush=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.stdout or str(error)) from error
