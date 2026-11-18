# Forge implementation plan

**Goal:** a standalone GitHub-compatible forge passing every published check, with measured official score >=957 before any submission.
**Spec:** design.md and the user's complete mission.
**Stack:** Node 22, built-in modules only.

1. Discover the entire official skill, requirements, kit sources, practice instances and scoring; verify Node22. Preserve an unchanged starter grade as the failing baseline.
2. Implement canonical objects and packs, pkt-lines, upload/receive HTTP. Repository shape: `{objects: Map<sha,{type,data}>, refs: Map<ref,sha>, default_branch:'main'}`. Git handler consumes repository and request and returns `{status,headers,body}`. Cover roundtrips, shallow/deepen, deletion, rejection and malformed inputs.
3. Implement shared storage operations, indexed issues, canonical file/tree/commit creation, PR diff and merge. REST routes consume and mutate those objects. Cover validation and cross-protocol reads.
4. Implement GraphQL parser/evaluator and MCP adapters. Test aliases, fragments, variables, cursor pagination, errors and actual writes visible through REST.
5. Run independent tests, official conformance and all three practice instances twice via grade-local. Compare byte-identical state, score components and workload medians. Preserve committed known-good baselines.
6. Review Git; API compatibility; performance, memory, concurrency and determinism; packaging and transcripts independently. Reproduce and fix confirmed defects with regression tests.
7. Optimize the largest measured deficit with paired full runs, record promotion decisions. Verify committed snapshot and all gates. Create owned public MIT repository and submit only if every gate passes.

Review focus: malformed binary lengths and delta cycles; non-fast-forward and stale updates; nested file conflicts; parser and body size limits; identifiers and export ordering under concurrent writes.
