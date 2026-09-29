# Verdict

[![CI](https://github.com/redbotster/verdict/actions/workflows/ci.yml/badge.svg)](https://github.com/redbotster/verdict/actions/workflows/ci.yml)

Oracle-settled milestone escrow, built on [IMD](https://imd.fun) (oracle/workflow network) and
[1Claw](https://1claw.co) (vaults, automations, agent signing). A payer and payee agree on a
plain-English deal; it compiles into a binding, IMD-verifiable question; funds sit in an on-chain
escrow until IMD's oracle attests true or false; a resolver agent relays that attestation and settles
the contract automatically.

**Full spec:** [docs/SPEC.md](docs/SPEC.md) · **Live findings log:**
[docs/DAY-ONE-FINDINGS.md](docs/DAY-ONE-FINDINGS.md) (read this before touching integration code —
it's the record of what's actually confirmed against the real APIs, not assumed) ·
**Security audit:** [audits/2026-09-28/AUDIT-REPORT.md](audits/2026-09-28/AUDIT-REPORT.md) (3 High +
3 Medium + 5 Low + 1 Info, all fixed, plus a Slither pass — still not a substitute for a paid human
audit before any production deployment)

## Proven, with real money

Every core integration in this project has been exercised against the real, live network — not just
tested against a mock. Two things were true blockers for most of this project's history and are no
longer:

| Claim | Proof |
|---|---|
| IMD's payment-signing schema is real and correct | A real paid `oracle.request`, admitted on the first attempt: [`0x4beb...5e1cb`](https://etherscan.io/tx/0x4beb83f6b7653d1f49f0bcc61bd371ff9986ce1a38b7542384d0cd6ddd55e1cb) |
| `MilestoneEscrow.sol`'s full lifecycle works on a real chain | Deploy → real attestation → `release()` → `withdraw()`, on Base mainnet, real USDC: [`0xbf29...8442`](https://basescan.org/address/0xbf29b1008e153e6bd3cf1c25fbc9f09e08a48442) |
| The 1Claw vault/automations/signing integration is real | `npm run live-smoke` (vault side) and live create/trigger/poll runs (automations), both self-cleaning, both against `api.1claw.co` |

The payment schema had no public documentation anywhere. IMD's own web app has to construct and sign
it client-side for a human paying with a browser wallet, so it ships in that page's public JS bundle
— reading it (ordinary, unauthenticated "view source," not a private repo or an access-control
bypass) gave the real schema. See [`docs/DAY-ONE-FINDINGS.md` §13–15](docs/DAY-ONE-FINDINGS.md) for
the full method, including a real, observed oracle-panel disagreement that's worth reading if you're
relying on this for a real deal.

## Layout

| Package | What it does | Status |
|---|---|---|
| `contracts/` | `MilestoneEscrow.sol` — the on-chain escrow | 56/56 tests passing; audited; live on Base mainnet (demo) |
| `server/imd-client/` | IMD's 8-step paid-request client | **All 8 steps real**, including payment signing |
| `server/oracle-compiler/` | English deal → binding IMD question | 3/3 templates live-verified; LLM extraction untested (no key) |
| `server/oneclaw-client/` | 1Claw's Vaults/Agents/Automations/Intents API | Live-verified end to end |
| `server/resolver/` | Acts at a deal's deadline: relay + settle | Live-verified on Anvil and on Base mainnet |
| `site/` | Next.js status page + dual-approval deal creation | Verified in a real browser |

See each package's own README for depth — this file stays at the "is it real, and where do I look"
level.

## What's not done

Nothing here is blocked on IMD's payment schema anymore — that's solved. What's left:

- **Extraction has never run against a real LLM.** No Vercel AI Gateway key, and no funded 1Claw
  Shroud path (BYOK key, LLM Token Billing, or the x402 router-key rail) either. Everything
  downstream of extraction is tested via injected fixtures; Shroud's routing plumbing is tested
  against a fake `fetch` (real URL, real headers), not a live call.
- **1Claw's Intents API has a dashboard-only "enable" toggle** (`1claw.co/agents`) that no API call
  can flip — confirmed live. Automations and the vault side have no such gate.
- **The successful oracle-attestation shape is still unobserved.** The one real paid oracle request
  run so far ([`docs/DAY-ONE-FINDINGS.md` §15](docs/DAY-ONE-FINDINGS.md)) resulted in a genuine
  **panel disagreement** — every panelist reached the same correct answer, but the agreement
  mechanism's source-URL clustering didn't unify them, so no attestation was ever signed. Worth
  reading in full: this is a real risk for actual deals, not just an oddity, since the same mechanism
  could just as easily fire on a `true` outcome and silently produce no attestation for a milestone
  that really was met.
- **No paid human security audit.** The Base mainnet demo was a small, self-dealing proof (one
  wallet playing every role) — not a green light for a real deal between real counterparties.

## Ops wallet

`0xF57CfAF1f2b12E7f23C342c4fAfd675379840668` — generated fresh for this project, private key in
`~/.secrets/verdict.env` (never committed). Holds real funds across two networks, spent down over
the course of the demos above:

| Chain | Asset | Balance (as of this doc) |
|---|---|---|
| Ethereum L1 mainnet | ETH | ~0.008 (gas) |
| Ethereum L1 mainnet | `$IMD` | ~0.017 (one real request already spent 0.5) |
| Base mainnet | ETH | ~0.001 (gas) |

Balances drift with every demo run — treat this table as a snapshot, not a live value; re-check
on-chain for the current figure.

## Local setup

```
cp .env.example .env   # fill from ~/.secrets/verdict.env (wallet + ONE_CLAW_API_KEY)
cd contracts && forge test
```

Each `server/*` package has its own `npm install && npm run typecheck && npm test`; see its README
for real-money demo scripts (all require an explicit `VERDICT_PRIVATE_KEY`/`ONE_CLAW_API_KEY` env var
and are never run automatically).

## Findings index

[`docs/DAY-ONE-FINDINGS.md`](docs/DAY-ONE-FINDINGS.md) is the append-only log of everything confirmed
against the real APIs. Skimmable index:

| § | Finding |
|---|---|
| 1 | Sepolia has no configured oracle RPC on IMD's instance |
| 2 | `questionHash` is derivable for free at quote time |
| 3 | IMD's payment network is Ethereum mainnet, not testnet |
| 4 | `workflow.open` validation is agentic, not just schema |
| 5 | `questionHash` doesn't depend on `consumer`; addresses must be lowercase |
| 6 | The on-chain-event template's `toleranceBps` breaks schema validation |
| 7 | 1Claw is real at `1claw.co` (not `1claw.ai`); its Intents API doesn't leak IMD's schema |
| 8 | A stale `ONE_CLAW_API_KEY` looked like a bug but was a dead credential |
| 9 | 1Claw's real agent/vault-binding behavior diverges from its own docs |
| 10 | Correction: the public `x402` package has zero Permit2 support; 1Claw's Intents toggle is dashboard-only |
| 11 | Acquired real `$IMD` via a hand-rolled Uniswap v4 swap |
| 12 | `MilestoneEscrow.sol`'s full real lifecycle, proven on Base mainnet |
| 13 | **IMD's real payment-signing schema**, reverse-engineered from its own shipped frontend |
| 14 | The reverse-engineered schema works — a real paid `oracle.request` was admitted |
| 15 | **A real panel can `"disagree"` even when every member agrees** — read this before relying on IMD's oracle for a real deal |
