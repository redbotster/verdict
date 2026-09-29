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

## What's stubbed, and why

Two seams are deliberately left as pluggable, throwing-by-default stubs rather than guessed-at
implementations — same pattern as `imd-client`'s `pay()` and `oracle-compiler`'s extraction step:

- **`PaymentSigner`** (`src/paymentSigner.ts`) — IMD's Permit2 payment payload and EIP-712
  quote-approval schema are unconfirmed (their reference implementation is in a private repo; see
  `docs/DAY-ONE-FINDINGS.md`). `NOT_IMPLEMENTED_PAYMENT_SIGNER` throws a clear error naming exactly
  what's missing.
- **`fetchOracleAttestation`** (`src/oracleResult.ts`) — the actual `GET /oracle/requests/:id`
  response shape has never been observed, since observing it requires a real paid `oracle.request`.
  Best-effort parsed from spec prose alone; treat a failure here as informative, not proof the rest
  of the resolver is broken.
- **`ApprovalGate`** (`src/approval.ts`) — 1Claw's Human-Readable Action Approvals aren't wired up.
  The threshold *logic* (`needsApproval`) is real and tested; only the "ask a human" transport is a
  stub.

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
npm test   # includes the Anvil integration test; requires `forge build` in ../../contracts first
```
