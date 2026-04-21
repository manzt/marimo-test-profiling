# marimo-test-profiling

Profiling marimo's Python test suite from GitHub Actions logs.

```bash
uv run marimo edit notebook.py
```

Parquet under `data/` is checked in. To refresh:

```bash
uv run python fetch.py   # pull new logs via `gh run view --log`
uv run python build.py   # parse logs → parquet
```

`fetch.py` targets the `test_be.yaml::Test coverage` job on `main` —
the only job that runs the full suite without `pytest-changed`
filtering.
