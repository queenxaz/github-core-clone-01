[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/queenxaz/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/queenxaz/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# makefun-forge — a GitHub-compatible git forge in one Node process

An entry for the [github-core-clone-01](https://make.fun/bounty/github-core-clone-01)
bounty: a standalone, GitHub-compatible git forge as a single Node 22 process,
serving four surfaces from its own in-memory store, with **no git binary** and
no dependencies beyond the Node standard library.

- **Git smart HTTP v2** — `info/refs` (v0 + v2, both services), `git-upload-pack`
  (`ls-refs`, `fetch` with shallow/deepen, sideband packfiles), `git-receive-pack`
  (v0, `report-status`, side-band-64k, non-fast-forward refusals, mixed reports).
  Full pack v2 codec: OFS/REF deltas, thin-pack bases, annotated tags, peeled refs.
- **REST v3 API** — repositories, branches, commits, git refs, labels, contents
  (create/update/delete with sha-409 conflict handling), issues (labels, sorting,
  pagination), comments, pull requests (files, squash merge with conflict
  detection), `X-GitHub-Request-Id` on every reply.
- **GraphQL** — hand-written parser/executor (variables, aliases, fragments,
  batched operations, introspection), repository/issue/pull-request queries and
  mutations, cursor pagination.
- **MCP** — `server/discover`, `initialize`, `tools/list`, `tools/call` for six
  tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`), JSON-RPC errors.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own; the flag is harmless there and makes an older local
Node work too. There is nothing to install: the program imports `node:http`,
`node:crypto` and its own modules only, and the trial has no package manager
and no internet.

## The lifecycle (main.ts)

On start the entry binds an ephemeral port, POSTs `{"port": N}` to
`$MAKEFUN_ENV_URL/register`, then long-polls `$MAKEFUN_ENV_URL/done` until the
environment reports the trial is over and exits 0. It never binds 8080.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | Entrypoint: lifecycle (register, poll `/done`), HTTP server. |
| `app.ts` | Routing, auth (Bearer token), body limits, request-id header. |
| `git.ts` | Object store (SHA-1 blobs/trees/commits/tags), pack v2 build/parse. |
| `pkt.ts` | pkt-line encode/decode, flush/delim, sideband framing. |
| `gitproto.ts` | Smart-HTTP protocol: advertisements, ls-refs, fetch, receive-pack. |
| `store.ts` | The forge store: repos, issues, PRs, labels, trees, squash merge. |
| `rest.ts` | REST v3 routes. |
| `graphql.ts` | GraphQL parser + executor + HTTP handler. |
| `mcp.ts` | MCP endpoint + six tools. |

## Determinism

All timestamps are a fixed epoch (`2025-01-01T00:00:00Z`); ordering uses
monotonic creation counters, never the wall clock; global IDs are stable
opaque hashes. State export is byte-identical across live and replay runs.

## Practice results (local, kit's sealed conformance suite)

- Starter baseline: **15/1000** (3/120 checks).
- This build: **120/120 checks, 200/200 agent points**, perf **169–190/200**
  across repeated local runs; best total **990/1000**, full end-to-end trial
  through the real env server **983/1000**. The house reference forge scores
  ~900 (120/120 + ~100 perf at its calibrated medians), so this entry beats it
  on feature parity and on speed (push ~0.4×, clone ~0.4×, read ~0.2×,
  write ~0.3× the reference medians).

## License

MIT — see `LICENSE`.
