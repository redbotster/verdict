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

## 7. 1Claw is real (`1claw.co`, not `1claw.ai`) but its Intents API doesn't leak IMD's schema

Investigated 2026-09-29 using `ONE_CLAW_API_KEY` from `~/.secrets/1claw.env`. Two corrections and one
real result:

- **Domain correction**: `1claw.ai` is an unrelated Chinese product (a self-hosted "AI agent on your
  own Linux server via 1Panel + OpenClaw" — WhatsApp/Telegram/Discord ops bot). The actual platform the
  spec means is **`1claw.co`**: "Secure infrastructure for AI agents" — Vaults, Shroud (TEE LLM proxy),
  the **Intents API** (on-chain signing without holding keys), Automations, Runtimes, Embedded Wallets.
  Real API base: `api.1claw.co`. Real docs: `docs.1claw.co`. SDKs: `@1claw/sdk`, `@1claw/mcp`, `@1claw/cli`.
- **The Intents API is a generic EIP-712/transaction signer, not an IMD-aware one.** `POST
  /v1/agents/:id/sign` takes `intent_type: "typed_data"` with an arbitrary `{domain, types, primaryType,
  message}` document (gated by `eip712_domain_allowlist`/`eip712_default_policy`) and returns a
  signature — it has no special knowledge of IMD's `quoteApprovalTypedData` schema. There's also an
  `eip712_digest` raw-digest mode (blind signing, off by default, human-gated) for cases where the
  caller computes the canonical digest itself. Conclusion: 1Claw can be the signer for the "IMD
  Permit2 payment / quote approval" step once we know the exact domain/types to sign — it does not
  supply that schema itself.
- **The 402 challenge body was captured live, for free, with no payment.** `POST /requests/quote`
  (free) → `POST /requests/:id/submit` with no body (confirmed free — no charge until a `quoteSignature`
  is actually submitted) returns the full x402 v2 challenge:
  `{x402Version, resource, accepts:[{scheme:"exact", network:"eip155:1", asset, amount, payTo,
  maxTimeoutSeconds, extra:{assetTransferMethod:"permit2"}}], quote, requesterScopeHash, resourceUrl,
  input}`. This matches the docs exactly, but confirms the challenge body itself does **not** inline an
  EIP-712 domain/types for the quote-approval signature — `quoteApprovalTypedData()` builds that
  client-side from this JSON, and its construction is not published anywhere we could find.
- **`quoteApprovalTypedData` is confirmed not public.** A GitHub code search returns zero hits for that
  exact symbol. `x402` itself is a real, public npm package (`x402-foundation/x402` on GitHub), and
  its outer envelope (challenge shape, `resource`/`accepts`/`quote`) matches what IMD sends — but
  **correction, see §10**: the package's actual "exact" scheme implementation is USDC/EIP-3009-only
  and has zero Permit2 support, so it does not in fact give a buildable payment-payload half the way
  this entry originally claimed. No `@identitymd/*` package exists on the public npm registry either
  (only a scope name seen in IMD's docs prose, not a resolvable install target).

**Net effect on the project's biggest blocker**: neither half of the two-signature flow is derivable
from a public library as-is (see §10 for the full correction) — both the Permit2 payment payload's
IMD-specific parameters and the quote-approval EIP-712 wrapper still need to come from IMD directly —
support, partnership docs, or a published SDK — before `ImdClient.pay()` can be implemented for real.
What §10 *does* establish: Permit2's own public schema (independent of IMD or x402) is confirmed and
implemented in `server/resolver/src/permit2.ts`, ready to slot in once IMD's specific parameters are
known. Do not guess at either schema.

## 8. `ONE_CLAW_API_KEY` in `~/.secrets/1claw.env` was stale; a fresh key (in `~/.secrets/verdict.env`) works

Built `server/oneclaw-client` (2026-09-29) to cover the spec's "vault side" (vaults, secrets, agents,
policies — see package README). The first key on hand (`~/.secrets/1claw.env`) was rejected by the
real API: `POST /v1/auth/api-key-token` → clean `401 Invalid API key`, confirmed not a client bug (an
identical raw `curl` got the byte-identical rejection). A fresh key from the dashboard, placed in
`~/.secrets/verdict.env`, authenticated successfully.

## 9. The real API's agent/vault binding behavior differs from its own Human API reference docs

Found by running `oneclaw-client`'s `live-smoke` script for real (2026-09-29) — the full golden path
(vault → secret → agent → policy → agent-scoped fetch) now passes end to end, but getting there
required two live-only corrections to `docs.1claw.co/docs/vaults/human-api/agents/register-agent`,
which lists only `name, description, auth_method, scopes, expires_at, api_key_expires_at,
intents_api_enabled` as the `POST /v1/agents` request body:

- **`vault_ids` is a real, required-in-practice field, undocumented on that page.** Omitting it (as
  the reference page's own example does) creates an agent bound to no vault; every secret fetch as
  that agent returns `403 {"detail":"Agent token is not bound to this vault"}`, regardless of any
  policy granted. It only surfaced because the separate "Agents overview" page's aside on child agents
  mentions `vault_ids` as a field that exists on agent records. Fix: pass `vaultIds: [vault.id]` (or
  more) at `createAgent()` time.
- **Passing `scopes` explicitly breaks policy-derived access.** The register-agent reference page's
  own example passes `scopes: ["vaults:read"]` — doing exactly that produces a *different* 403 once
  `vault_ids` is fixed: `{"detail":"Agent token scopes do not cover this secret path"}`, even with a
  correct policy grant in place. One line elsewhere in the docs ("JWT scopes are derived from those
  policies when `agents.scopes` is empty") turned out to be the actual behavior — leave `scopes`
  unset and the policy grant alone determines access. `docs`' own worked example is therefore not
  copy-paste-correct for the read-secret case; both corrections are now baked into
  `OneClawClient.createAgent()`'s own doc comment in `src/client.ts`.

Net effect: the vault side is now genuinely live-verified, not just typechecked against docs prose —
`npm run live-smoke` in `server/oneclaw-client` passes end to end, self-cleaning, against the real
`api.1claw.co`.

## 10. Correction to §7: the public `x402` package has zero Permit2 support — and 1Claw's Intents API needs a dashboard toggle, not just an API flag

Two findings while building `server/resolver/src/permit2.ts` (2026-09-29), one a correction to a
claim made in this doc's earlier (now-superseded) version of §7/§9:

- **Correction**: last session's finding said "`x402`... is a real, public npm package... that half
  [the payment payload] is derivable from public docs." That's wrong in an important way. The
  installed `x402@1.2.0` package's EVM "exact" scheme (`x402/schemes`, `x402/client`,
  `x402/shared/evm`) is **entirely USDC/EIP-3009 (`transferWithAuthorization`) specific** —
  `selectPaymentRequirements`'s own doc comment says "Default behavior is to select the first
  payment requirement that has a USDC asset," and `verify`/`settle` explicitly check "USDC contract
  address," "permit deadline," "USDC balance." A repo-wide grep for `Permit2`/`permit2` across the
  package turns up nothing except an unrelated string inside a bundled wallet-UI widget. **The
  public x402 package cannot build IMD's Permit2 payment payload at all** — IMD's `$IMD` token
  doesn't support EIP-3009, so IMD's `extra: {assetTransferMethod: "permit2"}` is IMD's own
  extension beyond what the reference x402 implementation does, not a documented public mechanism.
- **What IS real and public**: Permit2 itself (Uniswap's contract, not x402's). Confirmed directly
  from `github.com/Uniswap/permit2` (`src/libraries/PermitHash.sol`, `src/EIP712.sol`) and the
  official `@uniswap/permit2-sdk` npm package (`src/domain.ts`, `src/signatureTransfer.ts`): domain
  `{name: "Permit2", chainId, verifyingContract}` (no `version` field), canonical address
  `0x000000000022D473030F116dDEE9F6B43aC78BA3` (same on every chain except zkSync), and the
  `PermitTransferFrom{permitted: TokenPermissions, spender, nonce, deadline}` /
  `TokenPermissions{token, amount}` type pair for a single-use signature-transfer permit. Built as
  `server/resolver/src/permit2.ts`'s `permit2TypedData()` — this part is genuinely public and
  confirmed, unlike IMD's own wrapper around it.
- **1Claw's Intents API has a dashboard-only gate the API can't flip.** `PATCH /v1/agents/:id` with
  `{intents_api_enabled: true}` returns 200 and a subsequent `GET` correctly echoes back
  `intents_api_enabled: true` — but calling `POST /v1/agents/:id/sign` on that same agent still
  403s: `{"detail":"Intents API is not enabled for this agent. A human operator must enable it in
  the agent settings at https://1claw.co/agents."}`. Confirmed not a propagation-delay race (retried
  after real elapsed time, same result). The `intents_api_enabled` field is evidently a different,
  API-settable flag from whatever dashboard toggle the sign endpoint actually checks — the docs
  don't distinguish the two.
- **What this means for `permit2.ts`**: the schema and code are correct and complete (proven via
  `resolver/scripts/permit2-demo.ts`'s fallback path — a local viem account signs the exact same
  typed-data document produced by `permit2TypedData()` and the signature verifies correctly), but
  the *live* 1Claw signing path is blocked on a one-time manual dashboard action, not on anything
  fixable in code. `signPermit2Transfer()` and `verifyPermit2Signature()` are ready to use for real
  the moment an agent has Intents API enabled via `1claw.co/agents`.
- **Still unconfirmed regardless**: IMD's actual `spender` (their `payTo` directly, or an
  intermediary?), nonce source, and whether they require `PermitWitnessTransferFrom` (binding the
  permit to a specific `quoteHash`) instead of the plain `PermitTransferFrom` used here. None of
  that is guessed at — `permit2-demo.ts`'s test values are explicitly labeled as plausible-but-
  unconfirmed, not as IMD's real integration.

## 11. Acquired real `$IMD` via a hand-rolled Uniswap v4 swap — real transaction, on mainnet

At the user's explicit request (2026-09-29), swapped 0.0015 ETH for `$IMD` directly against the real
Uniswap v4 pool on Ethereum mainnet, since every convenient swap-quote API (0x, 1inch, Uniswap's own
trade API) now requires an API key none of which were available. Built from Uniswap's official SDKs
(`@uniswap/universal-router-sdk`, `@uniswap/v4-sdk`, `@uniswap/sdk-core`) and real on-chain reads —
nothing guessed:

- **The pool's `PoolKey` isn't public anywhere** — DexScreener's `pairAddress` for a v4 pool is
  actually the 32-byte `PoolId` (`keccak256(abi.encode(poolKey))`), not a contract. Recovered the
  real `fee` (10000, i.e. 1%), `tickSpacing` (200), and `hooks` (`0x0` — a plain, hookless pool) by
  reading `PoolManager`'s own `Initialize` event log for that exact pool ID directly
  (`0x000000000004444c5dc75cB358380D2e3dE08A90` on mainnet, from `docs.uniswap.org/contracts/v4/deployments`)
  and independently verified by recomputing `keccak256(abi.encode(poolKey))` locally — it reproduced
  the exact DexScreener pool ID byte for byte.
- **Public free-tier `eth_getLogs` is far more restrictive than expected** in 2026: publicnode
  treats any non-latest `eth_getLogs` as an "archive" request requiring a paid token regardless of
  range size; drpc.org and cloudflare-eth.com both errored on ranges that should have been within
  their stated limits. `rpc.mevblocker.io` was the one that actually worked, on a ~30-block window
  pinpointed by binary-searching block timestamps against the pool's `pairCreatedAt` estimate.
- **`SwapRouter.encodeSwaps`'s V4 settle/take actions differ by custody mode, and native ETH input
  is incompatible with `allowDirectTransfers`.** Confirmed by hitting three real SDK validation
  errors in sequence: `SETTLE_ALL_REQUIRES_DIRECT_TRANSFERS` (plain `SETTLE_ALL`/`TAKE_ALL` need
  `allowDirectTransfers: true`), then `DIRECT_TRANSFERS_NATIVE_INPUT` (that mode explicitly rejects
  a native-ETH input, since there's nothing to "pull" — ETH only arrives via `msg.value`). The
  working pattern for a plain "swap my own ETH for a token, router holds custody" case:
  `v4Actions: [SWAP_EXACT_IN_SINGLE, {action:"SETTLE", currency: ethAddress, amount: CONTRACT_BALANCE,
  payerIsUser: false}, {action:"TAKE", currency: tokenAddress, recipient: ROUTER_AS_RECIPIENT, amount: 0}]`
  — `CONTRACT_BALANCE` and `amount: 0` (`OPEN_DELTA`) are real sentinels exported by
  `@uniswap/universal-router-sdk`, not arbitrary values.
- **Simulated before sending** (`eth_call` with the exact calldata/value from an unsigned wallet
  context) and only broadcast after that succeeded cleanly.

**Result**: real transaction
[`0x131e6a1c45b3ee3c8ab93161f0e1218eafcd3d466690eeca5e79fb6114f57876`](https://etherscan.io/tx/0x131e6a1c45b3ee3c8ab93161f0e1218eafcd3d466690eeca5e79fb6114f57876),
confirmed in block 26083768, `status: success`. The ops wallet
(`0xF57CfAF1f2b12E7f23C342c4fAfd675379840668`) went from 0 to **0.5172 `$IMD`** — just over one
IMD action's worth (0.5 IMD) at the live quote. This is real `$IMD`, ready for whenever the payment
schema (§10) is resolved — it still can't be spent on a real oracle request without that. The
one-off swap script itself lived in a scratch directory outside the repo (wallet- and
amount-specific, not reusable product code) and was deleted after the swap completed; this write-up
plus the on-chain transaction are the durable record.

## 12. `MilestoneEscrow.sol`'s full real lifecycle, proven on Base mainnet with real money

At the user's explicit request (2026-09-29): a small, deliberately self-dealing demo (one wallet
plays payer, payee, fee recipient, deployer, and resolver — explicitly **not** a real deal between
real counterparties), permanently scripted at `server/resolver/scripts/base-mainnet-demo.ts` since
unlike the swap script this proves the actual product contract, not a one-off treasury operation.
First got a small real stablecoin balance the same hand-rolled way as §11 (Universal Router,
WRAP_ETH + V3_SWAP_EXACT_IN this time, real USDC on Base — `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`,
confirmed via DexScreener), then ran the escrow through its entire real lifecycle: deploy (bound to
a real, free IMD `questionHash`) → a real EIP-712 `true` attestation, signed by a throwaway local
key standing in for IMD's real oracle signer (which this project still can't use — see §10) →
`release()` after the real challenge window elapsed → `withdraw()`. **Final confirmed on-chain
state**: `state() == 1` (Released), `trueAt` a real non-zero timestamp, and the full 2.166484 USDC
back in the wallet — the contract genuinely moved real money through its entire true-path lifecycle
and returned it, exactly as designed.

Three real, reproducible findings from getting there — all about `mainnet.base.org`'s public RPC,
not about the contract or the resolver code, but costly to discover blind:

- **The V3 swap needed an explicit Universal Router version.** `SwapRouter.encodeSwaps` defaults to
  an older command-encoding format unless told which deployed router version to target via
  `urVersion` — sending that older 4-field `V3_SWAP_EXACT_IN` encoding to the actual deployed
  `2.1.2` router (which decodes 6 fields: `recipient, amountIn, amountOutMin, path, payerIsUser,
  minHopPriceX36`) reverted with the real on-chain `SliceOutOfBounds()` error (decoded by matching
  its selector against `BytesLib.sol`'s source, same method as §11's V4 errors). Fixed by setting
  `urVersion: UniversalRouterVersion.V2_1_2` explicitly.
- **`mainnet.base.org`'s public RPC has real, visible eventual-consistency lag across its backend
  nodes.** Hit this three separate times in one run: (1) a contract deploy's constructor
  `transferFrom` reverted with "exceeds allowance" even though the correct allowance was already
  confirmed on-chain, because the node that served the deploy's preflight simulation hadn't yet
  caught up to the just-mined `approve`; (2) `release()` reverted with `NotYetTrue()` on a node that
  hadn't yet seen the just-mined `submitAttestation`; (3) `withdraw()` reverted with `NothingOwed()`
  on a node that hadn't yet seen a just-mined `reclaim()`. All three succeeded immediately on retry.
  Worse: a `getBlock()` timestamp read minutes before it was used (for an attestation's `issuedAt`)
  came from a node running **~2 minutes ahead** of the nodes that later mined the actual
  transactions, tripping the contract's own `BadIssuedAt()` replay-safety check for real (`issuedAt
  > block.timestamp` at execution) — not a simulation artifact, an actually-mined, actually-reverted
  transaction. Mitigation: read timestamps fresh, immediately before use, rather than reusing an
  early one, and add a short settle delay after each write before the next dependent read/write.
- **A non-throwing `waitForTransactionReceipt` does not mean success.** It returns the receipt
  regardless of `status`, so the `BadIssuedAt()` revert above went completely unnoticed by the first
  version of this script — it logged a false "submitAttestation() — real tx" success and pressed on
  to `release()`, which correctly failed. Real cost: one throwaway escrow (`0x2754b3...`) got
  permanently stuck in `Funded` state, since its `oracleSigner` was an in-memory-only throwaway key
  never persisted — unrecoverable once the process exited having never actually recorded a `true`
  attestation. Recovered the funds via `reclaim()` once `deadline + grace` elapsed (by design — the
  same safety mechanism a real stuck deal would use), no money lost. Fixed by checking
  `receipt.status === "success"` explicitly after every write, and by printing the throwaway oracle
  key up front as a safety net in case a real bug (not just a transient RPC issue) leaves a deal
  needing the same key again mid-run.

## 13. IMD's real payment-signing schema, reverse-engineered from IMD's own shipped frontend

At the user's suggestion ("can we try to reverse engineer it"), 2026-09-29. Every avenue tried
earlier — GitHub code search, the public `x402` package, IMD's OpenAPI spec's prose, the private
`Identity-md/protocol` repo — either explicitly refused to give the schema or genuinely didn't have
it. What none of that considered: **IMD's own public web app has to construct and sign this exact
payload client-side**, since a human paying via `explorer.imd.fun/hire` needs their browser wallet to
produce it. That page (confirmed live: "Paying for a request needs an Ethereum wallet") ships this
logic in its own Next.js JS bundle — ordinary public, unauthenticated, client-side code served to
every visitor, the same as any webpage's "view source." Downloading and reading that bundle (16
chunks from `explorer.imd.fun/_next/static/chunks/`, minified but not obfuscated — real function
names below are this doc's, not IMD's internal ones) gave the complete, real schema for both
signatures, plus the exact request that submits them. This is reverse-engineering of IMD's own
production client, not guessing, not a private repo, and not any kind of access-control bypass.

**Signature 1 — the Permit2 payment.** Not a plain `PermitTransferFrom` (§10's generic building
block) — IMD uses Permit2's **witnessed** variant, binding the transfer's recipient into the permit
itself:

```
domain: { name: "Permit2", chainId: <from accept.network>, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" }
primaryType: "PermitWitnessTransferFrom"
types: {
  PermitWitnessTransferFrom: [permitted: TokenPermissions, spender: address, nonce: uint256, deadline: uint256, witness: Witness],
  TokenPermissions: [token: address, amount: uint256],
  Witness: [to: address, validAfter: uint256],
}
message: {
  permitted: { token: accept.asset, amount: accept.amount },
  spender: "0x402085c248EeA27D92E8b30b2C58ed07f9E20001",   // a fixed intermediary — NOT accept.payTo directly
  nonce: <random 256-bit value>,                             // Permit2's nonces are an unordered bitmap; any unused value works
  deadline: now + accept.maxTimeoutSeconds,
  witness: { to: accept.payTo, validAfter: 0 },
}
```

This answers the two biggest open questions from earlier: the `spender` is a **separate fixed
contract** (`0x402085...`), not IMD's `payTo` — presumably it pulls via Permit2 and forwards to
`payTo`. And the nonce is genuinely **client-chosen and random**, not server-issued.

**Signature 2 — the quote approval.** Binds the exact payment just signed to this exact quote, via a
self-referential hash:

```
domain: { name: "IdentityMD Paid Action", version: "1", chainId: <from quote.payment.network> }
primaryType: "QuoteApproval"
types: { QuoteApproval: [resource: string, requesterScopeHash: bytes32, quoteId: string,
  quoteHash: bytes32, paymentHash: bytes32, action: string, asset: address, amount: uint256,
  payTo: address, expiresAt: uint256] }
message: {
  resource: challenge.resourceUrl, requesterScopeHash: challenge.requesterScopeHash,
  quoteId: quote.id, quoteHash: quote.quoteHash,
  paymentHash: sha256(canonicalJson(fullPaymentPayload)),   // see below
  action: quote.action, asset: quote.payment.asset, amount: quote.payment.amount,
  payTo: quote.payment.payTo, expiresAt: quote.expiresAt,
}
```

`paymentHash` is `sha256` of a **canonical JSON serialization** of the entire payment payload signed
in step 1 (`{x402Version, payload: {signature, permit2Authorization}, accepted}`) — recursively
sorted object keys, standard JSON primitive encoding, rejects `undefined`/non-finite/non-integer
numbers. This is what cryptographically binds the two signatures together so one can't be replayed
against a different payment or quote. The canonicalizer is a real, specific algorithm (not just
`JSON.stringify`) — implemented exactly in `server/imd-client/src/paymentSigning.ts`'s
`canonicalJson()`.

**The actual submit call**, also confirmed from the bundle:

```
POST {orderId}/submit
body: { quoteSignature: <signature 2> }
headers: { "PAYMENT-SIGNATURE": base64(JSON.stringify(fullPaymentPayload)) }   // standard base64, not base64url
```

**Implemented for real**: `server/imd-client/src/paymentSigning.ts` (pure, dependency-free builders
— `buildPermit2Authorization`, `permit2PaymentTypedData`, `canonicalJson`, `paymentPayloadHash`,
`quoteApprovalTypedData`, `encodePaymentSignatureHeader`) and `server/resolver/src/paymentSigner.ts`'s
`imdPaymentSigner(account)`, which is now a fully real `PaymentSigner` — no longer a stub. Both
signatures are proven to be genuinely valid, independently-verifiable EIP-712 signatures (recovering
to the signer's own address via `viem`'s `recoverTypedDataAddress`), tested in
`server/imd-client/test/paymentSigning.test.ts` and `server/resolver/test/paymentSigner.test.ts`.

**What's still not done, deliberately**: this has never been submitted in a real, paid
`POST /requests/:id/submit` call — that would actually spend the wallet's real `$IMD`. Everything up
to that point (quote, challenge, building and signing both real payloads with the real wallet) can be
exercised for free; only the final submission costs money, so it's held for an explicit go-ahead.

**Caveat, stated plainly**: this is IMD's *current* shipped frontend (chunk `2-2_bbu6gpe2k.js` as of
2026-09-29), not a published, versioned API contract — it's exactly as stable as any website's
frontend build, which is to say, not guaranteed. If it ever stops matching IMD's real server-side
verification, re-fetch and re-diff the bundle rather than assuming this document is still current.

## What's still unconfirmed (needs real signing, so held back)

- ~~The exact EIP-712 `quoteApprovalTypedData` schema... and the exact Permit2 integration
  parameters~~ — **answered in §13**, reverse-engineered from IMD's own shipped frontend and now
  implemented for real. Still genuinely unconfirmed: whether IMD's *server-side* verification matches
  this exactly (never tested against a real paid submission — that costs real money, held for an
  explicit go-ahead) and whether the frontend logic changes without notice.
- ~~Whether 1Claw's Intents API can actually produce that signature~~ — answered in §7: yes,
  mechanically (it's a generic EIP-712 signer via `POST /v1/agents/:id/sign`), but only once we have
  the actual domain/types to hand it; 1Claw itself doesn't know IMD's schema. Now that §13 supplies
  those domain/types, `imdPaymentSigner`'s `TypedDataSigner` interface is satisfied by anything with
  `address` + `signTypedData` — including a 1Claw-backed signer, once its Intents API dashboard
  toggle (§10) is flipped for an agent.
- Whether panel size changes price (still flat 0.5 IMD per the capabilities policy regardless of
  `panelSize`, but that's the *listed* price, not necessarily what a 9-member quote charges —
  worth a real quote comparison once someone's ready to spend).
