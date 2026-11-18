# Forge design

Build one Node 22 process over a shared in-memory repository store. REST, GraphQL and MCP call the same store operations; smart HTTP updates the same refs and canonical Git objects. No runtime dependencies, subprocesses, source writes, clocks in persisted data, or outside services.

Use built-in HTTP, crypto and zlib. Native Node 22 type stripping runs root main.ts. Bind port zero and follow the official starter lifecycle unchanged. Objects are deduplicated within repositories; issue numbers have direct Map lookup. Mutations finish synchronously after the request body is read. Stable identifiers derive from resource type and local numeric identifiers. State export sorts resource keys and excludes transport URLs and caches.

Git uses canonical object hashing, validated pack checksums, bounded inflation, iterative delta resolution, v0 receive-pack and v2 upload-pack. Generate plain packs and cache only immutable object compression with bounded entries. Reachability respects shallow boundaries.

REST implements the published contract. GraphQL has a tokenizer and recursive parser with aliases, variables, fragments and selection evaluation. MCP uses streamable HTTP JSON-RPC and delegates to shared operations.

Alternatives considered: vendoring a complete forge would violate the purpose and process constraints; four separate adapters with their own data would violate consistency. A shared store with thin adapters is the smallest complete approach.

The user has explicitly authorized autonomous implementation, review and optimization. Submission remains prohibited unless the official comparable mean is >=957 with validity confirmed; target >=970. A local process-driver score is not proof of Linux sandbox resource compliance.
