# Verdict

Oracle-settled milestone escrow on IMD + 1Claw. Full product spec: [docs/SPEC.md](docs/SPEC.md).
Live-API day-one findings (read this before writing more integration code):
[docs/DAY-ONE-FINDINGS.md](docs/DAY-ONE-FINDINGS.md).
Contract security audit — 3 High + 3 Medium (all fixed), 5 Low + 1 Info (still open,
**read before deploying anything real**): [audits/2026-09-28/AUDIT-REPORT.md](audits/2026-09-28/AUDIT-REPORT.md).

## Layout

- `contracts/` — Foundry project: `MilestoneEscrow.sol` and its test suite.
- `server/imd-client/` — the server-side IMD paid-request client (the 8-step handshake), free steps
  implemented and confirmed against the live API; the Permit2/quote-approval signing step is
  intentionally left unimplemented pending IMD's real signing schema (see findings doc).
- `server/oracle-compiler/` — not yet built: the English-deal-to-oracle-question compiler.
- `server/resolver/` — not yet built: the 1Claw-hosted resolver agent.
- `site/` — not yet built: per-deal status page.

## Status

This is scaffolding from an initial pass, not a finished MVP — see the build plan in the spec for
the full six-week shape. What exists right now:

- Project structure and the full spec/findings docs.
- A dedicated ops/resolver wallet, freshly generated, unfunded, stored at `~/.secrets/verdict.env`
  (never committed).
- `MilestoneEscrow.sol` + Foundry tests (48/48 passing). A follow-up security audit (see above) found
  3 High and 3 Medium issues the original tests didn't cover; all six are now fixed — the payer signs
  the exact deal terms rather than trusting a predicted deploy address, non-standard tokens are
  rejected at construction, settlement is pull-payment, attestations are bound to the deadline with
  freshness ordering, and the challenge window now lets a fresher oracle-signed correction actually
  override a wrong `true`. Only Low/Info findings remain open — see the audit report.
- The IMD client's free-tier operations (capabilities, quote, challenge, status, polling).

What's deliberately not done yet, because it costs real money or needs information this pass
couldn't get:

- Any real `workflow.open` or `oracle.request` payment (real IMD tokens, mainnet).
- 1Claw vault/policy/automation wiring (needs the Permit2 signing schema resolved first).
- The question compiler and resolver agent.
- Funding the ops wallet.

## Local setup

```
cp .env.example .env   # fill from ~/.secrets/verdict.env and ~/.secrets/1claw.env
cd contracts && forge test
```
