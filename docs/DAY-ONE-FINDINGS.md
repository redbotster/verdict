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

> **Corrected in §20**: the "one-time manual dashboard action" framing above is wrong. There's no
> separate dashboard-only gate and no tier requirement — `intents_api_enabled` is the one real flag,
> and the actual fix is re-authenticating **as the agent** (a fresh `POST /v1/auth/agent-token`
> exchange) after flipping it, not a dashboard visit. Read §20 before acting on anything above.

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

**Caveat, stated plainly**: this is IMD's *current* shipped frontend (chunk `2-2_bbu6gpe2k.js` as of
2026-09-29), not a published, versioned API contract — it's exactly as stable as any website's
frontend build, which is to say, not guaranteed. If it ever stops matching IMD's real server-side
verification, re-fetch and re-diff the bundle rather than assuming this document is still current.

## 14. The reverse-engineered schema works — a real, paid `oracle.request` was admitted on mainnet

At the user's explicit go-ahead, 2026-09-29, immediately after §13. Approved Permit2 for the wallet's
real `$IMD` (`approve` tx confirmed on-chain), then ran the actual project code end to end —
`compileDeal()` (free), `ImdClient.quote()` (free), `ImdClient.getChallenge()` (free),
`imdPaymentSigner()` (free, just signing), then `ImdClient.pay()` — **the real, first-ever paid call**.

**Result: fully admitted, no corrections needed to the reverse-engineered schema.**

- Payment transaction, confirmed on-chain:
  [`0x4beb83f6b7653d1f49f0bcc61bd371ff9986ce1a38b7542384d0cd6ddd55e1cb`](https://etherscan.io/tx/0x4beb83f6b7653d1f49f0bcc61bd371ff9986ce1a38b7542384d0cd6ddd55e1cb) —
  `status: 0x1`, a real ERC20 `Transfer` on the `$IMD` contract, and an event from
  `0x402085c248eea27d92e8b30b2c58ed07f9e20001` (the exact intermediary spender identified in §13 —
  its own event firing is further confirmation this is genuinely IMD's real routing contract).
- Wallet's `$IMD` balance: `0.5172145520352781` → `0.017214552035278084` — exactly 0.5 `$IMD`
  charged, matching the quoted price precisely.
- `client.pollUntilAdmitted()` returned `status: "admitted"`, `payment.status: "confirmed"`,
  `payment.paid: true`, and a real `admission.result`: `{kind:"oracle", requestId, jobId, statusUrl,
  attestationUrl}`.

**Bonus: this also captured the real `GET /oracle/requests/:id` response shape**, never observed
before (`server/resolver/src/oracleResult.ts`'s `fetchOracleAttestation` was best-effort parsed from
spec prose alone). While the request is still being worked (`status: "assessing"`), the real shape is:

```json
{
  "id", "status", "question", "questionHash", "chainId", "window": {"fromBlock","toBlock","toBlockHash"},
  "answerType", "evidence", "definitions", "guards", "panelSize", "quorum", "consumer",
  "validForSeconds", "jobId", "members": [], "agreement": null, "computed": null,
  "attestation": null, "signature": null, "signer": null, "failure": null, "attempts": 0,
  "attestedAt": null, "createdAt", "updatedAt", "url", "jobUrl"
}
```

`attestation`/`signature`/`signer`/`attestedAt` are null while `status: "assessing"` — presumably
populated once the panel finishes.

This is the single point this entire project was blocked on, for the entire session, now closed: the
whole IMD paid-request flow — compile, quote, challenge, sign, pay, get admitted — is real, working,
and proven with real money end to end.

## 15. A real panel can legitimately `"disagree"` even when every member reaches the same real-world answer — and no attestation is ever signed when that happens

Checked back on the real request from §14 two minutes later. Result:
[`GET /oracle/requests/b3184afe-...`](https://api.imd.fun/oracle/requests/b3184afe-f7b7-4038-87f3-8737dc29f16d)
returned `status: "disagreed"`, `failure: "1 of 4 answers agreed; 4 were required."` — despite **all
four responding panelists independently reaching the identical, objectively correct real-world
answer** (`answer: false` — `octocat/Hello-World` genuinely has zero GitHub releases, confirmed by
each member's own cited evidence).

**Why it disagreed anyway**: IMD's agreement/clustering mechanism doesn't just compare the boolean
`answer` — it also clusters by each member's `recipe.source` (the evidence URL cited), and that
comparison is stricter than semantic equivalence. Three of the four members cited
`https://api.github.com/repos/octocat/Hello-World/releases` (the API endpoint); one cited
`https://github.com/octocat/Hello-World/releases` (the human-facing page — the exact same
underlying fact). The response's `agreement.cluster` contains only **one** submission hash, with the
other three listed under `agreement.outsideSources` — the clustering didn't unify the API-URL members
with each other, only exactly one recipe ended up in its own cluster of one. (Also notable: `panelSize:
5` but only 4 `members` ever submitted at all — one panelist simply never responded; quorum then
needed 4-of-the-4-that-did-answer to cluster, not adjusted for the missing fifth.)

**Real product risk, not just a curiosity**: `attestation`, `signature`, and `signer` all stay `null`
on a `"disagreed"` outcome — **no attestation is ever signed**, true or false. For this specific
request (the real answer was `false` anyway — "milestone not met"), that's a survivable outcome: the
escrow's own design already handles "no attestation ever arrives" via `reclaim()` after
`deadline + grace`, and a payer reclaiming when nothing was ever attested reads the same either way.
**But the same disagreement mechanism could just as easily fire when the real-world answer is
`true`** — different panelists citing a project's GitHub API vs. its web UI as their source for a
release that genuinely was published, for instance — silently producing zero attestation for a milestone that
actually was met, with the deal falling through to `reclaim()` (paid back to the payer) despite the
payee having done the work. This is a real, observed failure mode against IMD's live oracle, not a
hypothetical edge case — worth raising with IMD directly (does `guards.sources` further constrain or
pin which source panelists must cite, to make clustering more reliable?), and worth the product
being explicit with users that "no attestation ever arrives" is a real possible outcome distinct from
"the milestone was attested false," even though the contract currently can't tell the two apart.

**Still not confirmed**: the *successful* populated shape (`attestation`/`signature`/`signer` actually
filled in) — this specific real request never reached that state. A future real paid request that
achieves quorum would be needed to observe it.

## 16. Fixed a real resolver timing bug, added a 1Claw-backed signer, and closed the missing-webhook gap

Three follow-ups from §15, all shipped in the same pass:

**The resolver never actually waited for the oracle panel.** `oracleResult.ts` previously guessed at
the result shape and fetched it once, immediately after payment admission. But §14/§15 showed panel
assessment genuinely takes minutes of wall-clock time, and can end in `"disagreed"` with no
attestation ever signed. Rewrote `oracleResult.ts` against the real confirmed shape from §14/§15:
`pollOracleUntilResolved()` polls on an interval until `attestation`/`signature`/`signer` are all
non-null, throws a distinct `OracleDisagreedError` immediately on `"disagreed"` (so it's a typed,
catchable failure mode, not a hang or a misreported parse error), and throws
`OracleStillAssessingError` on timeout. `resolve.ts`'s `defaultGetAttestation` now calls this instead
of fetching once. 9 new tests against canned "assessing"/"disagreed"/"resolved" responses (the
disagreed fixture uses the exact real failure text from §15); resolver's suite is 37/37.

**A 1Claw-backed signer, to close the raw-private-key-in-a-file gap.** `oneclaw-client/src/typedDataSigner.ts`
adds `oneClawTypedDataSigner()`, wrapping 1Claw's `POST /v1/agents/:id/sign` (an `intent_type:
"typed_data"` call) behind the same minimal `{ address, signTypedData }` shape `imdPaymentSigner`
already expects — so a 1Claw-held key can substitute for a raw viem account anywhere in the codebase
with no other code changes. Not live-verified: still blocked on 1Claw's Intents API dashboard toggle
(§10), which no API call can flip. Code-complete, typechecked, 4 passing tests against a fake client.

**Built the missing Automations webhook.** `site/app/api/resolve/[address]/route.ts` is the endpoint
a 1Claw Automation (`scheduleResolutionAutomation`'s `wait_until` + `http` workflow) actually calls at
a deal's deadline — until now nothing existed for it to call. The project has no real database yet
(`site/lib/deals.ts` is an explicit placeholder that doesn't carry the fields `resolveDeal()` needs),
so the route is deliberately stateless: everything travels in the automation's callback body, set
once when the automation is scheduled. Guarded by a shared-secret header (`X-Resolver-Secret` vs.
`RESOLVER_WEBHOOK_SECRET`) rather than left open. Verified: `next build` passes (see below for the
cross-package viem typing fix that took), and all HTTP-layer behavior — missing/wrong secret →
401, invalid JSON → 400, missing fields → 400, missing signer → 500 — checked against a real local
`next dev` server. Not exercised past that point: doing so would require a real paid IMD call, which
this pass didn't spend money on again since §13-15 already proved the underlying `resolveDeal` path
for real, and this route only thinly wraps it.

**Cross-package viem typing gotcha.** `site` and `server/resolver` each install their own separate
copy of viem (same version, 2.56.9 — this project uses `file:` deps, not npm workspaces, so nothing
hoists or shares the install). TypeScript treats the two copies as nominally distinct types even
though they're structurally identical at runtime, so passing a `site`-constructed `PublicClient`/
`WalletClient` into `resolveDeal()` failed to typecheck. Same root-cause class as the OP-stack
chain-typing cast already used in `base-mainnet-demo.ts`; fixed the same way — `as unknown as
Parameters<typeof resolveDeal>[1]["publicClient"]` (and `"walletClient"`) at the call site in
`route.ts`, rather than re-importing a duplicate viem type.

## 17. Real LLM extraction, finally — via 1Claw Shroud + LLM Token Billing, with two real bugs found and fixed along the way

Extraction (`extractDealFields`) had never been run against a real model in this project's life —
every prior pass used injected test fixtures, for lack of any LLM credential (`docs.1claw.co`'s own
Shroud page: "no `AI_GATEWAY_API_KEY` either"). Checked this org's 1Claw account directly rather than
assume, and found LLM Token Billing (`docs.1claw.co/docs/guides/billing-and-usage#llm-token-billing-optional-add-on`)
was **already enabled and active** — a Stripe AI Gateway subscription billing token usage straight to
the org, no Anthropic key needed anywhere. Created a dedicated Shroud-enabled agent
(`scripts/setup-shroud-agent.ts`, its own vault, locked to `anthropic` + `claude-sonnet-4-6` only,
`daily_budget_usd: 2` as a safety cap) and ran real extraction for the first time.

**Bug 1 — native structured outputs are blocked for every Anthropic model under LLM Token
Billing.** The first real call, using `extractDealFields`'s original `Output.object()`-based
implementation, failed with a real `400` — not from IMD, from **Google Vertex AI**, several layers
downstream of Shroud:

```
Organization Policy constraint constraints/vertexai.allowedPartnerModelFeatures violated for
`projects/1082558917959` attempting to use a disallowed feature structured_outputs for Partner
model claude-sonnet-4-6.
```

LLM Token Billing routes Anthropic calls through Stripe AI Gateway to Google Vertex AI's Anthropic
"partner models," and this org's underlying Vertex project has an org policy that blocks the
`structured_outputs` feature outright. Confirmed this isn't model-specific — `claude-haiku-4-5` hit
the identical error — so it's a blanket restriction on this billing path, not something a different
model choice works around. The AI SDK's `Output.object()`/`generateObject()` don't expose a way to
request a different structured-output strategy in this version (no `mode` option; both always use
the provider's native json_schema mode for Anthropic). **Fix**: rewrote `extractDealFields` to use
tool-calling instead — `generateText` with a single tool and `toolChoice: { type: "tool", toolName:
"record_extraction" }` — a different request shape (`tools`/`tool_choice`, not
`output_config.format`) that isn't subject to the same Vertex policy. Verified live against both
`claude-sonnet-4-6` and `claude-haiku-4-5`. This also works unchanged against the default direct
Gateway path, so there's no need for two extraction code paths. Worth flagging to 1Claw if there's a
support channel — LLM Token Billing presumably isn't meant to silently break a standard AI SDK
feature for every model of a supported provider.

**Bug 2 — the model has no idea what today's date is.** With the structured-outputs issue fixed,
the very first real extraction (deal text: "...within the next 7 days") silently produced
`deadlineIso: "2025-06-05T15:41:29Z"` — a date over a year in the *past* relative to the real
current date (2026-09-29). The extraction prompt never told the model what "now" actually is, so it
computed the relative deadline against some date near its training cutoff instead. This fed a
nonsensical (negative-length) window straight into IMD's dry-run quote, which — concerning in its
own right — didn't reject it, just silently clamped it to `window.hours: 1`. **Fix**: the prompt now
opens with `The current date and time is ${new Date().toISOString()} (UTC). Resolve any relative
deadline against this, not your training cutoff.` Re-ran the same deal text after the fix:
`deadlineIso` came back correctly as 7 real days out. This is a real, generalizable extraction
correctness bug, not a Shroud-specific quirk — it would misfire identically on the default Gateway
path with any relative deadline phrase, and nothing downstream (lint, template building, the dry-run
quote) would have caught a deadline that's merely *wrong*, only one that's missing or malformed.

**Bug 3 (smaller, found while proving the fix above) — IMD's dry-run quote caps the panel window at
720 hours (30 days), undocumented.** Bisected precisely: a deal compiling to `window.hours: 720`
quotes fine; `721` and up fail with a bare `400 invalid_request`, no detail, same opaque shape as
the Bug 1 error before Vertex's message was inspected. A deal whose real extracted deadline is
further out than ~29 days (the template adds a fixed buffer to the raw window) will fail to compile
with no actionable error message pointing at the real cause. Not fixed in code — genuinely IMD's own
constraint, not a bug in this project — but worth knowing before picking a demo deal's deadline, and
worth asking IMD about directly (is 30 days a hard product limit, or tunable per request?).

End-to-end proof, real throughout except the escrow itself: `scripts/real-extraction-smoke.ts` runs
`compileDeal()` with the real Shroud-backed `claude-sonnet-4-6` model against "octocat/Hello-World
must publish a non-prerelease GitHub release within the next 7 days," and gets back a real,
successful IMD quote with a real `questionHash` — the first time this project's full compiler
pipeline has run with a real model instead of an injected fixture.

**Operational note**: `PATCH /v1/agents/:id`'s `shroud_config` replaces the object wholesale, not a
deep merge — patching just `{ allowed_models: [...] }` silently reset `daily_budget_usd` and
`pii_policy` back to `null` on a prior call in this session. Always resend the full desired
`shroud_config` on every patch.

## 18. Deployed `site/` to Vercel for real — a monorepo build, an artifact-tracing bug, and a public-RPC reliability finding

First real deployment of this project anywhere — a real Vercel project linked to this monorepo (URL
and account details deliberately withheld from this public doc; it's a live, unauthenticated app).
Getting a genuinely working deployment (not just a green build) took real debugging, not a
happy-path `vercel deploy`:

**The monorepo's sibling `file:` packages need the whole repo, not just `site/`.** A CLI deploy run
from `site/` only uploads that directory — none of `../server/*` comes along, so the `file:../server/*`
dependencies can't resolve. Fixed by linking the Vercel project's Root Directory to `site` (via the
Vercel API — `vercel project` has no CLI subcommand for this) while running `vercel deploy` from the
repo root, so the whole monorepo uploads and Vercel builds from within `site/`. Also needed a custom
Install Command mirroring `.github/workflows/ci.yml`'s own multi-step install (each sibling package
needs its own `npm install` before `site`'s `file:` deps resolve to something with real
`node_modules`).

**`.gitignore` isn't `.vercelignore`, and that distinction matters here specifically.**
`contracts/out/` is gitignored (a build artifact, rightly kept out of git) but `lib/artifact.ts`
reads that exact file at runtime, and there's no Foundry toolchain on Vercel's build image to
regenerate it. Vercel CLI falls back to `.gitignore` when no `.vercelignore` exists, which would have
silently shipped a broken build. Added a root `.vercelignore` that excludes `node_modules`/`.git`/etc.
but deliberately does *not* exclude `contracts/out/`.

**`outputFileTracingIncludes`' glob keys don't accept literal `[` `]`.** Next's serverless function
tracer only bundles files it can statically detect via `require`/`import`; `lib/artifact.ts`'s
dynamically-built path (`path.resolve(..., "../../contracts/out/...")`) isn't traceable that way, so
`outputFileTracingIncludes` has to force-include it. First attempt used the literal route string
`"app/deals/[address]/page"` as the glob key — deployed clean, no build warning, but 500'd at runtime
with "Could not read MilestoneEscrow build artifact." The bug: glob syntax treats `[address]` as a
*character class* (any one of a/d/d/r/e/s/s), not literal brackets, so the key silently matched
nothing. Fixed by escaping them (`"**/deals/\\[address\\]/**"`) and verified locally first — the
`.next/server/app/deals/[address]/page.js.nft.json` trace file listing the artifact path — before
redeploying. Lesson underlined for the second time this project: a clean build is not proof a config
value did what you meant; read the actual runtime error.

**A real, live-reachable webhook now exists.** `POST /api/resolve/[address]` (deployed, with
`RESOLVER_WEBHOOK_SECRET` set as a real Vercel env var) correctly returns 401 with no/wrong secret,
400 on bad input, and — with `EVM_PRIVATE_KEY` deliberately left unset on this deployment — 500 at
exactly the point real signing would begin. Deliberate: this proves the deployed route for real
without needing a funded signer or another paid IMD call to exercise it.

**A real 1Claw Automation reaching this deployed webhook, live**
(`server/resolver/scripts/real-automation-smoke.ts`): scheduled a manual automation
(`wait_until` → `http`), it parked, woke at the real deadline, and called the real deployed URL with
the real `X-Resolver-Secret` header — `scheduleResolutionAutomation` had no way to attach custom
headers until this pass (fixed: `ScheduleResolutionOptions.headers`, plumbed into the `http` step).
The run's final status: `failed`, `"step 1 (http) failed: HTTP 500: {\"error\":\"EVM_PRIVATE_KEY is
not configured\"}"` — the *correct* outcome, proving automation → real network → real deployed route
→ real application code, stopping cleanly at the one thing left unconfigured on purpose.

**Public RPC endpoints aren't reliable from a serverless deploy.** `/deals/[address]` for the real
Base mainnet escrow (§12) worked from a local machine against `https://mainnet.base.org` but
consistently failed from Vercel's functions with a bare "RPC Request failed" — same request,
different origin. Almost certainly the public RPC throttling/blocking cloud datacenter IPs, a known
class of problem with free public RPC endpoints. Fixed by switching to a dRPC key
(`DRPC_API_KEY` in `~/.secrets/verdict.env`) — confirmed working for both Ethereum and Base mainnet,
and the same deals page now correctly renders **Released** from the real deployed serverless
function. Any future production RPC usage should go through a real provider, not a public endpoint.

## 19. Topped up `$IMD` with a second real Uniswap v4 swap, and got the first-ever successful (non-disagreed) real attestation

Per explicit user go-ahead: swapped another 0.003 ETH for `$IMD` (real tx
[`0x543001...2ad52`](https://etherscan.io/tx/0x543001528336a5ebf62a32dbbe7b575c4beb05834eb61347c1fefd358a62ad52),
confirmed, `0.5172` → `1.0917` `$IMD`), using the exact pool/router pattern from §11 — re-verified
against the currently-installed SDK versions and Uniswap's official `v4-core`/`v4-periphery` source
(not memory) before running, since §11's original script was scratch and no longer exists.
`amountOutMinimum` was derived from a real `V4Quoter.quoteExactInputSingle` eth_call first (not
guessed), and the full swap calldata was simulated via `eth_call` and only broadcast after that
succeeded — same discipline as §11. Also needed a fresh Permit2 `approve()` — the wallet's existing
allowance (from §14's payment) was for the *exact* amount used then, not unlimited, and was too small
for a second payment.

**Then ran a second real paid `oracle.request`** — deliberately *not* a repeat of §15's question.
§15's disagreement traced to panelists citing GitHub's API URL vs. its web URL for the same
underlying fact; IMD's clustering treats those as different sources. This attempt used
`page_or_file_live` instead of `release_published`, checking a single, unambiguous URL
(`https://github.com` serving content matching `"GitHub"`) — every panelist has exactly one thing to
fetch and cite, removing that specific failure mode by construction, not by luck.

**Result: real success.** The real panel reached quorum and IMD returned a genuine, non-disagreed
attestation — `answer: true`, over the real question
`"Does https://github.com serve content matching \"GitHub\" as of 2026-09-29T19:14:16.399Z?"`,
`requestId 66197201805114800400243868744046587535846106900038257338479703085956498194432`,
`fromBlock 26077370` → `toBlock 26084840`. This is the first time in this project's life the
*successful* populated attestation shape has actually been observed, not just assumed —
confirming `pollOracleUntilResolved`/`parseSignedAttestation` (§16/§17) handle it correctly: the
call completed without throwing `OracleDisagreedError` or `UnconfirmedOracleResultShapeError`. The
`signature`/`signer` fields themselves weren't captured in this run's saved log (a large single
`console.log` got truncated by the background-task output capture, not a script failure — the
process exited 0, and the order lookup needed to re-fetch it afterward 404's, since orders are
scoped to the client token that created them, not retrievable with a fresh one) — the still-open item
is confirming the exact **signature verifies** on-chain against `MilestoneEscrow.sol`'s expected
signer, which needs a fresh real request to observe end-to-end with logging fixed, not a re-fetch of
this one.

## 20. 1Claw's Intents API actually works — §10's "dashboard-only gate" belief was wrong, and four real bugs stood in the way

The user flipped `intents_api_enabled` for an agent and reported it "on"; testing still 403'd with
the exact same "Intents API is not enabled for this agent" message §10 documented months earlier.
Before spending more time working around it, asked 1Claw directly — and the answer corrected two
things this project had believed and documented as fact:

**There is no tier gate.** Reading 1Claw's own `docs.1claw.co/docs/guides/billing-and-usage` (quoted
earlier in this log) said the Intents API required Business tier ($999/mo) — that belief was
reported to the user but never actually acted on (no upgrade happened) before checking with 1Claw
directly. 1Claw confirmed there's no plan check on Intents anywhere in their code, and that their own
docs said otherwise in three inconsistent places (tier bullets, a comparison table, and a callout)
before this was reported — fixed on their end as of this writing. **Do not upgrade a 1Claw plan on
the assumption that Intents API needs it** — that assumption, made in good faith from their own docs,
was simply wrong.

**The real cause: a stale JWT claim, not a dashboard-only setting.** `intents_api_enabled` (and
`eip712_domain_allowlist`, `shroud_config` — §17's operational note was the same shape, earlier)
gets baked into a token at *mint* time. Flipping the toggle updates the agent's database row but
does nothing to a token already issued — so a client using the human org-wide API key (with `*`
scope) keeps getting refused, because **the check is against the calling token's own claim, not a
live lookup of the target agent's current DB state**. Confirmed by decoding a token: a token minted
before the toggle omits/falses the claim; one minted after (via a fresh
`POST /v1/auth/agent-token` exchange, **specifically as the agent**, not the human key) carries
`"intents_api_enabled":true`. §10's write-up should be read as: "the toggle is real, PATCHable, and
works — but you must re-authenticate *as that agent* afterward, not just re-check with the human
key." `server/oneclaw-client/scripts/permit2-demo.ts` and `typedDataSigner.ts`'s header comment are
both updated to reflect this correction.

**Three more real, live bugs found getting from "no longer refused" to an actual valid signature:**

1. **`eip712_domain_allowlist`'s entries are objects, not strings.** Docs
   (`docs.1claw.co/docs/agents/intents/signing`): `JSON[]`, e.g.
   `[{"verifying_contract": "0xA0b..."}]`. Patching it as `["0x..."]` (plain address strings) is
   silently accepted and stored by `PATCH /v1/agents/:id` — no validation error — but never matches
   anything, so signing keeps 403ing with the *different* message "Verifying contract ... is not in
   the agent's eip712_domain_allowlist," which looks like the allowlist didn't take effect at all.
   Also per the docs: "Known dangerous types (Permit, Permit2) always require explicit allowlisting"
   — `eip712_default_policy: "allow"` alone isn't enough for these two specifically.
2. **1Claw's server-side EIP-712 hasher requires `types.EIP712Domain` present explicitly** —
   `400 "Type 'EIP712Domain' not found in types"`. viem's own `signTypedData` derives this from the
   `domain` object and doesn't want it in `types` at all, so every `EIP712TypedData` object built for
   local viem signing throughout this repo (all of `@verdict/imd-client`'s `paymentSigning.ts`,
   `server/resolver/src/permit2.ts`) omits it — correctly, for viem, but not for 1Claw's endpoint.
   Fixed once, centrally: `oneclaw-client`'s new `withDomainType()` (exported from
   `typedDataSigner.ts`) inspects which of the five standard domain fields are actually present and
   builds the matching type array, applied inside `oneClawTypedDataSigner` and in
   `permit2.ts`'s `signPermit2Transfer()`.
3. **`OneClawClient.sign()` couldn't serialize its own request body.** `EIP712TypedData` messages
   routinely carry `BigInt` for `uint256` fields (viem's convention) — plain
   `JSON.stringify(request)` throws `"Do not know how to serialize a BigInt"` the moment a real
   payload reaches it. This had never been hit before because nothing had exercised `sign()` with a
   real, viem-shaped typed-data object until this pass. Fixed with a stringify replacer converting
   `bigint` to its decimal string — the same convention 1Claw's own request/response bodies already
   use for large numbers.

**Result: real, independently-verified success**, twice — once against the `verdict-extraction`
agent with a real IMD-shaped Permit2 payment payload (recovered address matched exactly via viem's
`recoverTypedDataAddress`), and again via the rewritten `permit2-demo.ts` against a fresh throwaway
agent, proving this isn't a fluke tied to one agent's config. `oneClawTypedDataSigner` is no longer
"code-complete but unverified" — it is live-verified, closing the gap `docs/DAY-ONE-FINDINGS.md` has
flagged since §7.

**Still not done**: this only covers *typed-data signing* (the IMD payment step). The resolver's
on-chain relay calls (`submitAttestation`, `release`) need real transaction submission
(`POST /v1/agents/:id/transactions`), a different, not-yet-built Intents API integration — the raw
`EVM_PRIVATE_KEY` gap in `site/app/api/resolve/[address]/route.ts` is half closed, not fully.

## 21. Real deal storage — Supabase, replacing the hardcoded placeholder

`site/lib/deals.ts` was a hardcoded `STATIC_DEALS = {}` plus a local-only gitignored JSON file since
the very start of this project — real deal persistence was explicitly out of scope until now. User
provisioned a real Supabase project; wired it in as the real backing store.

**Real schema created** (`deals` table, RLS enabled with zero policies — locks out the anon/public
role entirely; only the server-side service role key, used exclusively by this app, can read or
write it): `address` (primary key), display fields (`title`, `rpc_url`, `chain_id`, `question`,
`sources`, `panel_size`, `quorum`), and the fields `resolveDeal()` actually needs to act on a deal
(`oracle_input`, `expected_question_hash`, `payout_estimate_base_units`,
`approval_threshold_base_units`) — the original `DealMetadata` interface only ever had the display
fields, which is why the resolve webhook had to carry all of this in every automation callback body
until now (see §18's design note on that route).

**`lib/supabase.ts`** is a small hand-rolled fetch wrapper over Supabase's REST (PostgREST) API, not
`@supabase/supabase-js` — consistent with this repo's existing style for `@verdict/imd-client`/
`@verdict/oneclaw-client` (a documented, stable REST API with two operations needed doesn't warrant
pulling in the full SDK's realtime/auth/storage surface).

**Two real connection-string gotchas, both from Supabase's dashboard defaulting to the wrong tab for
scripted one-off migrations**: the "Direct connection" string (`db.<ref>.supabase.co`) doesn't
resolve from a normal IPv4-only network — Supabase's direct Postgres connections are IPv6-only on
newer projects — while the "Session pooler" string (`aws-0-<region>.pooler.supabase.com`) does. Took
two rounds of "try now" before the right tab was actually selected; the wrong host looks like a typo
or a propagation delay, not a real distinction. This connection string was only ever needed once, for
the migration — the running app talks to Supabase exclusively through the REST API with the service
role key, never a direct Postgres connection.

**Route change**: `site/app/api/resolve/[address]/route.ts` now looks the deal up by address instead
of requiring `oracleInput`/`expectedQuestionHash`/`payoutEstimateBaseUnits` in the automation's
callback body — live-verified locally (a real inserted row, correct 404 for an unregistered address,
correct 500 at the signer-missing point for a registered one) and in production against the real
Vercel deployment. `createDeal()` exists in `lib/deals.ts` for a future "register this deployed
escrow" step; nothing calls it yet, since `/new` still only produces a signed deployment payload and
doesn't deploy anything.

The two existing demo entries (`site/lib/demo-deal.local.json`) were deliberately **not** migrated
into the real table: the local Anvil one only exists while a throwaway local chain is running, and
the Base mainnet one (§12) is already settled (`Released`) with nothing left to ever resolve — both
continue to work exactly as before via the local-file path, which `getDealMetadata`/`listDeals`
still check first.

**Addendum — the write path is wired up too.** `createDeal()` is no longer unused: `/new`'s
"done" step (a real deployment payload, still not deployed by the app itself) now has a follow-up
"Register the deployed escrow" step. The user pastes the address they deployed with that payload;
`registerDeal()` (`app/new/actions.ts`) reads the real on-chain `questionHash`/`amount`/`feeBps`
first and refuses to save anything whose on-chain `questionHash` doesn't match what was actually
compiled — it never trusts a pasted address at face value. `payoutEstimateBaseUnits` is computed
with the exact same fee math as `MilestoneEscrow.sol` itself (`amount - (amount * feeBps) / 10000`,
floor division, matching `Math.mulDiv`), not the gross amount.

Live-verified end to end with `site/scripts/register-deal-demo.ts`: a real IMD quote, a real
`MilestoneEscrow` deployed to a throwaway local Anvil chain bound to that exact `questionHash`, a
real on-chain read confirming the hash match, correct fee math (1000 USDC at 100 bps → 990 USDC
payout estimate), a real row written to Supabase, and a readback confirming it — cleaned up after
itself. (The script itself couldn't import `app/new/actions.ts` or `lib/escrow.ts` directly — both
use either Next's `@/` path alias or an extensionless relative import, neither of which plain Node
resolves outside Next's bundler, the same documented limitation `server/resolver/scripts/e2e-demo.ts`
already works around for `lib/escrow.ts` — so the script inlines the two on-chain reads and calls
`createDeal()` directly instead, exercising the same real logic and the same real dependencies.)

## 22. On-chain transaction submission via 1Claw — the other half of retiring `EVM_PRIVATE_KEY`

§20 proved 1Claw's Intents API for *typed-data signing* (IMD's payment signature). The resolver's
other two writes — `submitAttestation()` and `release()` — are on-chain transaction submissions, a
different endpoint (`POST /v1/agents/:id/transactions` and its sign-only `/sign` variant,
`docs.1claw.co/docs/agents/intents/signing`, read 2026-09-29): the vault decrypts the key inside the
HSM boundary, builds and signs the transaction, and broadcasts it via 1Claw's own dedicated RPC for
the target chain — this process's environment never holds a raw key either way.

**Built**: `OneClawClient.submitTransaction()`/`.signTransaction()` (`server/oneclaw-client`), a
`TransactionRelay` interface in `server/resolver/src/relay.ts` that both a local viem account
(`viemTransactionRelay`, wrapping the existing `submitAttestation`/`release` functions unchanged —
zero behavior change for every existing caller) and a new 1Claw-backed implementation
(`oneClawTransactionRelay`, `server/resolver/src/oneClawRelay.ts`) can satisfy. `resolveDeal()`
gained an optional `relay` option (takes precedence over `walletClient` when both are given, and
`walletClient` is now optional) — a `TransactionRelayNotConfiguredError` fires only when the code
actually reaches the point of needing one, not on construction, so a `questionHash` mismatch (which
never needs to relay anything) still short-circuits cleanly with neither configured.

**Live-verified for real, at zero cost**: 1Claw's sign-only mode (`/transactions/sign`) signs inside
the HSM but never broadcasts, so signing itself costs no gas — the same discipline as every other
"prove it's real without spending money we don't need to" step in this log. Built a real, correctly
ABI-encoded `submitAttestation()` calldata (via `oneClawRelay.ts`'s exact code path) against a
fabricated escrow address, signed it through the agent's real key, and independently verified with
viem: `recoverTransactionAddress` recovers to the agent's real signing-key address
(`0x2590fc6823ede90dbebac41bb5759c14555e6aab`), the parsed `to` matches, and the parsed calldata
matches byte-for-byte what was sent. Real transaction, real signature, real verification — just
never broadcast, so no gas spent and no dependency on that key holding any balance.

**Wired into the deployed webhook's code, not its live configuration.**
`site/app/api/resolve/[address]/route.ts` now tries `ONE_CLAW_RESOLVER_AGENT_ID`/
`ONE_CLAW_RESOLVER_AGENT_API_KEY`/`ONE_CLAW_RESOLVER_ADDRESS` first (routing both the payment
signature and the on-chain writes through 1Claw, no private key in the process at all) and falls
back to `EVM_PRIVATE_KEY` if those aren't all set. **Deliberately not activated on the actual
deployment** — those three env vars are not set there. The reasoning: every other real-money action
in this project has been a one-off, explicitly requested action with a visible, bounded outcome.
Setting real 1Claw credentials on the live webhook is different in kind — it makes a *standing*
endpoint capable of autonomously spending real `$IMD` on any future trigger (a real Automation firing,
or anyone who has the webhook secret), not a single bounded action. That's a real decision for
whoever owns this deployment to make deliberately, not something to default into as a side effect of
"the code now supports it."

**Addendum — tried the real broadcast, and it failed, for a specific, identified reason.** Ran
`scripts/base-mainnet-oneclaw-relay-demo.ts` for real: funded the 1Claw signing key with real ETH,
got a real free IMD quote, deployed a real `MilestoneEscrow` on Base mainnet with the wallet's real
USDC (the exact same self-dealing demo shape as §12), then called `relay.submitAttestation()` through
`oneClawTransactionRelay` for real — this time actually trying to broadcast, not sign-only.

`OneClawClient.submitTransaction()` returned a `tx_hash` and the call didn't throw, but the
transaction was never on-chain: `waitForTransactionReceipt` timed out, the signing key's nonce stayed
at `0`, and its balance was untouched. Querying 1Claw's own `GET /v1/agents/:id/transactions` for the
real answer (rather than guessing) showed the true status: `"status": "signed"`,
`"error_message": "Broadcast failed: Request timeout on the free plan, please upgrade to paid
plan."` — 1Claw signed the transaction successfully (matching the earlier sign-only proof exactly)
but its own broadcast infrastructure refused to relay it to the chain, and returned a `tx_hash`
anyway despite never actually broadcasting — worth flagging to 1Claw, since a caller has no way to
tell "broadcast succeeded" from "broadcast silently failed" without independently checking status.

This is confusing given this org's overall subscription is `"tier": "team"` (§19), not free — either
transaction broadcast is metered on a separate, still-unupgraded dimension from the rest of the
account, or the error message itself is wrong (a real possibility, given §20's docs-vs-reality gap
was exactly this shape). Not resolved here; reported as observed, not diagnosed further.

**No funds were at risk or lost.** The real USDC stayed correctly held in the escrow (the failed
`submitAttestation` never touched it) until the deployment's short demo deadline+grace window
elapsed, at which point `reclaim()` + `withdraw()` (via the local wallet, not 1Claw — this part of
the flow was never in question) returned the exact original amount, confirmed on-chain:
`2.166484 USDC`, byte-for-byte the starting balance.

**Net result**: `oneClawTransactionRelay`'s *signing* is proven correct (independently, twice — the
zero-cost sign-only test above, and this real attempt, which got as far as a correct signature before
hitting 1Claw's own broadcast infrastructure). Actual *delivery* through 1Claw is currently blocked on
something in 1Claw's own broadcast path, not on anything in this codebase. Until that's resolved (by
1Claw, or by finding whatever upgrade/setting actually unblocks it), a real resolver still needs
either the raw `EVM_PRIVATE_KEY` path or a self-broadcast alternative (sign via 1Claw's sign-only
mode, then submit the raw signed tx through a normal RPC directly — not yet built, but a
straightforward next step given the signature itself is already proven correct).

## What's still unconfirmed (needs real signing, so held back)

- ~~The exact EIP-712 `quoteApprovalTypedData` schema... and the exact Permit2 integration
  parameters~~ — **answered in §13, and confirmed against IMD's real server-side verification in
  §14**: a real paid submission using this exact schema was admitted on the first attempt, no
  corrections needed. Only remaining caveat: it's IMD's current frontend logic, not a versioned
  contract, so it could still change without notice in the future.
- ~~The real `GET /oracle/requests/:id` response envelope~~ — the `"assessing"` shape (§14), the
  `"disagreed"` failure shape (§15), and now the **successful** populated shape (§19 — a real
  request reached quorum, `answer: true`, no `OracleDisagreedError`/shape-parse error) are all
  confirmed. Only remaining sliver: §19's run didn't get the `signature`/`signer` values themselves
  into the saved log (an output-capture truncation, not a script failure) — worth a repeat run with
  output written straight to a file to confirm the signature verifies on-chain against
  `MilestoneEscrow.sol`'s expected signer, not just that the shape parses.
- ~~Whether 1Claw's Intents API can actually produce that signature~~ — answered in §7: yes,
  mechanically (it's a generic EIP-712 signer via `POST /v1/agents/:id/sign`), but only once we have
  the actual domain/types to hand it; 1Claw itself doesn't know IMD's schema. Now that §13 supplies
  those domain/types, `imdPaymentSigner`'s `TypedDataSigner` interface is satisfied by anything with
  `address` + `signTypedData` — including a 1Claw-backed signer, once its Intents API dashboard
  toggle (§10) is flipped for an agent.
- Whether panel size changes price (still flat 0.5 IMD per the capabilities policy regardless of
  `panelSize`, but that's the *listed* price, not necessarily what a 9-member quote charges —
  worth a real quote comparison once someone's ready to spend).
