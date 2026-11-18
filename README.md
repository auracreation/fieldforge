# Fieldforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/auracreation/fieldforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/auracreation/fieldforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone Git forge using Node22 built-ins. One process serves Git smart HTTP, GitHub-compatible REST, a GraphQL subset and MCP tools over the same in-memory store. No UI, Git executable, runtime packages or external service.

## Run

Use Node22.18 or later in the22 release line. Install nothing.

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=your-token node main.ts
```

The official suite must be running at MAKEFUN_ENV_URL. The forge binds an ephemeral port, POSTs its port to `/register`, answers `/healthz`, polls `/done` and exits0 after completion. It never binds8080. Source can be mounted read-only; repository data is ephemeral memory.

For embedding or local clients, import `createApp` from `app.ts`, pass `{token, store}` as needed, call `listen(0)` and read the chosen port. Every API/Git/MCP request requires `Authorization: Bearer <token>`; health is unauthenticated. Set `FORGE_USER` to configure the single user's namespace. Without it, the first request addressing an existing repository establishes the namespace; failed missing-repository lookups do not change identity.

```sh
node --test tests/*.test.ts
```

## Shared architecture

- `src/git`: canonical SHA-1 objects, trees and commits; checksummed packs; both delta encodings; pkt-lines; receive-pack and v2 upload-pack; incremental and shallow reachability.
- `src/storage`: repository/ref/object maps, numbered issues and state indexes, comments, pull requests, deterministic export and shared writes.
- `src/api`: REST repositories, contents, branches, commits, issues, comments, labels, pulls, files and squash merges.
- `src/graphql`: tokenizer, recursive parser, schema prevalidation and selection evaluation. Variables, aliases, named/inline fragments, include/skip directives, cursor connections and mutations.
- `src/mcp`: streamable HTTP JSON-RPC discovery/initialization and repository, issue, pull and file tools using the same operations.

[Requirements matrix](docs/requirements-matrix.md) lists every published conformance check. [Scoring analysis](docs/scoring-analysis.md) records the official formula. [Optimization log](docs/optimization-log.md) distinguishes measured results from hypotheses. Runtime, CPU, peak RSS and event-loop delay are emitted on stderr; timing never enters state exports.

## Scope and bounds

The supported surface is the competition's published GitHub contract, not the entire GitHub product. The explicit GraphQL schema has no subscriptions. Pull merges use squash semantics. Pack objects are limited to32MiB, with128MiB aggregate inflated and expanded data per incoming pack. HTTP bodies are limited to64MiB. Text diffs return422 if more than one million frontier steps are needed. No database or durable persistence is required by this ephemeral trial.

## License

MIT. The startup lifecycle is adapted from the competition's MIT starter. The forge implementation and independent regression tests were written for this entry; no other contestant's implementation was used.

---

<sub>Built for [make.fun](https://make.fun/?ref=z1j4n66g&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
