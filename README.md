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

## Fixed: real IMD attestations now verify on-chain (§25)

`MilestoneEscrow.sol`'s on-chain check of IMD's oracle signature used the wrong EIP-712 domain name
and struct shape — a bug affecting every escrow ever deployed under the contract, confirmed for real
2026-09-29 (real oracle signer:
[`0x5598Aa91...Fd32982`](https://etherscan.io/address/0x5598Aa9146215Bc13eb26f2c692Ad1461Fd32982), real
domain `"IdentityMD Oracle"`/struct `OracleAttestation`, several corrected field types, one field —
`blockHash` — the contract's struct never had at all). Every prior "real" proof of the contract's
lifecycle used a throwaway local key standing in for the oracle signer, which never actually exercised
IMD's real signature. **Now fixed and independently proven three ways**: (1) a new regression test
recovers the exact real captured signature, via the contract's own actual hashing code, to IMD's real
reported signer — cryptographic proof, not a self-consistent fixture; (2) all 56 contract tests plus
all 50 resolver tests (including a real local-chain deploy/attest/release run) pass with the corrected
schema; (3) the full local demo script re-ran for real end to end. **Not yet proven**: an actual
on-chain `submitAttestation()` using a brand-new real IMD attestation against a freshly deployed real
contract — blocked on real `$IMD` budget (0.09 left, well under the 0.5 a request costs), not on
anything unresolved in the fix itself. Every escrow deployed under the *old* contract (including the
real Base mainnet ones referenced below) is unfixable in place and would need a fresh deployment under
the corrected version. Full details: `docs/DAY-ONE-FINDINGS.md` §25.

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
(That demo's oracle signer was a throwaway local key, not IMD's real one — real IMD attestation
verification was found broken and then fixed, see §25.)

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

1Claw can also sign the resolver's on-chain writes (`submitAttestation`/`release`), not just IMD's
payment (§22) — real, correctly targeted and encoded transactions, independently verified with viem
to recover to the agent's real signing key. Actually *broadcasting* them through 1Claw's own
infrastructure fails, confirmed by trying it on Base mainnet with real USDC: 1Claw signs correctly,
then its own RPC relay fails to deliver, returning a `tx_hash` for a transaction that was never
actually sent — no funds were at risk, cleanly reclaimed once the demo's deadline elapsed. But the
self-broadcast alternative — sign via 1Claw, broadcast the raw tx over a plain RPC directly — is now
built (`oneClawSignAndBroadcastRelay`) and proven for real on Base mainnet: a real transaction, signed
by 1Claw and broadcast by this code, landed on-chain and confirmed. The raw-private-key gap for the
resolver's on-chain writes is now genuinely closed, not just half-closed. See §22 for both the
original failure and the fix.

## Layout

| Package | What it does | Status |
|---|---|---|
| `contracts/` | `MilestoneEscrow.sol`, the on-chain escrow | 56/56 tests, audited, live on Base mainnet (demo) |
| `server/imd-client/` | IMD's paid-request client, all 8 steps | All real, including payment signing |
| `server/oracle-compiler/` | English deal → binding IMD question | All 3 templates and extraction live-verified end to end, real model included |
| `server/oneclaw-client/` | 1Claw's Vaults/Agents/Automations/Intents client | Live-verified end to end; typed-data signing and transaction signing both work through 1Claw's Intents API; 1Claw's own broadcast delivery fails, but a sign-via-1Claw + broadcast-via-RPC alternative works and is proven live (§22) |
| `server/resolver/` | Fires at a deal's deadline, relays, settles | Live-verified on Anvil and on Base mainnet; now actually waits out real panel-assessment time instead of guessing; can relay through a local account or through 1Claw (`oneClawSignAndBroadcastRelay`), with no private key in the process either way |
| `site/` | Status page + dual-approval deal creation + deployment + registration + resolver webhook | **Deployed for real** on Vercel (URL withheld, see above), backed by a real Supabase table; the webhook is live-verified end to end by a real 1Claw Automation; `/new` can now deploy the escrow itself, mechanism proven on local Anvil, not yet a real browser click-through |

Each package has its own README with the real depth. This one's just for "does it work, and where."

## What's not done

- ~~`MilestoneEscrow.sol`'s attestation verification doesn't match IMD's real signature scheme at
  all~~ — **fixed and independently proven, see §25's addendum and the note at the top of this file.**
  What's still open: no *newly* deployed escrow under the corrected contract has yet had a real IMD
  attestation submitted against it on-chain (as opposed to the cryptographic proof using the real
  captured signature) — blocked on real `$IMD` budget, not on anything unresolved in the fix. Any deal
  registered against an *old* (pre-fix) deployment still can't ever settle on a real answer and needs
  redeploying under the corrected contract.
- Retiring `EVM_PRIVATE_KEY` for the resolver's on-chain writes is now genuinely closed (§22).
  Typed-data signing (IMD's payment, §20) and transaction signing (§22) both work for real through
  1Claw. 1Claw's own broadcast infrastructure fails to deliver a signed transaction, but the
  self-broadcast alternative — sign via 1Claw, broadcast the raw tx via a normal RPC directly
  (`oneClawSignAndBroadcastRelay`) — is built and proven for real on Base mainnet.
- **The deployed webhook's live signer is now activated** (2026-09-29): `ONE_CLAW_RESOLVER_AGENT_ID`/
  `_AGENT_API_KEY`/`_ADDRESS` are set on the production Vercel deployment, routing both IMD's payment
  signature and the resolver's on-chain writes through the same 1Claw agent already proven live this
  session (§20's payment signing, §22's transaction signing and broadcast) — no raw private key in
  the process. This is a deliberate decision made explicitly for this activation, not a default: it
  makes the webhook a standing endpoint able to spend real `$IMD`/gas on any future trigger. Reuses
  the same agent as `server/oracle-compiler`'s LLM extraction (`verdict-extraction`) rather than a
  freshly-provisioned resolver-only agent — a real tradeoff (shared blast radius if that one agent's
  key ever leaks) accepted for reliability, since this exact agent's Intents API configuration was
  already proven correct, rather than risking new setup bugs on a fresh one during a live activation.
- ~~A second real request finally got a successful attestation (§19), but the exact signature/signer
  values weren't captured in that run's log~~ — **resolved by §25**, which re-ran the same trick with
  output written straight to a file and went further: independently verified the captured signature
  cryptographically. The disagreement risk from §15 is still real and worth knowing either way; the
  "one unambiguous source URL" trick reduces it, not eliminates it.
- No paid human audit. The Base mainnet demo was one wallet playing every role — proof the contract
  works, not clearance to use it for a real deal.
- `/new` can now deploy the escrow itself (the payer's wallet approves + deploys) — proven both at the
  mechanism level (local Anvil, `site/scripts/deploy-self-service-test.ts`) and with a real browser
  click-through of the actual UI (a real dev server, a real page, an injected `window.ethereum`
  forwarding to real signing, driven through the actual React click handlers — see §23's addendum).
  Only remaining gap: a real MetaMask-style extension's own confirmation-popup UX hasn't been
  exercised. Deploying elsewhere and pasting the address into the "register the deployed escrow" step
  (real, live-verified, §21) still works as before.
- No real human-approval gate for above-threshold payouts (§24). Two real bugs in this area are now
  fixed — `resolveDeal()` no longer re-spends real `$IMD` on a retry, and an above-threshold deal no
  longer hard-fails the whole resolution — but an actual 1Claw-backed approval flow (async, since
  1Claw's real mechanism can park a run for up to 72 hours) isn't built yet; a human has to call
  `release()` manually for now. Separately, §24 also surfaced a real, unresolved contract-level gap:
  once a true attestation lands on-chain, a denied approval would leave funds with no recovery path at
  all — worth a real design conversation before wiring a gate that can actually deny anything.

## Ops wallet

`0xF57CfAF1f2b12E7f23C342c4fAfd675379840668`, key in `~/.secrets/verdict.env`, never committed.
Balances move with every demo run, so treat these as a snapshot, not current truth:

| Chain | Asset | ~Balance |
|---|---|---|
| Ethereum mainnet | ETH | 0.005 |
| Ethereum mainnet | `$IMD` | 0.09 (three real requests spent 1.5 so far; topped up once via a real swap, §19) |
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
| 22 | On-chain transaction *signing* via 1Claw works; 1Claw's own *broadcast* fails — confirmed on Base mainnet, no funds lost — but signing via 1Claw + broadcasting via a plain RPC works, proven live on Base mainnet; now activated on the live resolver webhook |
| 23 | `/new` can now actually deploy the escrow (payer approves + deploys); proven on local Anvil, then proven again with a real browser click-through of the actual UI |
| 24 | Fixed two real production-readiness bugs: `resolveDeal()` wasn't idempotent (a retry re-spent real `$IMD`), and every registered deal defaulted to needing an approval that could never come (hard-failed every real settlement). Also surfaced an unresolved contract-level gap: funds have no recovery path if an approval is ever denied after a true attestation lands |
| 25 | Found and fixed a critical bug: `MilestoneEscrow.sol`'s on-chain attestation check used the wrong EIP-712 domain/struct, so no real IMD attestation was ever verifiable on-chain. Real oracle signer and signing schema confirmed for the first time; contract, resolver, and site all corrected and re-proven (56+50 tests, a real regression test recovering the real captured signature, a real local demo re-run) |
