# @verdict/oracle-compiler

Turns a plain-English deal description into a pinned, deterministic IMD `oracle.request` body — the
"real moat" piece from `docs/SPEC.md`'s Question compiler section. An LLM never writes the oracle
request freehand; it only extracts structured fields, and deterministic code builds the final body
from one of three vetted templates.

## Pipeline

1. **Extract** (`src/extract.ts`) — an LLM (via Vercel AI Gateway, `ai` package's `Output.object`)
   reads the deal text and returns structured fields: claim, evidence URLs, deadline, timezone,
   ambiguous terms it noticed itself, and which template it thinks fits.
2. **Match a template** (`src/templates/`) — `release_published`, `page_or_file_live`, or
   `onchain_event`, per the spec's table. No match, or missing required fields for the matched kind,
   refuses the deal with a plain reason rather than forcing it through.
3. **Lint** (`src/lint.ts`) — rejects subjective words, "on time"-style phrases without a concrete
   deadline, login/paywall hints, and non-public evidence URLs (non-https, embedded credentials,
   localhost/private IPs).
4. **Dry-run quote** (`src/compile.ts`, `compileDeal()`) — calls IMD's `POST /requests/quote`, which
   is free even on failure. A 422 is fed back into one bounded extraction retry before giving up.
5. **Dual approval** — `approvalSummaryFromOrder()` turns a quote's response into the plain-language
   payload (question, sources, quorum, `questionHash`, pinned block range) that both parties review
   and sign off on. `site/app/new` implements this UI (a different path through the same underlying
   template/lint/quote logic, since it takes structured form input instead of LLM extraction).

## A load-bearing finding from building this

`consumer` (the field naming which contract the answer is for) does **not** affect `questionHash` —
confirmed empirically, see `docs/DAY-ONE-FINDINGS.md` §5. That means `compileDeal()`'s dry-run quote,
run before the escrow even exists, already produces the real, binding `questionHash` to put in the
escrow's constructor — no separate "final" quote is needed for that. `pinQuestion()` still exists to
register the real deployed escrow address with IMD before the resolver's real paid call later, but
that's bookkeeping on IMD's side, not something the escrow's correctness depends on.

Also found the hard way: IMD's schema requires **lowercase** hex addresses. A checksummed address
(what most wallet libraries produce) fails with a bare `400` and no detail. `withConsumer()` lowercases
automatically; anything else that builds a `consumer` or address field by hand should too.

## Status

- All three templates — `release_published`, `page_or_file_live`, and `onchain_event` — are
  **live-verified**: their built bodies get a real `201`/quote from `api.imd.fun`, for free, with a
  real `questionHash` and pinned block range back. `onchain_event` needed a real fix first: the spec's
  own template table says `guards: { toleranceBps: 0 }` for the "chain" evidence type, but that field
  causes a bare `400` on the live API regardless of anything else in the body — confirmed by bisecting
  a known-working body field by field until isolating it. The working shape is `guards.sources` +
  `minSources`, same as the panel-evidence templates, with `toleranceBps` omitted entirely. See
  `src/templates/onchainEvent.ts` and `docs/DAY-ONE-FINDINGS.md` §6.
- Extraction (`extractDealFields`) has not been run against a real model in this pass — no
  `AI_GATEWAY_API_KEY` was available. Everything downstream of extraction (lint, template
  matching/building, dry-run) is unit-tested and separately live-smoke-tested by injecting a fixed
  extraction directly, bypassing the LLM call.
- Built elsewhere: `site/app/new` implements the dual-approval UI, and `server/resolver` is the agent
  that calls this compiler's output at a deal's deadline.

## Local setup

```
npm install
npm run typecheck   # tsc --noEmit — Node's native TS execution only strips types, doesn't check them
npm test            # node --test, no network or API key required
```
