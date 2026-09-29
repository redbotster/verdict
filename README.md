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

## What actually works

Two things blocked this project for most of its life and don't anymore.

IMD's payment-signing schema was undocumented anywhere — no public docs, no accessible reference
repo. But IMD's own web app has to build and sign it client-side so a browser wallet can pay, so it's
sitting in that page's JS bundle. Read it, implemented it, ran a real paid `oracle.request` with it.
Admitted on the first try:
[`0x4beb...5e1cb`](https://etherscan.io/tx/0x4beb83f6b7653d1f49f0bcc61bd371ff9986ce1a38b7542384d0cd6ddd55e1cb).

`MilestoneEscrow.sol`'s whole lifecycle — deploy, attest, release, withdraw — works for real on Base
mainnet with real USDC:
[`0xbf29...8442`](https://basescan.org/address/0xbf29b1008e153e6bd3cf1c25fbc9f09e08a48442).

1Claw's vaults, automations, and signing are all live-verified against `api.1claw.co` too.

Full details in `docs/DAY-ONE-FINDINGS.md` §13–15, including a real oracle-panel disagreement worth
reading before you rely on any of this for an actual deal.

Extraction now runs against a real model too — `claude-sonnet-4-6` via 1Claw's Shroud, billed
through this org's own 1Claw LLM Token Billing subscription, no Anthropic key anywhere in this
project. Getting there surfaced and fixed two real bugs: a Google Vertex org-policy block on native
structured outputs for every Anthropic model under that billing path (worked around with
tool-calling), and the model silently computing relative deadlines ("within 7 days") against the
wrong date because it was never told what today actually is. See §17.

The site is deployed for real, on Vercel (URL not published here — it's a live app with a real IMD
client and a real Supabase-backed database, unauthenticated except the resolver webhook, so it's
deliberately not linked from a public repo; ask if you need it). A real 1Claw Automation has been
proven to reach its webhook live (§18). And the disagreement from
§15 wasn't the end of the story — a second real paid request, asking a question with only one
possible source URL to cite instead of two, reached real quorum and produced the first genuinely
successful attestation this project has seen. See §18–19.

1Claw's Intents API signing also works for real now (§20) — a real signature through 1Claw's actual
endpoint, independently verified to recover to the right address. Two things this project believed
and documented turned out to be wrong: that the toggle was dashboard-only (it's the same field as
always; the real fix is re-authenticating as the agent after flipping it), and that it needed a paid
tier upgrade (there's no tier gate at all — that was a bug in 1Claw's own docs, since fixed).

Real deal storage exists too, and it's wired end to end (§21) — a real Supabase table replaces the
hardcoded placeholder, and `/new` has a real "register the deployed escrow" step: paste an address
and it reads the real on-chain `questionHash`/`amount`/`feeBps`, refuses anything that doesn't match
what was actually compiled, and writes the row for the resolver webhook to use later.

## Layout

| Package | What it does | Status |
|---|---|---|
| `contracts/` | `MilestoneEscrow.sol`, the on-chain escrow | 56/56 tests, audited, live on Base mainnet (demo) |
| `server/imd-client/` | IMD's paid-request client, all 8 steps | All real, including payment signing |
| `server/oracle-compiler/` | English deal → binding IMD question | All 3 templates and extraction live-verified end to end, real model included |
| `server/oneclaw-client/` | 1Claw's Vaults/Agents/Automations/Intents client | Live-verified end to end, including the typed-data signer adapter — a real signature through 1Claw's Intents API, independently verified |
| `server/resolver/` | Fires at a deal's deadline, relays, settles | Live-verified on Anvil and on Base mainnet; now actually waits out real panel-assessment time instead of guessing |
| `site/` | Status page + dual-approval deal creation + registration + resolver webhook | **Deployed for real** on Vercel (URL withheld, see above), backed by a real Supabase table; the webhook is live-verified end to end by a real 1Claw Automation |

Each package has its own README with the real depth. This one's just for "does it work, and where."

## What's not done

- 1Claw's Intents API typed-data signing is now live-verified (§20 — an earlier belief that it needed
  a dashboard-only gate, and separately that it needed a paid tier upgrade, were both wrong; the real
  fix was a fresh agent token). What's still missing: real *transaction submission* through 1Claw
  (`submitAttestation`/`release` are on-chain writes, not typed-data signatures) — a separate,
  not-yet-built Intents API integration.
- The resolver still runs on a raw `EVM_PRIVATE_KEY` in an env var for those on-chain writes, not a
  vault-held key — the item above is what's blocking that from actually being replaced. The deployed
  webhook deliberately has none configured yet — it stops cleanly at that point rather than relay
  anything.
- A second real request finally got a successful attestation (§19), but the exact signature/signer
  values weren't captured in that run's log (an output-capture issue, not a shape/parsing failure —
  see §19). The disagreement risk from §15 is real and worth knowing either way; §19 shows one way to
  reduce it (pick questions with one unambiguous source URL), not eliminate it.
- No paid human audit. The Base mainnet demo was one wallet playing every role — proof the contract
  works, not clearance to use it for a real deal.
- `/new` still doesn't deploy anything itself — it produces a signed deployment payload, and a
  separate "register the deployed escrow" step (real, live-verified, §21) writes it to Supabase once
  you've actually deployed it elsewhere with that payload.

## Ops wallet

`0xF57CfAF1f2b12E7f23C342c4fAfd675379840668`, key in `~/.secrets/verdict.env`, never committed.
Balances move with every demo run, so treat these as a snapshot, not current truth:

| Chain | Asset | ~Balance |
|---|---|---|
| Ethereum mainnet | ETH | 0.005 |
| Ethereum mainnet | `$IMD` | 0.59 (two real requests spent 1.0 so far; topped up once via a real swap, §19) |
| Base mainnet | ETH | 0.001 |

## Local setup

```
cp .env.example .env   # fill from ~/.secrets/verdict.env (wallet + ONE_CLAW_API_KEY)
cd contracts && forge test
```

Every `server/*` package is `npm install && npm run typecheck && npm test`. Real-money demo scripts
live in their READMEs — all take an explicit private key as an env var and none run on their own.

## Findings index

`docs/DAY-ONE-FINDINGS.md` is the running log of everything confirmed against the real APIs, in the
order it was found:

| § | Finding |
|---|---|
| 1 | Sepolia has no configured oracle RPC on IMD's instance |
| 2 | `questionHash` is free to get at quote time |
| 3 | IMD's payment network is Ethereum mainnet, not testnet |
| 4 | `workflow.open` validation is agentic, not just schema |
| 5 | `questionHash` doesn't depend on `consumer`; addresses must be lowercase |
| 6 | The on-chain-event template's `toleranceBps` breaks schema validation |
| 7 | 1Claw is actually at `1claw.co`, not `1claw.ai`; its Intents API doesn't leak IMD's schema |
| 8 | A stale `ONE_CLAW_API_KEY` looked like a bug, was just a dead key |
| 9 | 1Claw's real agent/vault-binding behavior doesn't match its own docs |
| 10 | Correction: the public `x402` package has no Permit2 support; 1Claw's Intents toggle is dashboard-only |
| 11 | Got real `$IMD` via a hand-rolled Uniswap v4 swap |
| 12 | `MilestoneEscrow.sol`'s full lifecycle, proven on Base mainnet |
| 13 | IMD's real payment-signing schema, pulled from its own shipped frontend |
| 14 | The schema works — a real paid `oracle.request` got admitted |
| 15 | A real panel can disagree even when everyone gives the same answer — read before relying on this |
| 16 | Fixed the resolver's oracle-polling timing bug, added a 1Claw-backed signer, built the missing webhook |
| 17 | Real LLM extraction via 1Claw Shroud — a Vertex structured-outputs block, a wrong-date bug, and IMD's undocumented 30-day window cap |
| 18 | Deployed `site/` to Vercel for real — a monorepo build, an artifact-tracing bug, a live automation-to-webhook proof, and a public-RPC reliability finding |
| 19 | Topped up `$IMD` with a second real swap, and got the first-ever successful (non-disagreed) real attestation |
| 20 | 1Claw's Intents API actually works — no dashboard-only gate, no tier gate; the real fix was a fresh agent token, plus three real signing bugs found and fixed |
| 21 | Real deal storage via Supabase, replacing the hardcoded placeholder |
