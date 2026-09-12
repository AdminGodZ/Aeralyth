"""Run every package database test in a separately named audit Compose service.

Start the service and set COMPOSE_FILE, COMPOSE_PROJECT_NAME,
AERALYTH_TEST_CONTAINER and AERALYTH_TEST_DATABASE_PORT first. The script verifies
that Compose resolves to the audit container before any test can write data.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

root = Path(__file__).resolve().parents[2]
os.chdir(root)
container = os.environ.get("AERALYTH_TEST_CONTAINER", "")
project = os.environ.get("COMPOSE_PROJECT_NAME", "")
if not (container.startswith("aeralyth-audit-") and project.startswith("aeralyth-audit-") and os.environ.get("COMPOSE_FILE")):
    raise SystemExit("Explicit isolated audit Compose environment is required")
container_id = subprocess.check_output(["docker", "compose", "ps", "-q", "postgres"], text=True).strip()
actual = subprocess.check_output(["docker", "inspect", "--format", "{{.Name}}", container_id], text=True).strip().lstrip("/")
if actual != container:
    raise SystemExit(f"Compose resolves to unexpected container {actual}")
ports = json.loads(subprocess.check_output(["docker", "inspect", "--format", "{{json .NetworkSettings.Ports}}", container_id], text=True))
bindings = ports.get("5432/tcp") or []
if len(bindings) != 1 or bindings[0]["HostIp"] != "127.0.0.1":
    raise SystemExit("The audit PostgreSQL port must have one loopback-only binding")
os.environ["PG_CONTAINER"] = container
os.environ["AERALYTH_TEST_DATABASE_PORT"] = bindings[0]["HostPort"]

output = root / "performance/results/database-audit-2026-09-12"
output.mkdir(parents=True, exist_ok=True)
results_path = output / "suite-results.json"
results = []
started = time.time()


def record(name, command, log_name=None):
    before = time.monotonic()
    log_path = output / (log_name or name.replace(":", "-") + ".log")
    print(f"RUN {name}", flush=True)
    with log_path.open("w") as log:
        log.write("Command: " + " ".join(command) + "\n")
        log.flush()
        result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=1200)
    row = {"name": name, "exitCode": result.returncode, "durationSeconds": round(time.monotonic()-before, 3), "log": str(log_path.relative_to(root))}
    results.append(row)
    results_path.write_text(json.dumps({"startedAtUnix": started, "container": container, "project": project, "results": results}, indent=2)+"\n")
    print(f"{'PASS' if result.returncode == 0 else 'FAIL'} {name} {row['durationSeconds']}s", flush=True)
    if result.returncode:
        print("\n".join(log_path.read_text().splitlines()[-15:]), flush=True)
    return result.returncode


if "--retry-failed" in sys.argv:
    previous = json.loads(results_path.read_text())
    if previous["container"] != container or previous["project"] != project:
        raise SystemExit("Retry history belongs to a different test environment")
    started = previous["startedAtUnix"]
    results.extend(previous["results"])
    # Retry fixtures must see the corrected source, not the first run's copy.
    subprocess.run(["docker", "cp", "database/init/.", container+":/docker-entrypoint-initdb.d/"], check=True)
    manifest = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(Path("database/init").glob("[0-9][0-9][0-9]_*.sql"))}
    (output / f"migration-source-retry-{len(results)}.json").write_text(json.dumps(manifest, indent=2)+"\n")
    # Direct SQL entries also need fresh current functions when an unpublished
    # migration changed. Replaying its ledger entry would preserve stale code.
    with (output / f"retry-init-{len(results)}.log").open("w") as log:
        subprocess.run(["docker", "exec", container, "dropdb", "-U", "aeralyth", "--if-exists", "--force", "aeralyth"], stdout=log, stderr=subprocess.STDOUT, check=True)
        subprocess.run(["docker", "exec", container, "createdb", "-U", "aeralyth", "aeralyth"], stdout=log, stderr=subprocess.STDOUT, check=True)
        for path in sorted(Path("database/init").glob("[0-9][0-9][0-9]_*.sql")):
            subprocess.run(["docker", "exec", "-i", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "aeralyth", "-d", "aeralyth", "-f", "/docker-entrypoint-initdb.d/"+path.name], stdout=log, stderr=subprocess.STDOUT, check=True)
    latest = {row["name"]: row for row in results}
    scripts = json.loads(Path("package.json").read_text())["scripts"]
    for name in scripts:
        if name.startswith("db:test:") and (name not in latest or latest[name]["exitCode"]):
            attempt = sum(item["name"] == name for item in results)
            record(name, ["npm", "run", name], name.replace(":", "-")+f".retry-{attempt}.log")
    latest = {row["name"]: row for row in results}
    failures = [name for name, row in latest.items() if row["exitCode"]]
    report = json.loads(results_path.read_text())
    report["currentPassed"] = len(latest)-len(failures)
    report["testEntries"] = len(latest)
    results_path.write_text(json.dumps(report, indent=2)+"\n")
    print(f"{len(latest)-len(failures)}/{len(latest)} package database entries passed after targeted retries", flush=True)
    sys.exit(bool(failures))


# Scripts reference the conventional in-container migration path. Copy a coherent
# source snapshot after PostgreSQL has initialized, rather than auto-running it.
subprocess.run(["docker", "cp", "database/init/.", container+":/docker-entrypoint-initdb.d/"], check=True)
manifest = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(Path("database/init").glob("[0-9][0-9][0-9]_*.sql"))}
(output / "migration-source-sha256.json").write_text(json.dumps(manifest, indent=2)+"\n")
with (output / "baseline-init.log").open("w") as log:
    for path in sorted(Path("database/init").glob("[0-9][0-9][0-9]_*.sql")):
        if path.name >= "028_":
            break
        subprocess.run(["docker", "exec", "-i", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "aeralyth", "-d", "aeralyth", "-f", "/docker-entrypoint-initdb.d/"+path.name], stdout=log, stderr=subprocess.STDOUT, check=True)

original = [
    "performance-ledger", "performance-ledger-concurrency", "performance-ledger-fresh", "migration-replay",
    "folder-manifest", "folder-manifest-fresh", "upload-completion-fresh", "session-counter-performance-fresh",
    "vault-query-performance-fresh", "migration-identity-performance-fresh", "navigation-hot-paths-fresh",
    "collection-hierarchy-performance-fresh", "admin-search-identifier-performance-fresh", "bounded-tree-operations-fresh",
    "production-preflight-fresh", "realtime", "flexible-settings",
]
for suffix in original:
    record("db:test:"+suffix, ["npm", "run", "db:test:"+suffix])

# New direct SQL entries use the current schema on the same disposable service.
with (output / "current-init.log").open("w") as log:
    for path in sorted(Path("database/init").glob("[0-9][0-9][0-9]_*.sql")):
        subprocess.run(["docker", "exec", "-i", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "aeralyth", "-d", "aeralyth", "-f", "/docker-entrypoint-initdb.d/"+path.name], stdout=log, stderr=subprocess.STDOUT, check=True)

scripts = json.loads(Path("package.json").read_text())["scripts"]
for name in scripts:
    if name.startswith("db:test:") and name.removeprefix("db:test:") not in original:
        record(name, ["npm", "run", name])

failed = [row["name"] for row in results if row["exitCode"]]
print(f"{len(results)-len(failed)}/{len(results)} package database entries passed", flush=True)
if failed:
    print("Failures: "+", ".join(failed), flush=True)
sys.exit(bool(failed))
