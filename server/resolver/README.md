# @verdict/resolver

The agent that acts at a deal's deadline: asks the oracle, relays the signed attestation on-chain,
and settles the escrow. Meant to be invoked by a scheduler — a 1Claw Automation in production (per
`docs/SPEC.md`'s 1Claw integration table), though nothing here depends on 1Claw specifically; any
cron or webhook handler can call `resolveDeal()`.

## What it does (`resolveDeal()`)

1. Takes the question compiled and dual-approved before deployment (`oracle-compiler`'s
   `compileDeal()` output) and substitutes the real deployed escrow address in as `consumer`.
2. Gets a signed `OracleAttestation` back (see "What's stubbed" below).
3. Sanity-checks the attestation's `questionHash` against the escrow's immutable one — refuses to
   relay on a mismatch rather than wasting gas on a doomed transaction.
4. If the answer is `true` and the payout is at or above a configured threshold, consults a pluggable
   approval gate before relaying — the spec's "human approval above a payout threshold."
5. Relays via `submitAttestation()`, then best-effort attempts `release()` (only for a `true` answer;
   a failure here — most likely the challenge window hasn't elapsed — isn't treated as an error, since
   `release()` is permissionless and can be called again later, by this resolver or anyone else).

## By design, this cannot redirect funds

`submitAttestation`, `release`, and `reclaim` are all permissionless on the contract itself (see the
audit). This resolver is just one wallet paying gas to call them — a bug or a compromise here can
waste gas or delay settlement, but the escrow's payer, payee, and deadline were already fixed
immutably at deployment. Anyone else can relay the same public attestation if this resolver is down.

## `PaymentSigner` is real now (`src/paymentSigner.ts`)

`imdPaymentSigner(account)` builds and signs both of IMD's required signatures — a Permit2
`PermitWitnessTransferFrom` payment, then a `QuoteApproval` binding it to the exact quote — following
the schema reverse-engineered from IMD's own shipped frontend (`docs/DAY-ONE-FINDINGS.md` §13; the
actual construction lives in `@verdict/imd-client`'s `paymentSigning.ts`). `account` just needs
`address` and `signTypedData` — a viem `LocalAccount` works directly, and so does a 1Claw-backed
signer (`oneClawTypedDataSigner`, now live-verified — see §20) once its agent has a fresh token
minted after Intents is enabled. Both produced signatures are confirmed genuinely valid — they
independently recover to the signer's address via viem's `recoverTypedDataAddress`
(`test/paymentSigner.test.ts`), not just asserted well-formed.

**Live-verified with real money (2026-09-29, `scripts/imd-real-payment-demo.ts`)**: a real
`oracle.request`, paid for with the wallet's real `$IMD`, admitted on the first attempt — no schema
corrections needed. Real payment tx:
[`0x4beb...cdd55e1cb`](https://etherscan.io/tx/0x4beb83f6b7653d1f49f0bcc61bd371ff9986ce1a38b7542384d0cd6ddd55e1cb).
Full record in `docs/DAY-ONE-FINDINGS.md` §14. `NOT_IMPLEMENTED_PAYMENT_SIGNER` still exists as the
default for callers that haven't wired a real signer.

A second real paid request (`scripts/imd-real-payment-success-demo.ts`) reached actual quorum and
got a genuine, non-disagreed attestation — the first time that's happened in this project. See
`docs/DAY-ONE-FINDINGS.md` §19 for the question design that avoided §15's citation-clustering
disagreement, and for the one still-open detail (the signature itself wasn't captured in that run's
log — the shape parsed correctly, which is what matters for the code, but the actual bytes weren't
saved to also confirm the signature verifies on-chain).

## What else is stubbed, and why

- **`fetchOracleAttestation`** (`src/oracleResult.ts`) — the real `GET /oracle/requests/:id`
  response shape is now confirmed for all three terminal states: `"assessing"` (§14), `"disagreed"`
  (§15), and the successful populated shape with `attestation`/`signature`/`signer` filled in (§19).
  `pollOracleUntilResolved` actually waits out real panel-assessment time instead of guessing, and
  throws a distinct `OracleDisagreedError` rather than misreporting a disagreement as a parse
  failure.
- **`ApprovalGate`** (`src/approval.ts`) — 1Claw's Human-Readable Action Approvals aren't wired up.
  The threshold *logic* (`needsApproval`) is real and tested; only the "ask a human" transport is a
  stub.

## Vault-backed secrets (`src/vaultSecrets.ts`)

New: `loadOrCreateImdToken(vault, dealId)` and `loadGithubPublishToken(vault)` implement the spec's
1Claw integration table row "Hold IMD paid tokens, GitHub tokens, LLM keys | Vaults ... | One vault,
paths `imd/orders/<deal>`, `github/publish`." Both are built on `@verdict/oneclaw-client` (this
repo's hand-rolled client for `api.1claw.co`, same pattern as `imd-client` for `api.imd.fun` — see
its README for what's confirmed vs. docs-only, and `docs/DAY-ONE-FINDINGS.md` §7 for the real
`1claw.co` domain and its Intents-API scope).

`resolveDeal()` itself is unchanged and still takes a plain `imdToken` string
(`ResolveDealOptions.imdToken`) — it has no dependency on 1Claw at all. `vaultSecrets.ts` is purely a
convenience for callers that have a vault configured: fetch (or mint-and-persist, for the IMD token)
the secret, then pass its value into `resolveDeal()` like any other token. A caller without vault
access can keep calling `generateClientToken()` directly, exactly as `e2e-demo.ts` does today.

**Live-verified 2026-09-29**: a missing secret does return 404 (confirmed directly, not assumed —
`loadOrCreateImdToken`'s "create if missing" branch works as written) — see
`docs/DAY-ONE-FINDINGS.md` §8. Full unit coverage in `test/vaultSecrets.test.ts` (fake `VaultClient`,
no network).

## Scheduling resolution (`src/automation.ts`)

Implements the spec's other 1Claw row: "Fire at the deadline | Automations | One cron or webhook
trigger per deal, created when the deployment goes live, calling the resolver."
`scheduleResolutionAutomation()` creates a 1Claw automation whose workflow is `wait_until(deadline)`
followed by an `http` call to a resolver webhook URL you host (a route that calls `resolveDeal()`
server-side) — all the actual IMD/chain logic stays in this package, matching the spec's framing
exactly. `cancelScheduledResolution()` lets an early settlement cancel a still-parked run.

**Live-verified 2026-09-29** end to end against the real `api.1claw.co`: create automation → trigger
→ poll to `success`, and separately, a `wait_until` park → confirmed `status: "running"` while
parked (not a distinct "waiting" state, despite that word in 1Claw's own prose) → cancellable in
that state. Full unit coverage in `test/automation.test.ts` (fake `AutomationClient`, no network).
No doc/reality gaps found this time — see `docs/DAY-ONE-FINDINGS.md` §7–9 for the ones found earlier
building the vault side.

`headers` on `ScheduleResolutionOptions` lets the automation's `http` step carry auth (e.g.
`X-Resolver-Secret`) to a real webhook — added and live-verified against a real deployed site, not
just localhost, in `scripts/real-automation-smoke.ts`: schedules a real automation against a real
Vercel deployment's `/api/resolve/[address]`, waits for it to park and fire for real, and confirms
the run reached real application code (see `docs/DAY-ONE-FINDINGS.md` §18).

## Permit2 signing via 1Claw's Intents API (`src/permit2.ts`)

The generic, publicly-verifiable half of IMD's "Permit2" payment scheme: `permit2TypedData()` builds
a real Permit2 `PermitTransferFrom` EIP-712 document (domain, types, and the canonical
`0x000000000022D473030F116dDEE9F6B43aC78BA3` address all confirmed directly from Uniswap's public
`permit2` repo and `@uniswap/permit2-sdk` — **not** from the `x402` npm package, which turns out to
have zero Permit2 support despite last being described that way; see
`docs/DAY-ONE-FINDINGS.md` §10 for the correction). `signPermit2Transfer()` signs it through 1Claw's
generic Intents API; `verifyPermit2Signature()` independently checks the result with viem rather than
trusting the signer's own response.

**Live-verified for real, 2026-09-29** (`docs/DAY-ONE-FINDINGS.md` §20 — correcting the "dashboard-only
gate" belief from §10, which turned out to be wrong): `scripts/permit2-demo.ts` signs a real Permit2
`PermitTransferFrom` through 1Claw's actual Intents API and independently verifies it recovers to the
provisioned signing key's address with viem. Getting from "403 refused" to a real signature took
three real fixes, all in `docs/DAY-ONE-FINDINGS.md` §20: re-authenticating as the agent itself (not
the human org-wide key) after enabling, the correct `eip712_domain_allowlist` shape
(`[{verifying_contract}]`, not plain address strings), and `withDomainType()` for a wire-format gap
in 1Claw's hasher. The fallback-to-local-viem-account path still exists in the script for a genuinely
misconfigured org, but is no longer the expected outcome.

This is still **not** IMD's actual payment integration, though — the real `spender`, nonce source,
and whether a witness (`PermitWitnessTransferFrom`) is required are IMD-specific and already answered
separately in §13/§14; `imdPaymentSigner` (not `permit2.ts`) is what a real payment actually uses, and
it's now equally able to take a 1Claw-backed signer as its `account` — see `paymentSigner.ts`.

## On-chain writes via 1Claw's Intents API (`src/oneClawRelay.ts`)

Payment signing (above) is a typed-data *signature* — `submitAttestation()`/`release()` are on-chain
transaction *submissions*, a different 1Claw endpoint (`POST /v1/agents/:id/transactions`, which
signs and broadcasts via 1Claw's own dedicated RPC for the target chain). `relay.ts` now exports a
`TransactionRelay` interface both a local viem account (`viemTransactionRelay`, wrapping the existing
`submitAttestation`/`release` functions unchanged) and `oneClawRelay.ts`'s `oneClawTransactionRelay`
satisfy — `resolveDeal()`'s new `relay` option takes either, in place of `walletClient`.

**Signing is live-verified for real at zero cost, 2026-09-29** (`docs/DAY-ONE-FINDINGS.md` §22): using
1Claw's sign-only mode (`/transactions/sign` — signs inside the HSM, never broadcasts, so no gas is
spent), a real, correctly ABI-encoded `submitAttestation()` call was signed through the agent's real
key and independently verified with viem's `recoverTransactionAddress` — real signature, real
calldata, real `to` address.

**Real broadcast currently fails, though — confirmed by actually trying it**, not assumed:
`scripts/base-mainnet-oneclaw-relay-demo.ts` deployed a real escrow on Base mainnet with real USDC and
called `relay.submitAttestation()` for real. 1Claw signed it correctly (matching the sign-only proof
exactly) but its own broadcast infrastructure failed to deliver it — a `tx_hash` came back, but the
transaction was never on-chain. `GET /v1/agents/:id/transactions` gave the real reason:
`status: "signed"`, `"Broadcast failed: ... please upgrade to paid plan"` — confusing, since this
org's subscription is already on the paid "team" tier. `oneClawTransactionRelay` now checks the
response `status` and throws `OneClawBroadcastFailedError` instead of trusting a `tx_hash` that was
never delivered. No funds were at risk: the real USDC was cleanly reclaimed once the demo's short
deadline+grace window elapsed, confirmed back at the exact original balance.

**Net effect on retiring `EVM_PRIVATE_KEY`**: payment signing (§20) and transaction signing (here) are
both proven. Actual on-chain *delivery* through 1Claw is not, currently — blocked on something in
1Claw's own broadcast path, not this codebase. Until that's resolved, a real resolver still needs
either the raw `EVM_PRIVATE_KEY` path or a "sign via 1Claw, broadcast the raw tx through a normal RPC
directly" hybrid — not built, but straightforward given the signature itself is already proven
correct.

## What's real and tested

- **`relay.ts`** (`submitAttestation`, `release`, `reclaim`, `withdraw`, `readEscrowState`) — genuine
  viem calls against the real contract ABI, read from the Foundry build artifact directly (never
  hand-duplicated, so it can't drift from what's actually deployed).
- **`test/integration.test.ts`** — spins up a local Anvil chain, deploys the *actual compiled*
  `MilestoneEscrow` and `MockUSDC` bytecode, signs a real EIP-712 attestation with a test oracle key
  and a real payer-authorization signature, and relays both through this package's own `relay.ts` —
  proving the chain-interaction code genuinely works against the real contract, not a mock of it.
  Requires `forge build` to have run in `contracts/` first.
- **`resolve.ts`**'s control flow (approval gating, questionHash mismatch handling, the
  true/false branch logic) — unit-tested with fake wallet/public clients, independent of both the
  chain and the unconfirmed IMD steps above.

## End-to-end demo (`scripts/e2e-demo.ts`)

Proves the whole pipeline composes, not just that each package passes its own tests in isolation.
Runs the real thing at every step that's free and confirmed:

1. `oracle-compiler`'s `compileDeal()` — a **real, free network call to `api.imd.fun`** — for a
   fabricated deal (extraction is faked; no LLM key available in this environment). Returns IMD's
   actual, binding `questionHash`.
2. Deploys the **real compiled `MilestoneEscrow` bytecode** to a local Anvil chain, constructor-bound
   to that exact hash from IMD.
3. `pinQuestion()` — another real, free IMD call, registering the real deployed address.
4. `resolveDeal()` — real relay and settle logic, faking only the one step that costs real IMD tokens
   on mainnet and needs an unconfirmed signing scheme (getting the actual paid attestation).
5. Reads back the final state with this package's own `readEscrowState()` — the same fields
   `site/lib/escrow.ts` renders.

```
npm run e2e-demo
```

Last run: IMD returned a real `questionHash`, the escrow deployed and bound to it correctly, the
relay and automatic settle-after-challenge-window retry both succeeded, and the payee ended up
credited 990 USDC on a 1000 USDC deal at a 1% fee — exactly the expected math, computed by the real
contract, not asserted by the script.

## Local setup

```
npm install
npm run typecheck
npm test         # includes the Anvil integration test; requires `forge build` in ../../contracts first
npm run e2e-demo
ONE_CLAW_API_KEY=$(grep -oP '(?<=^ONE_CLAW_API_KEY=).*' ~/.secrets/verdict.env) npm run permit2-demo
```
