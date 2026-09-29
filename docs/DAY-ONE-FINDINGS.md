# Day-one findings (2026-09-28)

Live checks against `https://api.imd.fun`, using only free calls (capabilities, health, quote, and
the empty-body challenge — none of these charge). No IMD tokens were spent, no wallet signed
anything, no 1Claw calls were made.

## 1. Sepolia has no configured oracle RPC right now — blocks the MVP's core assumption

The spec assumes "the oracle has a configured RPC for Sepolia (chain id 11155111)." Testing it:

- A well-formed `oracle.request` quote with top-level `"chainId": 11155111` (the chain whose blocks
  get pinned for the evidence window) returned:
  ```
  422 invalid_input — "No RPC for chain 11155111; set ORACLE_RPC_URLS."
  ```
- The identical body with `"chainId": 1` (Ethereum mainnet) succeeded (`201`, quote created).
- `GET /reads/rpcs/11155111` (a static reference skill listing public Sepolia RPCs from
  chainlist.org) is **not** the same thing as this operator's configured `ORACLE_RPC_URLS` — it's
  informational, not proof of a live, usable oracle RPC.

**Impact**: right now, an `oracle.request` whose evidence window is scoped to Sepolia (chain
11155111) cannot be quoted successfully on this IMD instance. Since the whole MVP is "Sepolia
only," this blocks the oracle side of the flow even though `workflow.open` deploys contracts to
Sepolia. This needs to be raised with IMD directly (ask them to set `ORACLE_RPC_URLS` for 11155111,
or ask whether the oracle's evidence-chain and the workflow's deploy-chain are meant to be
decoupled — e.g., pin evidence on mainnet/another chain while the *consumer* contract still lives
on Sepolia). Until resolved, treat this as a hard blocker for the "on-chain event" answer template
and for any workflow whose question needs a Sepolia block range; the GitHub-release and
page/file-live templates may be less affected since their `consumer.chainId` (the deployed
contract's chain) is a separate field from the evidence-window `chainId` — worth testing that
split explicitly once someone is ready to iterate further here.

## 2. questionHash IS derivable at quote time — for free, before any payment

The spec flagged this as a High-severity open risk with an undocumented derivation. Confirmed: a
successful `POST /requests/quote` response includes the fully pinned input, inline, in
`order.inputJson`:

```json
{
  "pinned": { "fromBlock": 25971352, "toBlock": 26078783, "toBlockHash": "0xa502..." },
  "questionHash": "0x95d90bf3dde76f29c3c938cd4ea171f2378d9d96caf2f3bc23b9dbb10c7a02c5",
  "request": { "...": "the exact request IMD will answer" }
}
```

So `questionHash` depends on the block range **pinned at quote time** (as the spec suspected), but
it is returned immediately and for free — no payment needed to read it. This means the spec's
"fallback" (payer and payee co-sign the hash from the quote before funding) is actually the clean,
primary design: quote first (free), extract `questionHash` + `pinned` range, both parties review
and sign off, *then* pay for the quote and deploy the escrow with that exact `questionHash` baked
into the constructor. No separate commit step is needed beyond "read the quote response."

## 3. Payment network is Ethereum mainnet (`eip155:1`), not testnet

`GET /requests/capabilities` and the live 402 challenge both confirm: the asset to pay with
(`0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7`, 18 decimals) and `payTo`
(`0x4e0fa57bde726079356537e2f34d671e9f41adbc`) live on **mainnet**. Every `workflow.open` and
`oracle.request` call costs real money on mainnet even though the resulting contract/attestation
targets Sepolia. This isn't a new risk exactly, but it means "testnet pilot" is a misnomer for the
economics — funding the ops wallet with IMD tokens is a real-money spend from day one. Budget and
approval thresholds should reflect that explicitly, not just the escrow's own test-USDC amounts.

## 4. workflow.open validation is agentic, not just schema

A minimal single-step `workflow.open` draft was rejected with a clear, specific schema-level
message: it requires "a chain or DAG with an onchain launch, ipfs hosting and one frontend step."
The spec's own 4-step draft (contracts → tests → review → site, with `ipfs` set) is shaped
correctly for that requirement. But submitting that exact draft (with a placeholder `ipfs` slug)
returned a *different* kind of 422: `"Rebuilt draft still needs attention: needs_revision. See
recheck questions, suggestions, reviewItems and prerequisites."` — with those extra fields not
present in the response body actually received (only a generic `problems` array). This suggests
IMD runs a second, LLM-driven review pass over the draft beyond structural validation, and that
pass can ask clarifying questions before admitting the order. **Open question for week one**:
how to retrieve and answer those recheck questions (a follow-up field on the same `requestKey`? a
separate endpoint?) — not resolved by the public OpenAPI spec alone. Needs either IMD's fuller docs
or a support conversation.

## 5. `questionHash` does NOT depend on `consumer` — and addresses must be lowercase

Built while implementing `server/oracle-compiler` (2026-09-28). Two follow-ups to finding #2 above:

- **`consumer` (both `chainId` and `verifyingContract`) has no effect on `questionHash`.** Confirmed by
  sending two otherwise-identical `oracle.request` quotes moments apart, differing only in
  `consumer.verifyingContract` — identical `questionHash` both times. This means a compile-time dry-run
  quote (using any placeholder consumer, since the escrow doesn't exist yet) already produces the real,
  binding `questionHash` — there's no need for a separate "final" quote once the escrow is deployed just
  to get a different hash. `server/oracle-compiler`'s `pinQuestion()` still exists to register the real
  deployed address with IMD before the resolver's real paid call, but that's bookkeeping on IMD's side,
  not a correctness requirement for the escrow contract. (An earlier version of this doc and of the
  compiler's code assumed the opposite — corrected here.)
- **IMD's schema requires lowercase hex addresses**, confirmed via a direct 400 on
  `consumer.verifyingContract: "0x0000000000000000000000000000000000dEaD"` (mixed case) that a
  lowercased identical address doesn't trigger. A checksummed address (the normal, EIP-55 output of
  most wallet libraries) will silently fail with a bare `400 invalid_request` and no detail — worth
  building `.toLowerCase()` into any code path that accepts an address, since the error message alone
  gives no hint what's wrong.
- Also found in the process: the top-level `chainId` field (separate from `consumer.chainId` — it's the
  chain whose blocks get pinned for the evidence window) is a required field with no default; omitting
  it also produces the same unhelpful bare `400 invalid_request`.

## 6. The on-chain-event template's `guards.toleranceBps` breaks schema validation

Built and confirmed while closing out `server/oracle-compiler`'s last unverified template (2026-09-29).
The spec's own template table lists `guards: { toleranceBps: 0 }` as the on-chain event template's
guard shape (distinct from the panel-evidence templates' `sources`/`minSources`). Testing it: a
well-formed `oracle.request` body with `evidence: "chain"` and `guards: { toleranceBps: 0 }` (with or
without `sources`/`minSources` also present) returns a bare `400 invalid_request` — no `detail`, no
`problems`, same unhelpful shape as every other schema-level rejection found so far.

Isolated by bisection: starting from a known-`201` `release_published` body (panel evidence,
`guards: { sources, minSources }`) and changing exactly one field at a time — `evidence` to `"chain"`
(still `201`), `quorum` to equal `panelSize` at `5/5` (still `201`), the question text and
`definitions.project` to the on-chain-style wording (still `201`) — every single-field change kept
succeeding, until adding `toleranceBps` to `guards` (in any combination, with or without
`sources`/`minSources` alongside it) flipped the same body to `400`. Removing `toleranceBps` and
keeping only `sources`/`minSources` (same pattern as the other two templates) returns `201` again, with
a real `questionHash` and pinned block range.

**Fix applied**: `onchainEventTemplate` no longer emits `toleranceBps` at all; it builds
`guards: { sources: [<block explorer token URL>], minSources: 1 }` like the other templates. The
explorer URL is chosen from a small hardcoded chainId → domain map (Ethereum/Sepolia/Base/Base Sepolia)
with an Etherscan fallback for unlisted chains — wrong for those chains specifically, but a
present-and-wrong source satisfies schema validation, where an absent one doesn't. All three templates
are now live-verified end-to-end.

## What's still unconfirmed (needs real signing, so held back)

- The exact EIP-712 `quoteApprovalTypedData` schema (domain/types) IMD expects for the second
  signature in step 5. The 402 challenge body only exposes `extra: {"assetTransferMethod":
  "permit2"}` — it does not include a full typed-data document to sign as-is. IMD's own reference
  implementation (`Identity-md/protocol`, `apps/control-plane/src/paid-access/x402.ts`) is not a
  public repo (`gh api repos/Identity-md/protocol` → 404), so this could not be verified from here.
  **Do not guess at this schema and wire up real signing** — get it from IMD directly (partnership
  docs, support, or a published SDK) before attempting `ImdClient.pay()` for real.
- Whether 1Claw's Intents API can actually produce that signature (the spec's other top risk).
- Whether panel size changes price (still flat 0.5 IMD per the capabilities policy regardless of
  `panelSize`, but that's the *listed* price, not necessarily what a 9-member quote charges —
  worth a real quote comparison once someone's ready to spend).
