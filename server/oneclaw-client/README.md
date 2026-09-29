# @verdict/oneclaw-client

A thin, hand-rolled client for [1Claw](https://1claw.co)'s Vaults/Agents Human API
(`api.1claw.co`) — the same shape as `@verdict/imd-client`: no SDK dependency, just `fetch`
and the documented request/response shapes, typed.

This is the "vault side" from `docs/SPEC.md`'s 1Claw integration table: hold IMD paid
tokens, GitHub tokens, and LLM keys in a 1Claw vault instead of raw environment variables,
and let an agent (the resolver) fetch only what its policy grants, never seeing secrets it
doesn't need.

## What's confirmed vs. what's docs-only

**Domain correction worth remembering**: the real platform is `1claw.co`, not `1claw.ai`
(an unrelated Chinese self-hosted-agent product). See `docs/DAY-ONE-FINDINGS.md` §7.

Every endpoint and shape in `src/types.ts`/`src/client.ts` comes from reading
`docs.1claw.co` directly (Quickstart for humans, the golden path guide, and the Human API
overview — all read 2026-09-29), not from memory or guessing.

**Live-run status**: `scripts/live-smoke.ts` passes end to end against the real
`api.1claw.co` (2026-09-29, using a fresh `ONE_CLAW_API_KEY` from `~/.secrets/verdict.env`
— the first key tried, in `~/.secrets/1claw.env`, was stale/revoked; see
`docs/DAY-ONE-FINDINGS.md` §8). Getting the agent-scoped fetch step to actually work
surfaced two real gaps between `docs.1claw.co`'s own reference page for `POST /v1/agents`
and its live behavior — **`vault_ids` is required in practice despite being undocumented
there, and passing `scopes` explicitly (as that same page's own example does) breaks
policy-derived access** — both written up in `docs/DAY-ONE-FINDINGS.md` §9 and baked into
`OneClawClient.createAgent()`'s doc comment in `src/client.ts`. The vault side is now
genuinely live-verified, not just typechecked against docs prose.

It creates real resources in the caller's real 1Claw org — a vault and an agent, both
counted against the free tier's limits (3 vaults, 2 agents) — so it's deliberately not run
automatically by this package, CI, or any other script. It cleans up after itself (even on
a failure partway through) unless `--keep` is passed. Run it yourself:

```
ONE_CLAW_API_KEY=$(grep -oP '(?<=^ONE_CLAW_API_KEY=).*' ~/.secrets/verdict.env) npm run live-smoke
```

## What this does NOT do

This package only covers the **vault side**: secrets, agents, and policies. It
deliberately does not implement 1Claw's **Intents API** (on-chain/typed-data signing) —
that's the half of the project's IMD-payment blocker that was investigated and parked (see
`docs/DAY-ONE-FINDINGS.md` §7): 1Claw's signer is generic and doesn't know IMD's
`quoteApprovalTypedData` schema, so wiring it up would still mean guessing at that schema,
which this project's whole history has been careful not to do.

## Auth

1Claw has two key types, both usable directly with `OneClawClient`:

- **Human personal API key** (`1ck_...`) — full org access: create vaults, agents,
  policies. Exchanged for a JWT via `POST /v1/auth/api-key-token`.
- **Agent API key** (`ocv_...`, paired with an `agentId`) — scoped to whatever a policy
  grants that agent. Exchanged via `POST /v1/auth/agent-token`.

```ts
import { OneClawClient } from "@verdict/oneclaw-client";

const human = new OneClawClient({ apiKey: process.env.ONE_CLAW_API_KEY! });
const agent = new OneClawClient({ agentId, agentApiKey });
```

The client caches the exchanged JWT and re-exchanges it 15 seconds before it expires
(docs show `expires_in: 900`, i.e. 15 minutes) — callers never see or manage the token
directly.

## Local setup

```
npm install
npm run typecheck   # tsc --noEmit
```
