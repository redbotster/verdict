# Multi-tenant Verdict: Sign in with 1Claw + embedded wallets

Branch: `multi-tenant`. Written 2026-09-30.

## Problem

Every real proof so far (`docs/DAY-ONE-FINDINGS.md`) uses one ops wallet playing payer,
payee, deployer, and resolver, funded from a private key in `~/.secrets/verdict.env`.
Opening Verdict to real third parties needs, at minimum: per-user identity, per-user
custody, self-service funding (no more hand-rolled Uniswap scripts), and a multi-tenant
data model in `site/`.

## Decision: build on 1Claw's real Embedded Wallets product

This is confirmed live against `docs.1claw.co` (2026-09-30) and is a **separate 1Claw
primitive** from what `server/oneclaw-client` already integrates — don't conflate them:

| | Existing (`server/oneclaw-client`) | New (this plan) |
|---|---|---|
| Principal | AI agent | Human end-user |
| 1Claw primitive | Agent + `signing_keys`, Intents API | Platform App (`plt_...` key) + Treasury wallets |
| Auth | Agent API key (`ocv_...`) | Email OTP / social login / passkeys / "Sign in with 1Claw" OAuth |
| Key storage | `__agent-keys` vault | `__treasury-keys` vault (human-only — agents get `403`) |
| Package | `@1claw/sdk` (already a dependency) | `@1claw/sdk` (Platform API + auth) + `@1claw/wallet-react` (new) |

Real, doc-confirmed capabilities (not assumed — read directly off `docs.1claw.co`):

- **Sign in with 1Claw** is a real OAuth2 + PKCE authorization server. `buildAuthorizeUrl()`
  / `exchangeOAuthCode()` in `@1claw/sdk`, or the `<SignInWith1Claw>` React component.
  Scopes: `openid`, `profile`, `email`, `wallet`. Discovery at
  `GET /.well-known/openid-configuration`.
- **Social wallets** are real: Email OTP and Google/Apple/Discord social login each
  auto-provision an HSM-backed "treasury wallet" per chain on first login. No seed phrase
  ever shown to the user.
- **Embedded wallet widget**: `@1claw/wallet-react`'s
  `<OneclawEmbeddedWallet chains={[...]} features={["send","swap","receive","buy"]} />` —
  drop-in UI, or `useOneclawWallet()` headless.
- **Swap is already built in**: `POST /v1/treasury/wallets/{chain}/swap` signs via the 0x
  DEX aggregator (EVM-only). This *is* the "swap interface" from the proposal — no need to
  hand-roll another Uniswap script like `§11`/`§19`/`§26` did for the ops wallet.
- **Fiat on/off-ramp is also built in**: Coinbase Onramp + MoonPay, via the same widget's
  `features: ["buy"]`.
- **Custody is a declared choice per wallet**: managed (HSM/KMS-wrapped, 1Claw signs
  server-side after policy) or self-custody (passkey-owned Safe on EVM, 2-of-2 FROST on
  Solana). The wallet record states which. This is a real product decision, not a default
  to inherit silently — see Open decisions.
- **1Claw's "Platform App" is itself a multi-tenancy primitive**: `POST
  /v1/platform/users/upsert` provisions a connected user; an optional bootstrap template
  auto-creates a vault/agent/policy set per user.

Sources: `1claw.co/embedded-wallets`, `docs.1claw.co/docs/guides/embedded-wallets/*`,
`docs.1claw.co/docs/treasury/overview`. Packages verified live on npm:
`@1claw/wallet-react@0.6.1`, `@1claw/sdk@0.61.36`.

## What this solves vs. the known gap list

| Gap (README "Known gaps" / prior discussion) | Status under this plan |
|---|---|
| No per-user wallets / self-service funding | **Solved** — real embedded wallet + built-in swap + fiat ramp |
| No multi-tenancy in `site/` | **Partially solved** — 1Claw's Platform API gives per-user identity/wallet provisioning; `site/`'s own Supabase schema still needs per-user scoping on top (see Phase 3) |
| No dispute/appeal path beyond IMD's binary answer | Untouched — out of scope here |
| No recovery path if an approval is denied after a true attestation lands | Untouched — out of scope here |
| No paid third-party audit | Untouched — out of scope here |

**New consideration this plan introduces**: an embedded *managed* wallet is custodial —
funds sit in a 1Claw/GCP-KMS-wrapped key your app provisioned, not a wallet the user holds
keys to. That's a legitimate, much better UX for non-crypto-native users, but it's a real
trust/legal distinction to be upfront about, and it's a decision, not a default (self-custody
passkey Safes are the alternative 1Claw itself documents).

## Architecture

```
User
  |
  |  Sign in with 1Claw (OAuth+PKCE)  or  Email OTP / social login
  v
site/  (new: auth pages, wallet page)
  |
  |  POST /v1/platform/users/upsert           (Platform API, plt_ key)
  |  auto_provision_chains: ["ethereum"]       (matches IMD's mainnet-only payment network)
  v
1Claw Platform API  ->  __treasury-keys vault  ->  per-user HSM wallet (Ethereum)
  |
  |  <OneclawEmbeddedWallet features={["send","swap","receive","buy"]} />
  v
User's embedded wallet: buy/swap into real $IMD, see balance, send
  |
  |  user's OWN wallet deploys + funds MilestoneEscrow (not the shared ops wallet)
  v
contracts/MilestoneEscrow.sol   (unchanged)
  |
  v
server/resolver   (unchanged — still uses IMD + the existing agent-signing 1Claw integration
                    for the resolver's OWN on-chain writes, a separate principal from the
                    payer/payee's embedded wallets)
```

The resolver's own signing path (`server/oneclaw-client`, agent + Intents API) is untouched
— it's infrastructure, not per-user. Only the escrow's payer/payee addresses change, from the
one shared ops wallet to real per-user treasury wallets.

## Open decisions (need a real answer before building, not an assumed default)

1. **Custody model**: managed wallets (best UX, custodial) vs. self-custody passkey Safes
   (real self-custody, more friction) for payers/payees. This changes the trust story
   materially — worth deciding deliberately.
2. **Auth mix**: offer email OTP + all three social providers + "Sign in with 1Claw" from
   day one, or start narrower?
3. **Confirm `$IMD` is actually swappable via the 0x aggregator** before building the whole
   funding flow around it — 1Claw's swap endpoint is a real, generic 0x integration, but
   `$IMD`'s actual on-chain liquidity depends on 0x's routing, not on 1Claw. Cheap to check
   for real with a small quote before committing.
4. **Spend policies**: what `max_value_per_tx`/`daily_limit` make sense, given deals can be
   arbitrary sizes? Too tight blocks legitimate deals; too loose defeats the point.
5. **Where 1Claw's Platform API sits relative to `site/`'s existing Supabase schema.**
   Recommendation: keep Supabase as the deal-record source of truth; add a
   `oneclaw_connection_id` / wallet address column per deal party rather than replacing
   Supabase with 1Claw's own user store.

## Implementation phases

**Phase 1 — Auth + wallet foundation**
- Add `@1claw/wallet-react` and the Platform API surface of `@1claw/sdk` to `site/`.
- Register a Platform App (`plt_...` key) — a new secret, distinct from the existing
  agent-signing key `server/oneclaw-client` already uses.
- Add sign-in (email OTP and/or "Sign in with 1Claw") to `site/` — there is currently no
  end-user auth at all, so this is new, not a replacement.
- `auto_provision_chains: ["ethereum"]` on first login, matching IMD's Ethereum-mainnet-only
  payment network (`docs/SPEC.md`).

**Phase 2 — Embedded wallet UI**
- New `/wallet` page with `<OneclawEmbeddedWallet chains={["ethereum"]}
  features={["send","swap","receive","buy"]} />`.
- Real test: a small real swap into `$IMD` (a few dollars), to settle Open decision 3 before
  building further on top of it.

**Status (2026-09-30): Phases 1–2 done and verified live.** Registered a real Platform App
(`Verdict`, id `57657f05-a672-4352-a2ce-ab7557cf572f`), built `site/app/wallet/`, and confirmed
in a real browser that the widget mounts, calls the real Platform API with the real `plt_`
key, and correctly falls back to the sign-in screen pre-login. Built against the installed
`@1claw/wallet-react` package's actual `.d.ts`, which disagrees with the docs' sample code in
several places (`features` is `{send,swap,buy,receive}` booleans, not a string array; `theme`
is `"light"|"dark"|"auto"`, not `"system"`; `appId` is a required prop). Not yet done: a real
sign-in (needs a real inbox for the OTP code) and settling Open decision 3 (a real `$IMD` swap
test).

**Phase 3 — Multi-tenant deal flow (real finding narrowed this phase's scope)**

While building this, found that 1Claw's embedded/treasury wallet API — confirmed by reading
the actual Send/Swap/Receive and Advanced guides, not assumed — only exposes `send` (simple
transfers) and `swap` (0x DEX). There is no generic sign-message/typed-data endpoint and no
contract-deployment endpoint for human treasury wallets (`send`'s `data` field exists in the
real SDK types but `to` is required, so it can call a contract, not deploy one). That means
the embedded wallet, as built, **cannot** replace what `/new`'s existing `window.ethereum`
flow does: signing `payerAuthorization`/`payeeAcknowledgment` or deploying
`MilestoneEscrow.sol`. The more capable option — 1Claw's Safe multisig treasuries, whose
proposals accept arbitrary `to`/`data`/`operation` — could support this, but means deploying a
Safe per user and wiring a proposal→sign→execute lifecycle: real additional scope, not what
was planned.

Decided (2026-09-30): keep the embedded wallet to **funding only**. A user signs in, buys or
swaps into `$IMD` via the widget's built-in `buy`/`swap` views, then uses the widget's own
`send` view to move it to whatever wallet they'll use to deploy/sign — `/new`'s
`window.ethereum` flow is unchanged. This needed no new UI: the `send`/`swap`/`buy` features
enabled in Phase 2 already cover it.

Built:
- `deals` table: added a nullable `owner_oneclaw_user_id` column
  (`site/supabase/migrations/0001_add_owner_oneclaw_user_id.sql`, applied for real against the
  live instance), and threaded `ownerOneclawUserId` through `DealMetadata`/`DealRow`/
  `CreateDealInput` in `site/lib/deals.ts`.

Deliberately not built yet — this is schema/type readiness, not working multi-tenancy:
nothing populates or enforces `owner_oneclaw_user_id`. That needs a real session mechanism
linking a signed-in embedded-wallet user (client-side) to `/new`'s server actions, which
wasn't decided (see Open decision 5) and is a real design choice, not a default to assume.

**Phase 4 — Spend policies**
- Configure real spend limits (Open decision 4) before any real third-party funds move
  through this.

## Explicitly out of scope for this plan

- Dispute/appeal mechanism beyond IMD's binary oracle answer.
- Approval-gate recovery path for a denied approval after a true attestation lands.
- A paid third-party security audit.

These are real, known gaps (see README "Known gaps") — unchanged by this plan, which only
addresses identity, custody, funding, and multi-tenancy.
