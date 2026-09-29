# Verdict

[![CI](https://github.com/redbotster/verdict/actions/workflows/ci.yml/badge.svg)](https://github.com/redbotster/verdict/actions/workflows/ci.yml)

Oracle-settled milestone escrow on IMD + 1Claw. Full product spec: [docs/SPEC.md](docs/SPEC.md).
Live-API day-one findings (read this before writing more integration code):
[docs/DAY-ONE-FINDINGS.md](docs/DAY-ONE-FINDINGS.md).
Contract security audit — 3 High + 3 Medium + 5 Low + 1 Info, **all fixed**, plus a Slither
static-analysis pass: [audits/2026-09-28/AUDIT-REPORT.md](audits/2026-09-28/AUDIT-REPORT.md).
Still not a substitute for a paid human audit before any mainnet deployment — see the report's
closing note.
**End-to-end proof** that the pieces actually compose (not just pass their own tests):
[`server/resolver/scripts/e2e-demo.ts`](server/resolver/README.md#end-to-end-demo-scriptse2e-demots)
compiles a real question against the live IMD API, deploys the real contract bound to IMD's actual
`questionHash`, and relays/settles it — real at every step except the one that costs real money.

## Layout

- `contracts/` — Foundry project: `MilestoneEscrow.sol` and its test suite.
- `server/imd-client/` — the server-side IMD paid-request client (the 8-step handshake), free steps
  implemented and confirmed against the live API; the Permit2/quote-approval signing step is
  intentionally left unimplemented pending IMD's real signing schema (see findings doc).
- `server/oracle-compiler/` — the English-deal-to-oracle-question compiler: extract → match a vetted
  template → lint → free dry-run quote. All three templates now live-verified against `api.imd.fun`.
- `server/oneclaw-client/` — the server-side client for 1Claw's real Vaults/Agents Human API
  (`api.1claw.co`, confirmed live 2026-09-29 — the real domain is `1claw.co`, not `1claw.ai`; see
  findings doc §7). Covers the "vault side": vaults, secrets, agents, policies. Deliberately does not
  cover 1Claw's Intents API (typed-data signing) — that's parked pending IMD's own payment schema.
- `server/resolver/` — the agent that acts at a deal's deadline: relays the signed attestation and
  settles the escrow. Chain interaction is real and integration-tested against the actual compiled
  contract on a local Anvil chain; `src/vaultSecrets.ts` optionally persists the per-deal IMD token in
  a 1Claw vault instead of a raw env var. The IMD payment-signing and oracle-result-fetching steps are
  stubbed pending the same unconfirmed schemas noted above.
- `site/` — Next.js App Router. The per-deal status page (`/deals/[address]`), read-only,
  server-rendered directly from live contract state via viem; and `/new`, the spec's dual-approval
  flow — compile a real question against the live IMD API, payee connects, payer signs the exact
  on-chain authorization, payee acknowledges, get a ready-to-deploy payload. Both verified in a real
  browser, not just built and assumed to work.

## Status

This is scaffolding from an initial pass, not a finished MVP — see the build plan in the spec for
the full six-week shape. What exists right now:

- Project structure and the full spec/findings docs.
- A dedicated ops/resolver wallet, freshly generated, stored at `~/.secrets/verdict.env` (never
  committed). No longer unfunded: `0xF57CfAF1f2b12E7f23C342c4fAfd675379840668` holds real ETH on
  both Base mainnet (~$5) and Ethereum L1 mainnet (0.01 ETH), confirmed on-chain 2026-09-29 — see
  "What's deliberately not done yet" below for what that does and doesn't unblock.
- `MilestoneEscrow.sol` + Foundry tests (56/56 passing, up from the original 36). A follow-up security
  audit plus a Slither pass (see above) found and fixed every issue raised: the payer signs the exact
  deal terms rather than trusting a predicted deploy address, non-standard tokens are rejected at
  construction, settlement is pull-payment and sweeps any surplus balance, attestations are bound to
  the deadline with freshness ordering, the challenge window now lets a fresher oracle-signed
  correction actually override a wrong `true`, constructor timing/recipient params are sanity-checked,
  and the fee math uses overflow-safe `mulDiv`. Nothing outstanding from either review.
- The IMD client's free-tier operations (capabilities, quote, challenge, status, polling). Two latent
  bugs found and fixed while building the compiler below: `ImdApiError`/`ImdClient` used TypeScript
  parameter-property shorthand, which Node's native type-stripping can't parse — neither class had
  ever actually been constructed at runtime until the compiler did it.
- `server/oracle-compiler/`: extraction (LLM, structured output), the three template builders, lint,
  and `compileDeal()`'s free dry-run against IMD — see its own README for what's live-verified vs.
  not. Building it surfaced a real product-design correction: `consumer` doesn't affect
  `questionHash` (see `docs/DAY-ONE-FINDINGS.md` §5), which simplified the intended two-phase
  compile/pin design down to "compile already gives you the binding hash." Its third and last
  template (`onchain_event`) is now live-verified too — the spec's own table lists
  `guards: { toleranceBps: 0 }` for it, but that field causes a bare 400 on the real API regardless of
  anything else in the body; found by bisecting a known-working body field by field
  (`docs/DAY-ONE-FINDINGS.md` §6). Fixed to use `sources`/`minSources` like the other two templates.
- Both `imd-client` and `oracle-compiler` now have `npm run typecheck` (`tsc --noEmit`) — Node's
  native TypeScript execution only strips types, it doesn't check them, which is how a template
  builder silently omitting the required top-level `chainId` field went undetected until a live
  smoke test caught it as a bare `400` with no detail.
- `server/resolver/`: on-chain relay (`submitAttestation`/`release`/`reclaim`/`withdraw`) built on
  viem, reading the ABI straight from the Foundry build artifact so it can't drift from what's
  actually deployed. A real Anvil integration test deploys the actual compiled contract, signs a real
  EIP-712 attestation and a real payer-authorization signature, and relays both through this package's
  own code — full loop: submit → challenge-window elapses → release → payee withdraws. Threshold-based
  human-approval gating is implemented and tested; the actual IMD payment-signing and
  oracle-attestation-fetch steps are stubbed (same "don't guess at an unconfirmed schema" pattern as
  `imd-client`'s `pay()`).
- `site/`: the `/deals/[address]` status page, reading deal terms, live status, and owed balances
  straight from the contract (ABI from the Foundry artifact, same no-drift pattern as the resolver).
  `npm run deploy-demo` deploys a real escrow to local Anvil and settles it, so the page was actually
  checked against genuine on-chain state in a real browser (screenshots, zero console errors, correct
  numbers on both the list page and a settled deal page).
- `site/app/new/`: the dual-approval flow — a real Server Action compiles a question against the live
  IMD API, using structured form input instead of LLM extraction (no key available), so it calls
  `oracle-compiler`'s template builder directly rather than going through `compileDeal()`'s extraction
  step. Then a browser wallet (raw EIP-1193 via viem, no wallet-connect library) signs the exact
  `EscrowTerms` authorization the contract's constructor checks. Verified end-to-end in a real browser, including a simulated wallet since no
  extension is available headlessly. Getting `site/` to import its sibling packages as real
  dependencies (not just read `contracts/out/`'s JSON, which it already did) surfaced a genuine
  Turbopack constraint worth knowing about elsewhere in a monorepo: it refuses to resolve a relative
  import that reaches outside the Next project directory, even through a symlink, and
  `serverExternalPackages` alone doesn't fix that — needed `next.config.ts`'s `turbopack.root` pointed
  at the actual monorepo root, `allowImportingTsExtensions` in `tsconfig.json`, and switching both
  sibling packages from deep subpath imports to real barrel exports (`src/index.ts` via each
  package's `main`). See `site/README.md` for the full account.
- The full pipeline, tied together for real: `server/resolver/scripts/e2e-demo.ts` compiles a deal
  through the live IMD API, deploys the real contract bound to the real resulting `questionHash`, and
  runs it through `resolveDeal()`'s real relay/settle logic — proving compile → deploy → resolve
  actually composes, with only the paid oracle-attestation step faked (see above).
- `server/oneclaw-client/`: a real client for 1Claw's Vaults/Agents Human API (`api.1claw.co`),
  built against docs read live on 2026-09-29 (not memory) — vaults, secrets, agents, policies, all
  typed and typechecked. `resolver/src/vaultSecrets.ts` wires it in as an optional per-deal IMD-token
  store (spec's `imd/orders/<deal>` vault path). **Live-verified end to end**, not just typechecked:
  `npm run live-smoke` runs the full golden path (vault → secret → agent → policy → agent-scoped
  fetch) for real against `api.1claw.co`, self-cleaning. Getting there surfaced real findings, all in
  `docs/DAY-ONE-FINDINGS.md` §7–9: the real domain is `1claw.co`, not `1claw.ai` (an unrelated Chinese
  product); 1Claw's Intents API is a generic EIP-712 signer with no special knowledge of IMD's schema,
  so it doesn't unblock the Permit2/quote-approval gap on its own (still parked); and the live API's
  agent/vault binding behavior diverges from `docs.1claw.co`'s own reference page for `POST
  /v1/agents` in two ways — an undocumented required `vault_ids` field, and the docs' own example
  passing `scopes` explicitly in a way that actually breaks policy-derived secret access.
- CI (`.github/workflows/ci.yml`), green: `forge test` for the contracts, `tsc --noEmit` +
  `node --test` for each server package, lint + a full `next build` for the site. Getting there
  caught three real bugs, none of which a local "fresh clone" dry run had caught, because that dry
  run reused one clone across every job and ran everything on an already-warm local machine — real
  CI isolates each job's checkout completely and has different timing, which is exactly what exposed
  all three: (1) a bare `tsc --noEmit` on `site/` fails on a first-time checkout, since Next only
  generates its ambient types (`LayoutProps`, etc.) during a build or dev run — `next build`'s
  internal check covers it instead; (2) `resolver`'s typecheck needs `oracle-compiler`'s
  `node_modules` installed too, because `scripts/e2e-demo.ts` (in the typecheck scope) imports
  `compile.ts`, which pulls in `extract.ts`'s `ai`/`zod` deps, even though `resolve.ts` itself and
  the test suite only use type-only imports from `oracle-compiler`; (3) a genuine TOCTOU race in
  every "deploy a token, mint, predict the escrow's CREATE address" script — `mint` and `approve`
  were awaited only for submission, not mining, before something depended on them having happened.
  Anvil auto-mines fast enough that this never once surfaced in dozens of local runs; a loaded CI
  runner's different timing hit it on the very first real run. All three only surfaced by actually
  watching the real run on GitHub (`gh run watch`) rather than trusting a local approximation of it.

What's deliberately not done yet, because it costs real money or needs information this pass
couldn't get:

- Any real `workflow.open` or `oracle.request` payment (real IMD tokens, on Ethereum mainnet).
- 1Claw's Intents API (typed-data signing) and Automations (cron-triggered resolver runs) —
  intentionally parked; only the vault/secrets side is built (see above).
- Extraction has not been run against a real LLM (no Gateway API key available this pass) — everything
  downstream of it is tested by injecting a fixed extraction directly.
- Deploying `MilestoneEscrow.sol` to any real chain. The ops wallet now holds real ETH on both Base
  mainnet (~$5) and Ethereum L1 mainnet (0.01 ETH, sent 2026-09-29) — enough gas for a deployment or
  transactions on either chain, but the wallet still holds **zero `$IMD` tokens** (checked on-chain),
  so even the L1 ETH doesn't unblock a real IMD purchase — that needs the actual `$IMD` ERC-20, not
  just ETH for gas. No contract has been deployed with any of it yet — the audit's closing note (no
  paid human audit performed) still applies before any real-money deployment.

## Local setup

```
cp .env.example .env   # fill from ~/.secrets/verdict.env (wallet + ONE_CLAW_API_KEY)
cd contracts && forge test
```
