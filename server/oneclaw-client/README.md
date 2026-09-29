# @verdict/oneclaw-client

A thin, hand-rolled client for [1Claw](https://1claw.co)'s Vaults/Agents Human API
(`api.1claw.co`) — the same shape as `@verdict/imd-client`: no SDK dependency, just `fetch`
and the documented request/response shapes, typed.

Covers three of the spec's 1Claw integration table rows: the **vault side** (hold IMD paid
tokens, GitHub tokens, and LLM keys in a 1Claw vault instead of raw environment variables,
and let an agent fetch only what its policy grants), **Automations** (fire a workflow at a
deal's deadline), and the generic half of the **Intents API** (sign transactions/typed data
without the agent holding a raw private key). See `@verdict/resolver`'s
`automation.ts`/`permit2.ts` for how the resolver package builds on top of these.

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

## Automations and Intents API

Added 2026-09-29, both live-verified against the real API:

- **Automations** (`createAutomation`, `triggerAutomation`, `getAutomationRun`,
  `cancelAutomationRun`, plus `waitUntilStep`/`httpStep` builders) — create/trigger/poll/cancel
  all confirmed working exactly as documented, no doc gaps found. See
  `@verdict/resolver`'s `automation.ts` for the resolver-specific
  `scheduleResolutionAutomation()` built on top.
- **Intents API** (`createSigningKey`, `sign`, `updateAgent`, `withDomainType`, etc.) — the signing
  mechanism itself is generic: `POST /v1/agents/:id/sign` takes an arbitrary `{domain, types,
  primaryType, message}` document. **Live-verified for real 2026-09-29** (`docs/DAY-ONE-FINDINGS.md`
  §20, correcting §10's "dashboard-only" belief — it isn't; the real fix is a fresh agent-token
  exchange after enabling, not a dashboard visit): both `oneClawTypedDataSigner`
  (`typedDataSigner.ts`) and `@verdict/resolver`'s `permit2.ts` produce real signatures through
  1Claw's real endpoint, independently verified with viem's `recoverTypedDataAddress` — not just
  "no error thrown." `withDomainType()` handles a real wire-format gap: 1Claw's hasher requires
  `types.EIP712Domain` explicitly, which viem-built typed data (this whole repo's convention) never
  includes.
- **On-chain transaction submission** (`submitTransaction`, `signTransaction`) — the other kind of
  write 1Claw's Intents API does: `POST /v1/agents/:id/transactions` signs and (in principle)
  broadcasts a real transaction via 1Claw's own dedicated RPC for the target chain;
  `/transactions/sign` signs the same request but never broadcasts (BYORPC — free, since only
  broadcasting costs gas). **Signing is live-verified for real, twice** (`docs/DAY-ONE-FINDINGS.md`
  §22): sign-only mode at zero cost (a real, correctly ABI-encoded contract call, signed through the
  agent's real key, independently verified with viem's `recoverTransactionAddress`), and again during
  a real `submitTransaction()` attempt that got a correct signature before failing to broadcast.
  **Broadcasting through 1Claw's own infrastructure currently fails** on this org's account — a 200
  response with a real-looking `tx_hash` that was never actually sent (confirmed via
  `GET /v1/agents/:id/transactions`: `status: "signed"`, `error_message: "Broadcast failed: ... please
  upgrade to paid plan"`, despite this org being on a paid "team" tier already). See
  `@verdict/resolver`'s `oneClawRelay.ts` — `oneClawTransactionRelay` (the simple, single-hop version)
  now checks `status` and throws `OneClawBroadcastFailedError` rather than trusting a `tx_hash` that
  was never delivered. `oneClawSignAndBroadcastRelay` is the working alternative: it signs via
  `signTransaction()` (free, no 1Claw broadcast involved) and broadcasts the raw signed tx itself over
  a plain RPC — proven live on Base mainnet (`docs/DAY-ONE-FINDINGS.md` §22's second addendum), a real
  transaction that actually landed on-chain.

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
