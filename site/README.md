# Verdict status site

The per-deal status page from `docs/SPEC.md`: "A status page per deal ... shows the deal terms,
escrow balance, question text and status." Next.js App Router, read-only, server-rendered.

## Pages

- `/` — lists known deals.
- `/deals/[address]` — one deal's status: the compiled question (sources, quorum, question hash),
  deal terms read live from the contract (payer, payee, amount, fee, deadline, grace, oracle signer),
  and live status (state, escrow balance, challenge window, unwithdrawn `owed` balances per party).

Both routes are `force-dynamic` — deal state changes on-chain, so nothing here is statically cached.

## Where the data comes from

- **On-chain** (`lib/escrow.ts`): read live via viem, straight from the contract's own getters. The
  ABI is read from the Foundry build artifact (`lib/artifact.ts`), same pattern as `server/resolver`
  — never hand-duplicated, so it can't drift from what's actually deployed. Requires `forge build` to
  have run in `contracts/` first.
- **Off-chain** (`lib/deals.ts`): the question text, sources, and quorum aren't on-chain (only
  `questionHash` is) — for now this is a small in-repo registry keyed by escrow address, meant to be
  populated from `server/oracle-compiler`'s `compileDeal()` output. **No real deals exist yet** —
  real deployment is blocked on IMD's unconfirmed payment-signing schema (see
  `docs/DAY-ONE-FINDINGS.md`). A real datastore is future work, not needed for this milestone.

## Demo deal, for local development

```
npm run deploy-demo   # deploys a real MilestoneEscrow + MockUSDC to a throwaway local Anvil chain,
                       # settles it to Released, and writes lib/demo-deal.local.json (gitignored)
npm run dev            # then visit the URL it prints
```

This is a genuine on-chain deployment (not a mock) — the page you see is reading real contract state
over RPC, the same code path it'll use against a real Sepolia deployment later. The script prints the
Anvil PID; kill it when you're done (`kill <pid>`).

## What this page does not do

It's read-only by design. Submitting an attestation, calling `release()`/`reclaim()`, or withdrawing
happens through `server/resolver` or directly on-chain — not from a form here. The spec's "dual
approval" step (both parties reviewing the pinned question before funding) also isn't built here yet;
this page shows a deal's status *after* the terms are already settled, not the approval flow itself.

## Local setup

```
npm install
npm run lint
npm run build   # runs its own TypeScript check internally — see note below
```

Run `npm run build` (or `npm run dev`) at least once before `npm run typecheck` on a fresh checkout:
Next generates ambient types (`LayoutProps`, etc.) into `.next/types/` during build/dev, so a bare
`tsc --noEmit` fails on a checkout that's never been built. This is also why CI's `site` job doesn't
run a standalone typecheck step — `next build`'s internal check covers it.
