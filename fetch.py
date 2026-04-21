"""Fetch Test-coverage job logs from marimo CI on main.

Only the coverage job on main runs the full suite single-process with
test-optional deps, so it's our reference workload. Other jobs are
filtered by pytest-changed on PRs and don't represent the whole suite.

Usage:
  uv run python fetch.py                  # fetch all missing
  uv run python fetch.py --limit 200      # scan N recent runs
  uv run python fetch.py --repo foo/bar   # other repo
"""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

LOG_DIR = Path(__file__).parent / "data" / "logs"
WORKFLOW = "test_be.yaml"
JOB_NAME = "Test coverage"


def _gh(*args: str) -> str:
    result = subprocess.run(
        ["gh", *args], capture_output=True, text=True, check=True
    )
    return result.stdout


def list_successful_main_runs(repo: str, limit: int) -> list[str]:
    out = _gh(
        "run",
        "list",
        "--repo",
        repo,
        "--workflow",
        WORKFLOW,
        "--branch",
        "main",
        "--limit",
        str(limit),
        "--json",
        "databaseId,conclusion,event",
        "--jq",
        '.[] | select(.conclusion == "success" and .event == "push") '
        "| .databaseId",
    )
    return [line for line in out.splitlines() if line.strip()]


def coverage_job_id(run_id: str, repo: str) -> str | None:
    out = _gh(
        "run",
        "view",
        run_id,
        "--repo",
        repo,
        "--json",
        "jobs",
    )
    jobs = json.loads(out).get("jobs", [])
    for job in jobs:
        if job.get("name") == JOB_NAME and job.get("conclusion") == "success":
            return str(job["databaseId"])
    return None


def fetch_log(job_id: str, run_id: str, repo: str) -> Path:
    target = LOG_DIR / f"coverage_{run_id}.log.gz"
    if target.exists():
        return target
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    raw = _gh("run", "view", "--job", job_id, "--repo", repo, "--log")
    with gzip.open(target, "wt") as fh:
        fh.write(raw)
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default="marimo-team/marimo")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    if shutil.which("gh") is None:
        raise SystemExit("gh CLI is required on PATH")

    run_ids = list_successful_main_runs(args.repo, args.limit)
    print(f"scanning {len(run_ids)} successful main runs")

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        pairs = [
            (rid, job_id)
            for rid, job_id in zip(
                run_ids,
                ex.map(lambda r: coverage_job_id(r, args.repo), run_ids),
            )
            if job_id is not None
        ]
    print(f"{len(pairs)} runs have a completed Test coverage job")

    missing = [
        (rid, jid)
        for rid, jid in pairs
        if not (LOG_DIR / f"coverage_{rid}.log.gz").exists()
    ]
    print(f"{len(missing)} logs to download")

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        for p in ex.map(
            lambda pair: fetch_log(pair[1], pair[0], args.repo), missing
        ):
            print(f"  wrote {p.name}")


if __name__ == "__main__":
    main()
