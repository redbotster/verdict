# Verdict MVP Spec: oracle-settled agreements on IMD + 1Claw

Sep 28, 2026 · @Kevin Jones

## Scope

The MVP is a milestone escrow: a payer and a payee describe a deal in English, the system deploys the contract and a site, and an oracle panel decides release or refund from public evidence. It ships on testnet first, with one answer type (bool), and leaves betting-style markets out on purpose.

Who it is for. Teams that pay against evidence anyone can check: a GitHub release, an on-chain event, a published page. First targets are freelance dev shops, grant programs and DAO contributor payments.

### In scope

- One agreement type: escrow that releases to the payee on a true attestation, or refunds the payer on false after a deadline.
- Deal intake in plain English, compiled into a pinned oracle question with sources and a quorum.
- Contract, review, deployment and site through IMD workflow.open.
- An autonomous resolver agent on 1Claw that asks the oracle, submits the attestation and settles.
- Human approval above a payout threshold, by passkey or SMS.
- A status page per deal and an operator dashboard.

### Out of scope for the MVP

- Prediction markets, odds or anything with third-party speculation. It raises gambling and derivatives questions that need a lawyer first.
- Mainnet funds. IMD's workflow launches on Sepolia only today, so real money waits on that changing or on our own audited template.
- uint256, address and list answers. Add them after bool is reliable.
- A second oracle or dispute court. Disclosed as a known trust assumption instead.

Done means: one deal goes from typed text to a live, reviewed contract and site in under ten minutes, then settles below the approval threshold with no human touch. Five real pilot deals run on testnet before any mainnet discussion.

## Architecture

Three systems have separate jobs: IMD builds and answers, 1Claw acts under policy, and only the escrow contract moves money.

The resolver asks the oracle and relays the answer, but it cannot redirect funds. The escrow fixes payer, payee and deadline at creation, and anyone can submit the same public attestation.

### Verified in the docs

- IMD: the paid quote, submit and poll routes, x402 payment with Permit2, the workflow stages, and the attestation shape with domain, types and signature.
- 1Claw: vaults, Execution Intents, the Intents API with typed-data policies, automations, approvals, Shroud and Cloud Runtimes, all listed on its For AI page.

### Assumed, and tested on day one

- 1Claw can sign IMD's Permit2 payment and quote approval.
- IMD's questionHash is knowable early enough to bind the contract to it.
- A workflow draft accepts a seeded repoUrl and baseCommit.
- The oracle has a configured RPC for Sepolia (chain id 11155111).

## User flow

A deal has four setup steps that a person sees, then runs unattended until it pays out or refunds.

The resolver acts at the deadline, not before, because the oracle's evidence window is pinned when the request is quoted. A panel that disagrees produces no answer, which is why the third ending exists: a payer is never stuck waiting on a silent oracle.

Where humans stay involved. Both parties approve the pinned question before funding. Verdict's own spend, meaning each IMD payment and any relay above the threshold, goes through a 1Claw approval by passkey or SMS. The contract's challenge window on a true answer gives both sides time to object to a result before money moves.

## IMD integration

Every IMD action is the same eight-step paid handshake, run server-side, because IMD's paid routes refuse cross-origin browsers. Build it once as a client module and call it for both workflow.open and oracle.request. Source: IMD API docs, read 2026-09-28.

| # | Call | What Verdict does | Notes from the docs |
|---|------|--------------------|-----------------------|
| 1 | GET /requests/capabilities | Read live price, token, payTo, quoteTtlSeconds | Never hardcode the 0.5 IMD price; this route is the source of truth |
| 2 | Generate a 32-byte hex token | One per deal, stored in the 1Claw vault | It names and reads your orders; losing it loses read access |
| 3 | POST /requests/quote | Send {requestKey, action, input} | requestKey is a UUID; reuse it to retry. A 422 charges nothing, so use it as a free validator |
| 4 | POST /requests/:id/submit, no body | Receive the 402 and PAYMENT-REQUIRED challenge | Quotes last 600 seconds |
| 5 | Sign twice | Permit2 payment payload plus an EIP-712 quoteSignature | Wallet needs an IMD balance and a Permit2 allowance |
| 6 | POST /requests/:id/submit with PAYMENT-SIGNATURE | Send the payload and quoteSignature | 202 pending. Retries never charge twice |
| 7 | GET /requests/:id | Poll until status is admitted | Follow admission.result URLs. refused means the catalog changed |
| 8 | GET /workflows/:id or /oracle/requests/:id | Poll to completed or attested | Workflow validation can retry up to a day while hosting settles |

Limits to design around: 16 KiB per quote body, 10 quotes and 120 requests a minute per IP and per token, and the server's wallet pays gas.

**Day-one confirmed (2026-09-28, live `/requests/capabilities`)**: price is 0.5 IMD (asset `0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7`, 18 decimals) per action for job.open, launch.open, oracle.request, workflow.open, schedule.create, schedule.topup. quoteTtlSeconds is 600. Payment scheme is x402 v2, exact, Permit2, EIP-712 quote approval. **Payment network is `eip155:1` (Ethereum mainnet)** — the IMD payment itself is a real-money mainnet transaction even though workflow.open deploys to Sepolia. Oracle panel size range is 5-100.

### The escrow workflow quote

This is the input Verdict sends for each new deal. The request text carries the deal-specific terms; the draft stays fixed so every deal gets the same review path.

```json
{
  "requestKey": "<uuid per deal>",
  "action": "workflow.open",
  "input": {
    "request": "Build MilestoneEscrow: payer deposits USDC-test, payee is fixed at creation, deadline is fixed. Funds release to the payee only when a valid OracleAttestation with answer true is submitted; they refund to the payer if the deadline passes with no true attestation. No owner, no admin, no upgrade. Then publish a page that shows the deal terms, escrow balance, question text and status.",
    "context": "Sepolia only. GitHub and IPFS approved. Fee recipient and fee bps are constructor arguments and immutable. Attestation domain and signer are constructor arguments.",
    "draft": {
      "objective": "Build MilestoneEscrow with tests and an independent review, deploy it, then build the status page against the live deployment.",
      "shape": "dag",
      "onchain": "evm_project",
      "github": true,
      "ipfs": "<deal-slug>",
      "contracts": ["MilestoneEscrow"],
      "references": ["solidity-security-review", "defi-native"],
      "steps": [
        { "skill": "build-contract-project", "key": "contracts", "dependsOn": [] },
        { "skill": "write-foundry-tests", "key": "tests", "dependsOn": ["contracts"], "paths": ["test"] },
        { "skill": "adversarial-review", "key": "review", "dependsOn": ["tests"] },
        { "skill": "frontend-for-contract", "key": "site", "dependsOn": ["review"] }
      ]
    },
    "permissions": { "github": true, "ipfs": "<deal-slug>", "onchain": { "kind": "evm_project", "chainId": 11155111 } }
  }
}
```

### Template seeding to test in week one

The docs list repoUrl and baseCommit as valid job-body fields and name only a few fields as refused inside a workflow draft. If seeding works, start every deal from our own audited MilestoneEscrow and let IMD's agents adapt and review it, instead of generating the contract from scratch. This is unconfirmed; treat it as a day-one test.

## 1Claw integration

1Claw's job is to let an unattended agent pay IMD, call APIs and relay transactions while holding no raw credentials, under rules a human wrote. Source: 1Claw For AI guide, read 2026-09-28. Plan tier assumption: Team, because the Cedar policy backend is listed as Team and above.

| Need | 1Claw feature | MVP configuration |
|------|---------------|--------------------|
| Hold IMD paid tokens, GitHub tokens, LLM keys | Vaults plus resolve_env | One vault, paths imd/orders/<deal>, github/publish. Runtime gets values by injection, never in prompts |
| Call api.imd.fun without exposing the bearer token | Execution Intents | A binding with allowed_hosts: [api.imd.fun] and the token as a vault_ref pointer |
| Pay IMD (Permit2 plus quote approval) | Intents API, EIP-712 typed-data signing | Ops wallet holds IMD. Typed-data policy pins verifyingContract to Permit2 and the recipient to IMD's payTo from /requests/capabilities. Unconfirmed |
| Run the resolver | Cloud Runtime (node template) | One small runtime, included in paid plans, with the Shroud sidecar and its own agent identity |
| Fire at the deadline | Automations | One cron or webhook trigger per deal, created when the deployment goes live, calling the resolver |
| Relay the attestation | Intents API POST /v1/agents/{id}/transactions | Simulation and nonce serialization on. Per-day gas budget on Sepolia |
| Ask a human | Human-Readable Action Approvals | Action oracle.request with a summary such as "Ask panel: did repo X publish v2 by Friday? Cost 0.5 IMD". Risk tier is derived server-side |
| Draft the oracle question with an LLM | Shroud router key | Stock SDK pointed at the Shroud gateway; inspection costs $0.005 per request |
| See what the agents are doing | Control plane dashboard | Live map of agents, policies, vaults and chains. Human users only |

### Policy for the resolver agent (deny by default)

- Reads only the imd/orders/* and github/publish vault paths.
- Executes HTTP only against api.imd.fun, explorer.imd.fun and the deal's own site host.
- Signs typed data only for Permit2 and the IMD quote approval, and only up to a per-day IMD cap.
- Sends transactions only to the escrow addresses Verdict registered, and only the submitAttestation selector.
- Anything outside that returns 202 awaiting_approval or is refused, and new guardrail widening goes through 1Claw's policy-change approval, not a silent edit.
- Start every rule in shadow mode (enforcement: log) for the first ten deals, review the shadow report, then switch to enforce.

What the agent cannot do, by design. The escrow contract fixes the payee, the payer and the deadline at creation. The agent only relays a signed attestation, so a compromised resolver can waste gas or delay a relay, but it cannot redirect funds. Anyone can also submit the same public attestation, which means resolver downtime never traps a deal.

Scaling note. Child agents are capped at 50 per parent at depth one. The MVP uses one resolver agent with per-deal automations. Use child agents per partner tenant later, and the Platform API for anything beyond that.

## Escrow contract and attestation check

The contract is small on purpose: it holds one deposit, accepts one valid IMD attestation, and pays out exactly one way. IMD's attestation endpoint returns EIP-712 typed data (domain, types, primaryType: OracleAttestation, message, signature, signer), and the message carries requestId, chainId, questionHash, answerType, answer, figure, block range, panelJobId, issuedAt and expiresAt. The consumer field in the request sets the domain your contract verifies against.

### Rules the contract enforces

- Payer, payee, token, amount, deadline, questionHash, oracle signer, fee recipient and fee bps are constructor arguments and immutable.
- submitAttestation accepts a signature only if the recovered address equals the stored oracle signer, questionHash matches, answerType is bool, and expiresAt has not passed.
- A true answer starts a challenge window (default 24 hours, zero for small deals). After it, anyone can call release, which pays the payee minus the fee.
- A false answer allows an immediate refund to the payer.
- No attestation by deadline + grace (default 7 days) lets the payer reclaim. This covers panels that disagree, since IMD says a disagreeing panel ends without an answer.
- State is one-way: Funded, then Released or Refunded. A settled deal cannot be reopened.

**Note**: the typehash and struct fields must be copied from a live attestation's types, not guessed. Getting a live attestation requires a paid `oracle.request` call (real IMD tokens on mainnet) — held back from day-one scaffolding pending a go-ahead to spend.

### Foundry invariants the IMD review must see pass

| Invariant | Why it matters |
|-----------|-----------------|
| Funds leave only to payee (after true and window) or payer (after false or grace) | The agent and any relayer cannot redirect money |
| Settles at most once | Prevents a replayed attestation from paying twice |
| Wrong signer, wrong questionHash, wrong domain, expired message all revert | Core verification |
| Malleated or short signatures revert | Standard ECDSA hygiene |
| Fee never exceeds the cap | Protects the customer from a bad constructor argument |
| reclaim is unreachable once trueAt is set | A late false cannot beat an earlier true |

Timing constraints from the oracle. validForSeconds runs 60 to 2,592,000, so set it longer than the challenge window plus relay time (7 days is a safe default). The window field accepts 1 to 720 hours; for deals longer than 30 days pass explicit fromBlock and toBlock and use evidence: panel with the calendar range pinned in definitions, as IMD's own example does.

## Question compiler

The compiler is the product's real moat: a vague question means a panel that disagrees, and a disagreeing panel costs IMD's fee and produces no answer. So the LLM never writes an oracle request freehand. It fills a small set of vetted templates, and deterministic code builds the final body.

### Pipeline

1. Extract. An LLM behind Shroud reads the deal text and returns structured fields: claim, evidence URLs, deadline, timezone, and any ambiguous terms it found.
2. Match a template. Pick one of the three below. No match means the deal is refused with a plain explanation, not forced through.
3. Lint. Reject subjective words ("good", "satisfactory", "on time" without a timestamp), private sources, and any evidence that needs a login.
4. Dry run. Call POST /requests/quote with the built body. A 422 returns problems and charges nothing, so the compiler can loop on the error text.
5. Dual approval. Both payer and payee see the pinned question, sources and quorum in plain language and sign off before the escrow is funded.

### Templates (MVP)

| Template | Example claim | evidence | Panel / quorum | guards |
|----------|----------------|----------|------------------|--------|
| Release published | A non-prerelease GitHub release exists in the window | panel | 5 / 4 | sources set to the repo URL prefix, minSources: 1 |
| Page or file live | A named URL serves content matching a stated check | panel | 5 / 4 | sources set to the host, minSources: 1 |
| On-chain event | An address received at least N of a token in the window | chain | 5 / 5 | toleranceBps: 0 |

Every template carries three mandatory definitions keys, modeled on IMD's own example: the exact source and how to read it, the calendar range with timezone, and a missing rule saying unavailable evidence is not false and the panel should report inability instead of guessing. That last rule is what routes bad evidence to the grace-period refund rather than a wrongful false.

### Example built body (release template)

The consumer is the deployed escrow, so the resolver builds and sends this only after deployment and after the deadline.

```json
{
  "v": 1,
  "question": "Did acme/widget publish a non-prerelease GitHub release between 2026-10-01T00:00:00Z and 2026-10-15T23:59:59Z?",
  "chainId": 11155111,
  "window": { "hours": 360 },
  "answerType": "bool",
  "evidence": "panel",
  "panelSize": 5,
  "quorum": 4,
  "validForSeconds": 604800,
  "definitions": {
    "project": "Use https://github.com/acme/widget/releases and published_at. Exclude drafts and prereleases.",
    "calendar": "Use [2026-10-01T00:00:00Z, 2026-10-16T00:00:00Z). Blocks are context only.",
    "missing": "Unavailable evidence is not false. Report inability rather than guessing."
  },
  "guards": { "sources": ["https://github.com/acme/widget/"], "minSources": 1 },
  "consumer": { "chainId": 11155111, "verifyingContract": "<escrow address>" }
}
```

### Two things to confirm before trusting this design

First, IMD's docs do not say how questionHash is derived. If it depends on the block range pinned at quote time, it cannot be known when the escrow is deployed. The fallback is a one-time commit step where payer and payee co-sign the questionHash from the quote before funding. Second, the docs do not say whether the 0.5 IMD price changes with panelSize; read /requests/capabilities and test a 5-member and a 9-member quote. **Day-one confirmed: price is flat 0.5 IMD regardless of listed action; panel-size sensitivity still untested (requires a paid quote).**

## Economics

Each deal costs roughly two IMD payments plus small overhead, so the fee must cover a fixed cost that moves with the IMD token price. That means a minimum fee per deal, with a percentage on top. Every dollar figure here is a placeholder to replace with live numbers once the token's real price and 1Claw's pricing are read.

Cost per deal: C = 0.5P + (1 + r) · 0.5P + S + G

Here P is the USD price of IMD, so the two paid actions are workflow.open and oracle.request at 0.5 IMD each. r is the expected re-ask rate after a panel that ends without an answer (0.2 until pilots say otherwise). S is Shroud inspection at $0.005 per request, about 10 requests per deal. G is gas — zero on Sepolia for the deployment/settlement, but the IMD *payment* itself is mainnet gas paid by IMD's own wallet, not Verdict's, per the x402 handshake.

With r = 0.2 this simplifies to C = 1.1P + S + G.

### Revenue lines

| Line | How it is charged | MVP status |
|------|---------------------|------------|
| Settlement fee | Basis points on released value, capped at 200 in the contract, with a per-deal minimum | On |
| Setup fee | Flat USDC at funding, covering workflow and oracle costs | On |
| Partner plan | Monthly fee for embedding Verdict through 1Claw's Platform API | Design only |
| Recurring feeds | Scheduled oracle questions on a subscription | After the pilot |

Token-price risk. Prepaying IMD creates exposure. Hold only enough IMD for the next 20 deals, top up in small lots, and refresh P from the live quote each time a customer funds.

## Build plan

The plan runs about six weeks to a go or no-go decision, and week one exists only to test the three assumptions that could change the design.

| Milestone | Exit criteria |
|-----------|-----------------|
| Day-one tests | All eight checks recorded; each failed assumption has a named fallback and a design change |
| IMD client, 1Claw setup | One paid oracle question completes from a test wallet with no key in an environment variable; policies run in shadow mode |
| Escrow and invariants | Every invariant in the contract section passes; IMD's review artifacts read by a human; no open high-severity finding |
| Question compiler | Three templates dry-run clean on ten sample deals; ambiguous deals are refused with a reason |
| Resolver and approvals | Automation fires at the deadline, the attestation is relayed, the contract settles, and a large payout waits for approval |
| First end-to-end deal | One deal from typed text to settlement with no manual step |
| Five testnet pilot deals | All five settle or refund correctly; panel-disagreement rate and real cost per deal measured against the Economics model |
| Mainnet go / no-go | No misdirected funds in any test; disagreement rate within the 20% re-ask budget; a mainnet path from IMD or our own audited deploy; human audit booked |

## Risks and day-one tests

Three items can change the design, so test them before writing product code: whether 1Claw can sign IMD's Permit2 payment, how IMD derives questionHash, and whether a workflow draft accepts a seeded template.

| Risk | Severity | Mitigation or test |
|------|----------|----------------------|
| 1Claw may not sign IMD's Permit2 payload and quote approval | High | Test on a scratch wallet. Fallback: a small signer service outside 1Claw with the same daily cap |
| questionHash derivation is undocumented and may depend on the pinned block range | High | Read a live attestation. Fallback: payer and payee co-sign the hash from the quote before funding |
| Workflow may refuse a seeded repoUrl and baseCommit | Medium | Test in week one. Without it, add a stricter acceptance list and a post-deploy bytecode check |
| Workflows launch on Sepolia only | High for revenue | Pilot on testnet. Ask IMD for a mainnet date, or plan our own audited deploy path with only the oracle from IMD |
| One attester signer key is a single trust point | High before mainnet | 24-hour challenge window on large deals, disclosure to customers, second oracle behind an interface later |
| Payee controls the evidence | Medium | Prompt-injection test repos, published_at-based definitions, screenshot-free evidence, 1Claw's inspect_content |
| Panel disagreement burns 0.5 IMD and returns no answer | Medium | Templates, dry-run lint, 20% re-ask budget; calibrate in pilots |
| IMD token price swings and thin liquidity | Medium | Small prepaid inventory, USDC quotes refreshed at funding |
| Two young vendors; neither verified as production-hardened | Medium | Thin client interfaces, health checks, grace-period refund |
| IMD's review is not a human audit | High before mainnet | Paid human audit of our escrow template before any real deposit |

### Day-one verification checklist

- [x] Call GET /requests/capabilities, GET /health and GET /reads/rpcs/11155111; record price, quote lifetime and whether Sepolia has a configured RPC. **Done 2026-09-28** — see notes above.
- [x] Send a deliberately bad oracle body to POST /requests/quote and confirm a 422 charges nothing. **Done 2026-09-28** — confirmed free; also surfaced a live blocker, see [DAY-ONE-FINDINGS.md](DAY-ONE-FINDINGS.md).
- [ ] Sign a Permit2 payload and quote approval through 1Claw's Intents API on a scratch wallet.
- [ ] Pay for one oracle.request on a trivial question and read the full attestation, including types and questionHash.
- [ ] Quote a 5-member and a 9-member panel and compare prices.
- [ ] Open one workflow with a seeded template and time it from quote to completed; read the review artifacts.
- [ ] Run the escrow against a repo containing prompt-injection text and a deleted release; record the panel outcome.
- [ ] Read 1Claw's pricing page and confirm Cedar policy and one included runtime on the chosen plan.

Remaining checklist items require spending real IMD tokens on mainnet and/or executing real 1Claw signed transactions — held pending explicit go-ahead. See [DAY-ONE-FINDINGS.md](DAY-ONE-FINDINGS.md) for the full detail behind the two checked items, including a live infrastructure gap that changes the design.

Sources. IMD API docs and 1Claw For AI guide, both read 2026-09-28. The contract sketch, cost model and break-even table are the original design and assumptions, not figures from either site.
