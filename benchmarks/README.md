# Reproduce the benchmark

Use the official competition kit and Node 22. Start a Docker daemon, then run the sealed grader against a committed snapshot:

```sh
node "$KIT/cli/makefun.mjs" grade-local --kit "$KIT" --bot "$FORGE" \
  --commit "$SHA" --driver docker --instances 3 --save "$RESULTS" --json
```

The kit runs each of the three practice instances live and in replay. Use a fresh output directory for every run. Run baseline and candidate in alternating order on an otherwise idle host. Look at `trial-*/state/perf.json` for timings and `trial-*/stderr.txt` for entry runtime, CPU, peak RSS and sampled event-loop delay. State files exclude timing data. Compare those files byte for byte and check the grader's replay verdict.

Each workload runs three timed rounds after five warm-ups. The official p50 and p99 describe **complete workload rounds**. Divide the operation count by a round's duration for throughput. The suite exposes no per-operation latency distribution or separately scored cold run. Every trial starts a fresh process. The setup and warm-ups are part of the kit, and its score uses warmed rounds.

See [the optimization log](../docs/optimization-log.md) for the paired measurements.
