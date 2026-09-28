# Verdict

Oracle-settled milestone escrow on IMD + 1Claw. Full product spec: [docs/SPEC.md](docs/SPEC.md).
Live-API day-one findings (read this before writing more integration code):
[docs/DAY-ONE-FINDINGS.md](docs/DAY-ONE-FINDINGS.md).
Contract security audit — 3 High + 3 Medium + 5 Low + 1 Info, **all fixed**, plus a Slither
static-analysis pass: [audits/2026-09-28/AUDIT-REPORT.md](audits/2026-09-28/AUDIT-REPORT.md).
Still not a substitute for a paid human audit before any mainnet deployment — see the report's
closing note.

## Layout

- `contracts/` — Foundry project: `MilestoneEscrow.sol` and its test suite.
- `server/imd-client/` — the server-side IMD paid-request client (the 8-step handshake), free steps
  implemented and confirmed against the live API; the Permit2/quote-approval signing step is
  intentionally left unimplemented pending IMD's real signing schema (see findings doc).
- `server/oracle-compiler/` — the English-deal-to-oracle-question compiler: extract → match a vetted
  template → lint → free dry-run quote. Two of three templates live-verified against `api.imd.fun`.
- `server/resolver/` — not yet built: the 1Claw-hosted resolver agent.
- `site/` — not yet built: per-deal status page.

## Status

This is scaffolding from an initial pass, not a finished MVP — see the build plan in the spec for
the full six-week shape. What exists right now:

- Project structure and the full spec/findings docs.
- A dedicated ops/resolver wallet, freshly generated, unfunded, stored at `~/.secrets/verdict.env`
  (never committed).
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
  compile/pin design down to "compile already gives you the binding hash."
- Both `imd-client` and `oracle-compiler` now have `npm run typecheck` (`tsc --noEmit`) — Node's
  native TypeScript execution only strips types, it doesn't check them, which is how a template
  builder silently omitting the required top-level `chainId` field went undetected until a live
  smoke test caught it as a bare `400` with no detail.

What's deliberately not done yet, because it costs real money or needs information this pass
couldn't get:

- Any real `workflow.open` or `oracle.request` payment (real IMD tokens, mainnet).
- 1Claw vault/policy/automation wiring (needs the Permit2 signing schema resolved first).
- Extraction has not been run against a real LLM (no Gateway API key available this pass) — everything
  downstream of it is tested by injecting a fixed extraction directly.
- The resolver agent and the dual-approval / status page UI.
- Funding the ops wallet.

## Local setup

```
cp .env.example .env   # fill from ~/.secrets/verdict.env and ~/.secrets/1claw.env
cd contracts && forge test
```
