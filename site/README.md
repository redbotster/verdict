# Verdict status site

The per-deal status page from `docs/SPEC.md`: "A status page per deal ... shows the deal terms,
escrow balance, question text and status." Next.js App Router, read-only, server-rendered.

## Pages

- `/` — lists known deals.
- `/deals/[address]` — one deal's status: the compiled question (sources, quorum, question hash),
  deal terms read live from the contract (payer, payee, amount, fee, deadline, grace, oracle signer),
  and live status (state, escrow balance, challenge window, unwithdrawn `owed` balances per party).
  `force-dynamic` — deal state changes on-chain, so nothing here is statically cached.
- `/new` — the spec's dual-approval flow: a form compiles a real question against the live IMD API
  (`app/new/actions.ts`, a Server Action — IMD's paid routes refuse cross-origin browser calls, so this
  has to run server-side), then the payee connects a browser wallet, the payer connects and signs the
  exact `EscrowTerms` authorization the contract's constructor checks (`lib/terms.ts` — the same
  scheme as `scripts/deploy-demo.ts` and `server/resolver`, verified to match), and the payee signs an
  off-chain acknowledgment. From there it can actually deploy: the payer's wallet approves a
  nonce-predicted escrow address for the token spend, then deploys the real contract (bytecode from
  the real Foundry artifact via `getDeploymentArtifact()`, never hand-duplicated), which pulls the
  funds in immediately via its constructor — the same approve-then-deploy sequence as
  `scripts/deploy-demo.ts`, just with the payer as both approver and deployer instead of a separate
  deployer account. `scripts/deploy-self-service-test.ts` proves this exact sequence (same
  `lib/artifact.ts` loaders, same nonce-prediction math) against a local Anvil chain, and it's also
  been proven with a real click-through of the actual UI — a real dev server, a real page, an injected
  `window.ethereum` forwarding to real signing, driven through the real React click handlers, not a
  script calling viem directly (see `docs/DAY-ONE-FINDINGS.md` §23's addendum). Deploying is optional:
  paste an address deployed elsewhere directly into the "register" step instead.
- `/api/resolve/[address]` — the webhook a 1Claw Automation calls at a deal's deadline; looks the
  deal up in Supabase by address and runs `resolveDeal()` server-side, preferring a 1Claw-backed
  signer over a raw `EVM_PRIVATE_KEY` when configured (§22). Guarded by a shared secret
  (`X-Resolver-Secret` vs. `RESOLVER_WEBHOOK_SECRET`). Live-verified end to end by a real deployed
  Automation — see `docs/DAY-ONE-FINDINGS.md` §18.

## The `/new` flow needs its sibling packages as real dependencies, not just relative-path reads

`app/new/actions.ts` imports `@verdict/imd-client` and `@verdict/oracle-compiler` — installed as local
`file:` dependencies (`npm install ../server/oracle-compiler ../server/imd-client`, symlinked into
`node_modules/@verdict/*`), not by digging into `contracts/out/` the way `lib/escrow.ts` and
`lib/artifact.ts` read the contract ABI. That distinction matters: a JSON file read via `fs` at
runtime doesn't care where it physically lives, but a real module import does, and Turbopack refused
it twice before this actually worked:

1. A relative import reaching outside `site/` (`../../../server/...`) fails outright — Turbopack only
   resolves files at or below the Next project directory, even via a symlink that points outside it.
2. Pointing `next.config.ts`'s `turbopack.root` at the actual monorepo root fixes resolution, but the
   project-wide `next build` TypeScript pass then needs `allowImportingTsExtensions` in `tsconfig.json`
   too, since it now also type-checks `oracle-compiler`'s and `imd-client`'s own `.ts`-extension
   internal imports.
3. Deep subpath imports (`@verdict/oracle-compiler/src/lint.ts`) still didn't resolve even with `root`
   set — switched both packages to real barrel exports (`src/index.ts`, referenced via each
   package.json's `main`) and import only the bare specifiers.

`serverExternalPackages` in `next.config.ts` is also set for both — not load-bearing for the fix
above, but correct anyway, since neither package needs bundling (they use `node:crypto`, `node:fs`)
and both are server-only.

## Where the data comes from

- **On-chain** (`lib/escrow.ts`): read live via viem, straight from the contract's own getters. The
  ABI is read from the Foundry build artifact (`lib/artifact.ts`), same pattern as `server/resolver`
  — never hand-duplicated, so it can't drift from what's actually deployed. Requires `forge build` to
  have run in `contracts/` first.
- **Off-chain** (`lib/deals.ts` + `lib/supabase.ts`): the question text, sources, quorum, and (for a
  deal the resolve webhook still needs to act on) `oracleInput`/`expectedQuestionHash`/
  `payoutEstimateBaseUnits` live in a real Supabase Postgres table (`deals`, RLS enabled with zero
  policies — only the server-side `SUPABASE_SERVICE_ROLE_KEY` can read/write it; no Supabase Auth in
  this app, so anon-key/user-scoped RLS policies don't apply). `lib/supabase.ts` is a small hand-rolled
  fetch wrapper over Supabase's REST (PostgREST) API, not `@supabase/supabase-js` — matching this
  repo's existing style for `@verdict/imd-client`/`@verdict/oneclaw-client`, and there's nothing here
  that needs the full SDK's realtime/auth/storage surface. `lib/demo-deal.local.json` (gitignored)
  still layers local-only entries on top for local dev — a local Anvil demo, ephemeral by nature, so
  it's never written into the persistent table.

  `/new`'s "Register the deployed escrow" step writes to it for real: paste the address (or use the
  one the deploy step above just filled in), and `registerDeal()` (`app/new/actions.ts`) reads its real
  on-chain `questionHash`/`amount`/`feeBps`, refuses to save anything whose on-chain `questionHash`
  doesn't match what was actually compiled, computes the fee-adjusted payout estimate with the same
  math as `MilestoneEscrow.sol` itself, and writes the row — this step works the same whether the
  escrow was deployed via `/new` itself or elsewhere. Live-verified end to end with
  `scripts/register-deal-demo.ts` — see `docs/DAY-ONE-FINDINGS.md` §21. It also takes an optional
  "approval threshold" — `resolveDeal()` defaults every deal to needing manual settlement above `0`
  base units (no automated approval gate is wired up, see §24), so an operator explicitly opts a deal
  into auto-settlement by setting this at or above the deal's own payout, rather than that being an
  invisible default nobody could see or change.

## Demo deal, for local development

```
npm run deploy-demo   # deploys a real MilestoneEscrow + MockUSDC to a throwaway local Anvil chain,
                       # settles it to Released, and writes lib/demo-deal.local.json (gitignored)
npm run dev            # then visit the URL it prints
```

This is a genuine on-chain deployment (not a mock) — the page you see is reading real contract state
over RPC, the same code path it'll use against a real Sepolia deployment later. The script prints the
Anvil PID; kill it when you're done (`kill <pid>`).

## Deployment (Vercel)

Live on Vercel — the exact URL is deliberately not published in this public repo (`/new` and the
Supabase writes it triggers are unauthenticated by design; only the resolver webhook checks a
secret). Getting it actually working (not just a green build) needed several things a default
`vercel deploy` from `site/` doesn't do — full story in `docs/DAY-ONE-FINDINGS.md` §18:

- The Vercel project's **Root Directory** is set to `site` (via the API — no CLI subcommand for it),
  but `vercel deploy` runs from the **repo root**, so the whole monorepo uploads and the sibling
  `file:` packages (`../server/*`) are actually present on disk at build time.
- A root **`.vercelignore`** (not `.gitignore` — they diverge on purpose here) keeps
  `contracts/out/` in the upload, since `lib/artifact.ts` needs that exact build artifact at runtime
  and there's no Foundry toolchain on Vercel's build image to regenerate it.
- A custom **Install Command** installs each sibling package's own `node_modules` before `site`'s —
  the same multi-step install `.github/workflows/ci.yml` already does, for the same reason.
- `next.config.ts`'s `outputFileTracingRoot`/`outputFileTracingIncludes` force-include
  `contracts/out/MilestoneEscrow.sol/*.json` in the `/deals/[address]` function's bundle, since
  `lib/artifact.ts`'s dynamically-built path isn't traceable automatically. The glob key needs
  `[address]`'s brackets escaped (`\\[address\\]`) — unescaped, they're glob character-class syntax,
  not literal brackets, and the include silently matches nothing.
- Real env vars set on the deployment: `RESOLVER_WEBHOOK_SECRET` (the webhook's auth),
  `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (real deal storage — see "Where the data comes from"
  above), and — as of 2026-09-29, activated explicitly on request —
  `ONE_CLAW_RESOLVER_AGENT_ID`/`_AGENT_API_KEY`/`_ADDRESS`. The webhook now routes both the payment
  signature and the on-chain writes through 1Claw (via `oneClawSignAndBroadcastRelay`, proven to
  actually deliver a transaction — see `docs/DAY-ONE-FINDINGS.md` §22), falling back to
  `EVM_PRIVATE_KEY` if those three aren't all set (they are). No `EVM_PRIVATE_KEY` is set on this
  deployment — the live webhook never holds a raw private key. Activating the 1Claw path was a real,
  deliberate decision (it makes a standing endpoint able to spend real `$IMD`/gas on any future
  trigger), made only after being asked separately from the general instruction to fix other things.
- `lib/demo-deal.local.json`'s Base mainnet entry uses a dRPC key, not the public `mainnet.base.org` —
  the public endpoint works fine locally but was consistently rejected from Vercel's serverless IPs.

## What this doesn't do

`/deals/[address]` is read-only by design — submitting an attestation, calling `release()`/
`reclaim()`, or withdrawing happens through `server/resolver` or directly on-chain, not from a form
here. `/new` can now deploy the escrow itself (see above), proven both at the mechanism level (local
Anvil, `scripts/deploy-self-service-test.ts`) and with a real click-through of the actual UI (real dev
server, real page, an injected `window.ethereum`, driven through the real React click handlers — see
`docs/DAY-ONE-FINDINGS.md` §23's addendum). The one remaining gap is a real MetaMask-style extension's
own confirmation-popup UX, which this doesn't exercise. Its `oracleSigner` field is still a form input
the operator must fill in correctly — IMD's real
attestation signer address has never been confirmed (see `docs/DAY-ONE-FINDINGS.md`), so there's
nothing to default it to yet. Wallet interaction is a raw EIP-1193 `window.ethereum` call via viem's
`custom` transport, not a full wallet-connect library (RainbowKit, wagmi) — fine for one form, would
need revisiting for a real multi-wallet product surface.

## Local setup

```
(cd ../server/oracle-compiler && npm install)   # app/new needs its ai/zod deps resolvable — see above
npm install
npm run lint
npm run build   # runs its own TypeScript check internally — see note below
```

Run `npm run build` (or `npm run dev`) at least once before `npm run typecheck` on a fresh checkout:
Next generates ambient types (`LayoutProps`, etc.) into `.next/types/` during build/dev, so a bare
`tsc --noEmit` fails on a checkout that's never been built. This is also why CI's `site` job doesn't
run a standalone typecheck step — `next build`'s internal check covers it.
