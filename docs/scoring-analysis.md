# Official scoring

The sealed manifest declares 120 checks: Git30, repositories15, issues15, pulls20, GraphQL20, MCP15, protocol5.

`feature = round(600 * passed / 120)`; `agent = round(200 * mcpPassed / 15)`.

Each of four workload scores is `round(clamp(25 - 12.5 * log2(t / Tref), 0, 50))`, where t is the median of three timed rounds after five warmups. Their sum is perf (0..200). Total is feature + agent + perf. Official calibrated reference times (ms): push1640.82, clone266.941, read2759.715, write348.965.

With all checks passing, reaching957 requires157 performance points;970 requires170. A non-MCP check costs5 points, while an MCP miss also loses about13.33 agent points. Full performance credit for one workload requires approximately one quarter of its reference time, subject to rounding. No equal-feature-weight assumption applies to the MCP arm.

The official grade-local runs the sealed scorer and aggregates trial scores into a mean. The process driver is unisolated: measurements are local and cannot establish production sandbox timing. The final uses three newly drawn instances and replay equality; the house prize bar additionally requires a strictly positive90% paired t-interval against its score. Neither local score nor the user's957 gate guarantees a prize.

No score has been earned by the candidate yet. Unmodified starter baseline: official process-driver mean15 across three trials; all replays matched. Docker is unavailable on this host, so exact Linux isolation is unverified.
