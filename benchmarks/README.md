# Reproduce the benchmark

Use the official competition kit and Node 22. Start a Docker daemon, then run the sealed grader against a committed snapshot:

```sh
node "$KIT/cli/makefun.mjs" grade-local --kit "$KIT" --bot "$FORGE" \
  --commit "$SHA" --driver docker --instances 3 --save "$RESULTS" --json
```

The kit runs each of the three practice instances live and in replay. Use a fresh output directory for every run. Run baseline and candidate in alternating order on an otherwise idle host. Look at `trial-*/state/perf.json` for timings and `trial-*/stderr.txt` for entry runtime, CPU, peak RSS and sampled event-loop delay. State files exclude timing data. Compare those files byte for byte and check the grader's replay verdict.

Each workload runs three timed rounds after five warm-ups. The official p50 and p99 describe **complete workload rounds**. Divide the operation count by a round's duration for throughput. The suite exposes no per-operation latency distribution or separately scored cold run. Every trial starts a fresh process. The setup and warm-ups are part of the kit, and its score uses warmed rounds.

See [the optimization log](../docs/optimization-log.md) for the paired measurements.

For longer comparisons, export the baseline commit to a separate directory and run:

```sh
node benchmarks/compare.mjs compare "$KIT" "$BASELINE" "$CANDIDATE" "$RESULTS.json"
```

This runner calls the kit's unmodified benchmark module in a separate client container. Both client and entry use the pinned Node image, 2 CPUs, 1 GiB RAM, UID 65534, read-only mounts and an internal Docker network. It uses the official inputs, five warm-ups and workload concurrency, with ten measured rounds per workload in each fresh process. Four blocks run in ABBA order, giving twenty measured rounds per workload per version. The JSON holds all rounds, nearest-rank median and p95, throughput, failure assertions, entry CPU and peak RSS. A mismatched final store checksum or a failed workload aborts the comparison. This extended benchmark does not replace the official grader's conformance and live/replay checks.

Set `DOCKER_HOST` and `DOCKER_CONFIG` for the intended Docker runtime. Source and kit paths must be visible inside its VM. Host contention can change wall times substantially; record it and compare paired runs rather than treating measurements from different days as equivalent.
