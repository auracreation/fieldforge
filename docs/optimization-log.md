# Optimization log

| Revision | Hypothesis | Correctness | Official mean | Performance | Memory | Decision |
|---|---|---|---|---|---|---|
| official starter worktree | Establish unchanged baseline |3/120 checks; replay matched3/3 |15 (process driver) |0 points; workloads unsupported |Not recorded |Freeze as baseline in work/baseline |
| bfe2342 | Freeze the reviewed correctness baseline | 120/120 on each of three practice trials and byte-identical replay exports in both runs | 996.333333 in both official Docker runs | Push 489.159 ms median across six trial medians | Peak 149,032 KiB | Retain for comparisons |
| 209c4e2 | Replace the full object-map copy with a staged overlay and skip validation of already validated immutable objects | 120/120 on all trials in both runs. Independent Git checks and a regression for rejected pushes passed | 999.666667 and 998.666667, official Docker driver | Push 213.627 ms median across six trial medians, about 56% lower | Peak 152,476 KiB | Promote. Both paired runs improved score and every paired trial improved push time |

Changed production files for the optimization are `src/git/objects.ts`, `src/git/http.ts` and `src/api/rest.ts`. The cache holds at most 8,192 validated object IDs per repository and promotes entries only after a ref update succeeds. The regression is in `tests/git.test.ts`.

The other workloads were already near their score caps. Timing differences there varied between trial pairs, so no improvement is attributed to the push change.
