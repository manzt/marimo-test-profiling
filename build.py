"""Parse gzipped GH Actions coverage logs into parquet files.

Produces:
  data/runs.parquet        — one row per run (total wall-clock, start,
                             test count)
  data/per_test.parquet    — one row per (file, name) with median /
                             mean / stdev / n across runs

Run this after `fetch.py` adds new logs. The notebook reads these two
parquet files directly, so parse/aggregate work doesn't live in the
notebook.

Usage:
  uv run python build.py
"""

from __future__ import annotations

import gzip
import re
from datetime import datetime
from pathlib import Path

import polars as pl

LOG_DIR = Path(__file__).parent / "data" / "logs"
OUT_DIR = Path(__file__).parent / "data"

TS_RE = re.compile(r"^Test coverage\s+UNKNOWN STEP\s+(\S+Z)\s+(.*)$")
TEST_RE = re.compile(
    r"^(tests/\S+?\.py)::(\S+)\s+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)"
)
TOTAL_RE = re.compile(r"in (\d+(?:\.\d+)?)s \(0:\d+:\d+\)")


def _parse_ts(s: str) -> float:
    s = s.lstrip("\ufeff")
    head, _, tail = s.partition(".")
    return datetime.strptime(
        f"{head}.{tail.rstrip('Z')[:6]}Z", "%Y-%m-%dT%H:%M:%S.%fZ"
    ).timestamp()


def parse_log(path: Path) -> tuple[list[dict], float, datetime]:
    rows: list[dict] = []
    total = 0.0
    first_ts: float | None = None
    prev: float | None = None

    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt") as fh:
        for line in fh:
            m = TS_RE.match(line)
            if not m:
                continue
            ts_s, payload = m.groups()
            ts = _parse_ts(ts_s)
            if first_ts is None:
                first_ts = ts
            if (tm := TEST_RE.match(payload)) is not None:
                fpath, name, outcome = tm.groups()
                if prev is not None:
                    dt = ts - prev
                    # clamp absurd gaps from log interruptions
                    if 0 <= dt < 300:
                        rows.append(
                            {
                                "file": fpath,
                                "name": name,
                                "outcome": outcome,
                                "duration_s": dt,
                            }
                        )
                prev = ts
            if tot := TOTAL_RE.search(payload):
                total = float(tot.group(1))
    started = datetime.fromtimestamp(first_ts) if first_ts else datetime.min
    return rows, total, started


def main() -> None:
    logs = sorted(LOG_DIR.glob("coverage_*.log*"))
    if not logs:
        raise SystemExit(f"no logs found in {LOG_DIR}; run fetch.py first")

    all_rows: list[dict] = []
    runs: list[dict] = []
    for path in logs:
        rid = path.stem.replace("coverage_", "").removesuffix(".log")
        rows, total, started = parse_log(path)
        for r in rows:
            r["run_id"] = rid
            r["started"] = started
            all_rows.append(r)
        runs.append(
            {
                "run_id": rid,
                "total_s": total,
                "started": started,
                "n_tests": len(rows),
            }
        )
        print(f"  {rid}: {total:.1f}s, {len(rows)} tests")

    runs_df = pl.DataFrame(runs).sort("started")
    tests_df = pl.DataFrame(all_rows)

    # per-test aggregation across runs (≥3 runs to filter noise)
    per_test_df = (
        tests_df.group_by(["file", "name"])
        .agg(
            pl.col("duration_s").median().alias("median_s"),
            pl.col("duration_s").mean().alias("mean_s"),
            pl.col("duration_s").std().alias("std_s"),
            pl.col("duration_s").len().alias("n"),
        )
        .filter(pl.col("n") >= 3)
    )

    runs_df.write_parquet(OUT_DIR / "runs.parquet")
    per_test_df.write_parquet(OUT_DIR / "per_test.parquet")
    tests_df.write_parquet(OUT_DIR / "tests.parquet", compression="zstd")

    print(f"\nruns: {runs_df.height}")
    print(f"per_test: {per_test_df.height}")
    print(f"tests: {tests_df.height} (raw per-run observations)")


if __name__ == "__main__":
    main()
