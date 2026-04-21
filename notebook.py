import marimo

__generated_with = "0.23.2"
app = marimo.App()


@app.cell(hide_code=True)
def _():
    import marimo as mo

    mo.md(
        """
    # marimo test suite — profiling

    Visualizes per-test and per-file timings across recent
    `test_be.yaml::Test coverage` runs on `main`.

    Data is built from raw GitHub Actions logs by `build.py` — see
    `data/runs.parquet` and `data/per_test.parquet`. Refresh with
    `uv run python fetch.py && uv run python build.py`.
    """
    )
    return (mo,)


@app.cell(hide_code=True)
def _(Tree, per_test):
    Tree(
        leaves=[
            {"path": row["file"] + "::" + row["name"], "value": row["median_s"]}
            for row in per_test.iter_rows(named=True)
            if row["median_s"] > 0
        ]
    )
    return


@app.cell(hide_code=True)
def _():
    from datetime import datetime
    from pathlib import Path

    import altair as alt
    import polars as pl

    DATA = Path(__file__).parent / "data"
    CUTOFF = datetime(2026, 4, 6)

    runs = pl.read_parquet(DATA / "runs.parquet").sort("started")
    per_test = pl.read_parquet(DATA / "per_test.parquet")
    return CUTOFF, Path, alt, per_test, pl, runs


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Run-to-run wall clock
    """)
    return


@app.cell(hide_code=True)
def _(CUTOFF, alt, pl, runs):
    _runs = runs.with_columns(
        pl.when(pl.col("started") >= CUTOFF)
        .then(pl.lit("post 2026-04-06"))
        .otherwise(pl.lit("pre 2026-04-06"))
        .alias("regime")
    ).with_columns(
        pl.col("total_s").median().over("regime").alias("regime_median_s")
    )

    _bars = (
        alt.Chart(_runs)
        .mark_bar()
        .encode(
            x=alt.X("started:T", title="Run start (UTC)"),
            y=alt.Y("total_s:Q", title="pytest wall-clock (s)"),
            color=alt.Color(
                "regime:N",
                scale=alt.Scale(
                    domain=["pre 2026-04-06", "post 2026-04-06"],
                    range=["#b0b0b0", "#4c78a8"],
                ),
                legend=alt.Legend(title=None, orient="top"),
            ),
            tooltip=[
                "run_id",
                alt.Tooltip("total_s:Q", format=".1f"),
                "n_tests",
                "regime",
            ],
        )
        .properties(height=240)
    )

    _medians = (
        alt.Chart(_runs)
        .mark_rule(strokeDash=[4, 4], size=1.5)
        .encode(
            x="min(started):T",
            x2="max(started):T",
            y="regime_median_s:Q",
            color=alt.Color("regime:N", legend=None),
            detail="regime:N",
        )
    )

    _bars + _medians
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Time distribution — where does the 722s go?
    """)
    return


@app.cell(hide_code=True)
def _(per_test, pl):
    BUCKETS = [
        (0.0, 0.010, "<10ms"),
        (0.010, 0.050, "10-50ms"),
        (0.050, 0.100, "50-100ms"),
        (0.100, 0.250, "100-250ms"),
        (0.250, 0.500, "250-500ms"),
        (0.500, 1.0, "500ms-1s"),
        (1.0, 2.0, "1-2s"),
        (2.0, 5.0, "2-5s"),
        (5.0, 1e9, "≥5s"),
    ]
    BUCKET_ORDER = [b[2] for b in BUCKETS]

    _expr = pl.when(pl.col("median_s") < BUCKETS[0][1]).then(pl.lit(BUCKETS[0][2]))
    for _lo, _hi, _label in BUCKETS[1:]:
        _expr = _expr.when(pl.col("median_s") < _hi).then(pl.lit(_label))
    _expr = _expr.otherwise(pl.lit(BUCKETS[-1][2]))

    bucketed = per_test.with_columns(_expr.alias("bucket"))
    return BUCKET_ORDER, bucketed


@app.cell(hide_code=True)
def _(BUCKET_ORDER, alt, bucketed, pl):
    _summary = (
        bucketed.group_by("bucket")
        .agg(
            pl.col("median_s").sum().alias("total_s"),
            pl.col("median_s").len().alias("n"),
        )
        .with_columns(
            (pl.col("total_s") / pl.col("total_s").sum() * 100).alias("pct_time"),
        )
    )

    _time_chart = (
        alt.Chart(_summary)
        .mark_bar()
        .encode(
            y=alt.Y("bucket:N", sort=BUCKET_ORDER, title=None),
            x=alt.X("total_s:Q", title="sum of median durations (s)"),
            color=alt.Color(
                "bucket:N",
                sort=BUCKET_ORDER,
                legend=None,
                scale=alt.Scale(scheme="viridis"),
            ),
            tooltip=[
                "bucket",
                "n",
                alt.Tooltip("total_s:Q", format=".1f"),
                alt.Tooltip("pct_time:Q", format=".1f"),
            ],
        )
        .properties(title="Time share by duration bucket", height=260)
    )
    _count_chart = (
        alt.Chart(_summary)
        .mark_bar(color="#8ca")
        .encode(
            y=alt.Y("bucket:N", sort=BUCKET_ORDER, title=None),
            x=alt.X("n:Q", title="tests in bucket"),
            tooltip=["bucket", "n"],
        )
        .properties(title="Tests per bucket", height=260)
    )
    _time_chart | _count_chart
    return


@app.cell(hide_code=True)
def _(alt, per_test, pl):
    _sorted = per_test.sort("median_s").with_columns(
        (pl.col("median_s").cum_sum() / pl.col("median_s").sum() * 100).alias(
            "cum_pct"
        ),
        (pl.int_range(0, pl.len()) / (pl.len() - 1) * 100).alias("rank_pct"),
    )
    _cdf = (
        alt.Chart(_sorted)
        .mark_line()
        .encode(
            x=alt.X(
                "rank_pct:Q",
                title="percentile of tests (fastest → slowest)",
            ),
            y=alt.Y("cum_pct:Q", title="cumulative % of total runtime"),
        )
        .properties(title="CDF — runtime concentration", height=240)
    )
    _diag = (
        alt.Chart(pl.DataFrame({"x": [0, 100], "y": [0, 100]}))
        .mark_line(color="#ccc", strokeDash=[4, 4])
        .encode(x="x:Q", y="y:Q")
    )
    _cdf + _diag
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Top files — where to look first
    """)
    return


@app.cell(hide_code=True)
def _(mo):
    top_n = mo.ui.slider(start=10, stop=40, value=20, label="top N files")
    top_n
    return (top_n,)


@app.cell(hide_code=True)
def _(alt, per_test, pl, top_n):
    _by_file = (
        per_test.group_by("file")
        .agg(
            pl.col("median_s").sum().alias("total_s"),
            pl.col("median_s").len().alias("n_tests"),
        )
        .sort("total_s", descending=True)
        .head(top_n.value)
        .with_columns((pl.col("total_s") / pl.col("n_tests")).alias("avg_s"))
    )
    (
        alt.Chart(_by_file)
        .mark_bar()
        .encode(
            y=alt.Y("file:N", sort="-x", title=None),
            x=alt.X("total_s:Q", title="sum of median durations (s)"),
            color=alt.Color(
                "avg_s:Q",
                title="avg per test (s)",
                scale=alt.Scale(scheme="plasma"),
            ),
            tooltip=[
                "file",
                alt.Tooltip("total_s:Q", format=".2f"),
                "n_tests",
                alt.Tooltip("avg_s:Q", format=".3f"),
            ],
        )
        .properties(height=alt.Step(18))
    )
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Variance — likely flaky / contended tests
    """)
    return


@app.cell(hide_code=True)
def _(alt, per_test, pl):
    _variable = (
        per_test.filter((pl.col("n") >= 5) & (pl.col("mean_s") >= 0.1))
        .with_columns((pl.col("std_s") / pl.col("mean_s")).alias("cv"))
        .with_columns((pl.col("file") + "::" + pl.col("name")).alias("label"))
        .sort("cv", descending=True)
        .head(80)
    )
    (
        alt.Chart(_variable)
        .mark_circle(size=60, opacity=0.75)
        .encode(
            x=alt.X(
                "mean_s:Q",
                scale=alt.Scale(type="log"),
                title="mean duration (s, log)",
            ),
            y=alt.Y("cv:Q", title="coefficient of variation (stdev / mean)"),
            color=alt.Color("cv:Q", scale=alt.Scale(scheme="reds"), legend=None),
            size=alt.Size(
                "mean_s:Q",
                scale=alt.Scale(range=[40, 400]),
                legend=None,
            ),
            tooltip=[
                "label",
                alt.Tooltip("mean_s:Q", format=".2f"),
                alt.Tooltip("std_s:Q", format=".2f"),
                alt.Tooltip("cv:Q", format=".2f"),
                "n",
            ],
        )
        .properties(height=320)
    )
    return


@app.cell
def _():
    return


@app.cell(hide_code=True)
def _(mo):
    mo.md("""
    ## Tree explorer — per-test drilldown
    """)
    return


@app.cell(hide_code=True)
def _(per_test):
    def build_tree(df):
        """Group per-test rows into a nested dict for d3.hierarchy."""
        root = {"name": "tests", "children": {}}
        for row in df.iter_rows(named=True):
            parts = row["file"].split("/")[1:]  # drop leading "tests"
            parts.append(row["name"])
            node = root
            for i, part in enumerate(parts):
                kids = node.setdefault("children", {})
                if part not in kids:
                    is_leaf = i == len(parts) - 1
                    kids[part] = (
                        {"name": part, "value": row["median_s"]}
                        if is_leaf
                        else {"name": part, "children": {}}
                    )
                node = kids[part]

        def finalize(n):
            if "children" in n:
                n["children"] = [finalize(c) for c in n["children"].values()]
            return n

        return finalize(root)


    tree_data = build_tree(per_test)
    len(tree_data["children"]), sum(1 for _ in per_test.iter_rows())
    return


@app.cell(hide_code=True)
def _(Path):
    import anywidget
    import traitlets


    class Tree(anywidget.AnyWidget):
        _esm = Path(__file__).parent / "widgets" / "treemap.js"
        leaves = traitlets.List().tag(sync=True)

    return (Tree,)


@app.cell
def _():
    return


if __name__ == "__main__":
    app.run()
