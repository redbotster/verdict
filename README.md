# Verdict

[![CI](https://github.com/redbotster/verdict/actions/workflows/ci.yml/badge.svg)](https://github.com/redbotster/verdict/actions/workflows/ci.yml)

Oracle-settled milestone escrow, built on [IMD](https://imd.fun) and [1Claw](https://1claw.co).
Payer and payee agree on a deal in plain English. It compiles into a question IMD can verify. Funds
sit in an on-chain escrow until IMD's oracle answers true or false, and a resolver relays that
answer and settles the contract.

Spec: [docs/SPEC.md](docs/SPEC.md). Findings log: [docs/DAY-ONE-FINDINGS.md](docs/DAY-ONE-FINDINGS.md)
— read this before touching integration code, it's what's actually confirmed against the live APIs,
not what's assumed. Audit: [audits/2026-09-28/AUDIT-REPORT.md](audits/2026-09-28/AUDIT-REPORT.md), 3
High + 3 Medium + 5 Low + 1 Info, all fixed. Still not a substitute for a paid human audit before
anything real.

## How it works

1. `server/oracle-compiler` turns a plain-English deal into a binding IMD question (`questionHash`),
   picking from three templates (GitHub release published, page/file content, on-chain transfer).
2. `contracts/MilestoneEscrow.sol` holds the payer's funds against that `questionHash` and IMD's real
   oracle signer, with a deadline, grace period, and challenge window.
3. `site/` lets both parties review and approve the compiled question, then deploy and register the
   escrow.
4. `server/resolver` fires at the deadline, buys a real IMD attestation, verifies its signature and
   `questionHash` against the deployed escrow, and calls `release()` or `reclaim()`.
5. Signing goes through `server/oneclaw-client` (1Claw) for both IMD's payment authorization and the
   resolver's on-chain writes — no raw private key required end to end.

The full loop has been run for real, on Ethereum mainnet: a compiled deal, a deployed escrow, a real
paid attestation, a real `release()`, a real `withdraw()`, settled entirely automatically.

## Layout

| Package | What it does | Status |
|---|---|---|
| `contracts/` | `MilestoneEscrow.sol`, the on-chain escrow | 56/56 tests, internally audited, proven live on Base and Ethereum mainnet |
| `server/imd-client/` | IMD's paid-request client, all 8 steps | Live-verified, including payment signing |
| `server/oracle-compiler/` | English deal → binding IMD question | All 3 templates and extraction live-verified end to end, real model included |
| `server/oneclaw-client/` | 1Claw's Vaults/Agents/Automations/Intents client | Live-verified; typed-data signing and transaction signing both work through 1Claw's Intents API; 1Claw's own broadcast delivery fails, so this signs via 1Claw and broadcasts via a plain RPC instead |
| `server/resolver/` | Fires at a deal's deadline, relays, settles | Live-verified on Anvil, Base mainnet, and Ethereum mainnet; can relay through a local account or through 1Claw, with no private key in the process either way |
| `site/` | Status page + dual-approval deal creation + deployment + registration + resolver webhook | Deployed on Vercel (URL withheld — it's a live app with a real IMD client and database; ask if you need it), backed by Supabase; the webhook is live-verified end to end by a real 1Claw Automation; `/new` can deploy the escrow itself |

Each package has its own README with the real depth. This one's just for "does it work, and where."

## Known gaps

- **No paid human audit.** Every proof so far is one wallet playing every role (payer, payee,
  deployer, resolver) — evidence the mechanism works, not clearance to hold a real counterparty's
  funds.
- **No real human-approval gate for above-threshold payouts.** A human has to call `release()`
  manually for deals above the configured threshold; the async 1Claw-backed approval flow isn't
  built. Separately, once a true attestation lands on-chain, a denied approval leaves funds with no
  recovery path — needs a real design decision before this is wired up.
- **The resolver webhook's live signer is active in production**, routing both IMD's payment
  signature and on-chain writes through a 1Claw agent shared with `oracle-compiler`'s extraction. That
  shared blast radius (one leaked agent key affects both) is an accepted tradeoff, not an oversight.
- **Deals compiled before the absolute-window fix can't be resolved** — their `questionHash` was
  computed from a relative evidence window that drifts over time. Recompile any old deal before
  relying on it.
- `/new`'s in-browser deploy flow hasn't been exercised against a real MetaMask-style extension's own
  confirmation UX (proven with an injected `window.ethereum` instead). Deploying elsewhere and
  registering the address afterward works either way.

## Local setup

```
cp .env.example .env   # fill from ~/.secrets/verdict.env (wallet + ONE_CLAW_API_KEY)
cd contracts && forge test
```

Every `server/*` package is `npm install && npm run typecheck && npm test`. Real-money demo scripts
live in their READMEs — all take an explicit private key as an env var and none run on their own.
