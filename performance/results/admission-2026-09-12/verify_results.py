"""Recompute the admission report from every retained raw sample."""

import hashlib
import json
import math
import sys
from collections import Counter
from pathlib import Path


def distribution(values):
    values = sorted(values)
    result = {"samples": len(values), "max_ms": values[-1] if values else 0}
    for percentile in (50, 95, 99):
        result[f"p{percentile}_ms"] = (
            values[math.ceil(len(values) * percentile / 100) - 1] if values else 0
        )
    return result


def summarize(rows):
    successful = [row for row in rows if row["status"] == 200]
    phase = [row for row in rows if row["started_during_provider"]]
    rejected = sum(row["status"] in (429, 503) for row in rows)
    return {
        "offered": len(rows),
        "successful": len(successful),
        "rejected": rejected,
        "other_failures": len(rows) - len(successful) - rejected,
        "provider_window_offered": len(phase),
        "provider_window_successful": sum(row["status"] == 200 for row in phase),
        "provider_window_rejected": sum(row["status"] in (429, 503) for row in phase),
        "status_counts": dict(Counter(str(row["status"]) for row in rows)),
        "successful_handler": distribution(row["handler_ms"] for row in successful),
        "successful_scheduled_to_complete": distribution(
            row["scheduled_to_complete_ms"] for row in successful
        ),
        "successful_started_during_provider": distribution(
            row["handler_ms"] for row in successful if row["started_during_provider"]
        ),
        "arrival_lag": distribution(row["arrival_lag_ms"] for row in rows),
    }


report_path = Path(sys.argv[1])
report = json.loads(report_path.read_text())
cohorts = ("same_user", "other_user")
for run in report["runs"]:
    assert len(run["samples"]) == 2 * report["samples_per_cohort_per_run"]
    for cohort in cohorts:
        rows = [row for row in run["samples"] if row["cohort"] == cohort]
        assert len(rows) == report["samples_per_cohort_per_run"]
        assert summarize(rows) == run[cohort], (run["profile"], run["repeat"], cohort)

summary = []
for interval in report["arrival_intervals_ms_per_cohort"]:
    for profile in ("shared_gate_counterfactual", "partitioned"):
        runs = [
            run
            for run in report["runs"]
            if run["arrival_interval_ms_per_cohort"] == interval
            and run["profile"] == profile
        ]
        assert len(runs) == report["repeats"]
        entry = {
            "offered_requests_per_second": 2000 / interval,
            "profile": profile,
            "bulk_completed_per_run": [run["bulk_completed"] for run in runs],
            "bulk_completed_during_provider_per_run": [
                run["bulk_completed_during_provider"] for run in runs
            ],
        }
        for cohort in cohorts:
            entry[cohort] = summarize(
                [row for run in runs for row in run["samples"] if row["cohort"] == cohort]
            )
        summary.append(entry)

print(
    json.dumps(
        {
            "raw_report_sha256": hashlib.sha256(report_path.read_bytes()).hexdigest(),
            "verified_samples": sum(len(run["samples"]) for run in report["runs"]),
            "groups": summary,
        },
        indent=2,
    )
)
