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

## Model choice, and routing through Shroud (`src/shroud.ts`)

Default model stays `anthropic/claude-haiku-4.5` (`DEFAULT_MODEL` in `extract.ts`) — checked
2026-09-29 against the live Vercel AI Gateway model list (`curl
https://ai-gateway.vercel.sh/v1/models`, not memory): still current, and the right size for this
job. Extraction is bounded classification + field extraction against a fixed schema, not
open-ended reasoning, and every output is re-validated by `lint.ts` and the template matcher before
anything is trusted — a bigger model (`anthropic/claude-sonnet-5.5`, the newest available) buys
nothing here that the fixed schema and lint pass don't already guard, at several times the cost.

`extractDealFields`'s `model` option now also accepts a real `LanguageModel` instance, not just a
Gateway string — `shroudAnthropicModel()` builds one that routes through
[1Claw's Shroud](https://docs.1claw.co/docs/agents/shroud/overview) instead of directly at a
provider. Worth doing specifically here: `extractDealFields`'s input is plain-English deal text
submitted by a payer or payee — untrusted, adversarial input by the spec's own threat model — fed
straight into a prompt. Shroud's request pipeline runs prompt-injection scoring, secret redaction,
and PII detection on that text before the model ever sees it; a direct Gateway call doesn't.

```ts
import { extractDealFields, shroudAnthropicModel } from "@verdict/oracle-compiler";

const model = shroudAnthropicModel({ agentId, agentApiKey, model: "claude-sonnet-4-6" });
const extraction = await extractDealFields(dealText, { model });
```

**Live-verified 2026-09-29**: this project's 1Claw org already has LLM Token Billing active (Stripe
AI Gateway), so a dedicated Shroud-enabled agent (`scripts/setup-shroud-agent.ts`) gets real
extraction with no Anthropic key anywhere in this project — billed straight to the 1Claw org, capped
at `daily_budget_usd: 2` and locked to `claude-sonnet-4-6` on that agent's `shroud_config`. Proven
end to end with `scripts/real-extraction-smoke.ts`: real extraction into a real free IMD dry-run
quote, real `questionHash` back. See `docs/DAY-ONE-FINDINGS.md` §17 for the two real bugs this
surfaced (both fixed): a Vertex org-policy block on native structured outputs for every Anthropic
model under LLM Token Billing (worked around with tool-calling instead of `Output.object()`), and
the model having no notion of the current date, which silently produced a deadline over a year in
the past for a relative phrase like "within 7 days" until the prompt was given today's real date.

## Status

- All three templates — `release_published`, `page_or_file_live`, and `onchain_event` — are
  **live-verified**: their built bodies get a real `201`/quote from `api.imd.fun`, for free, with a
  real `questionHash` and pinned block range back. `onchain_event` needed a real fix first: the spec's
  own template table says `guards: { toleranceBps: 0 }` for the "chain" evidence type, but that field
  causes a bare `400` on the live API regardless of anything else in the body — confirmed by bisecting
  a known-working body field by field until isolating it. The working shape is `guards.sources` +
  `minSources`, same as the panel-evidence templates, with `toleranceBps` omitted entirely. See
  `src/templates/onchainEvent.ts` and `docs/DAY-ONE-FINDINGS.md` §6.
- Extraction (`extractDealFields`) is now **live-verified** against a real model (`claude-sonnet-4-6`
  via 1Claw's Shroud) — see the Model choice section above and `docs/DAY-ONE-FINDINGS.md` §17. The
  default Vercel Gateway path (`DEFAULT_MODEL`) is still untested live — no `AI_GATEWAY_API_KEY`
  configured — but the extraction code itself is now proven, not just typechecked, and
  `test/extract.test.ts` covers the tool-calling logic against a fake model. Everything downstream
  of extraction (lint, template matching/building, dry-run) is also unit-tested and separately
  live-smoke-tested.
- IMD's real dry-run quote endpoint caps the panel question's time window at **720 hours (30
  days)** — confirmed by bisection, undocumented anywhere, and it fails with a bare `400
  invalid_request` and no detail past that. A deal whose extracted deadline is further out than
  ~29 days from now will fail to compile. See `docs/DAY-ONE-FINDINGS.md` §17.
- Built elsewhere: `site/app/new` implements the dual-approval UI, and `server/resolver` is the agent
  that calls this compiler's output at a deal's deadline.

## Local setup

```
npm install
npm run typecheck   # tsc --noEmit — Node's native TS execution only strips types, doesn't check them
npm test            # node --test, no network or API key required
```
