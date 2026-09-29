# @verdict/imd-client

The server-side client for IMD's paid-request API (`api.imd.fun`) — a thin, hand-rolled `fetch`
wrapper, no SDK dependency, matching this project's `@verdict/oneclaw-client` in style.

## `client.ts` — the 8-step paid-request handshake

`ImdClient` covers `getCapabilities` (static), `quote`, `getChallenge`, `pay`, `getStatus`, and
`pollUntilAdmitted`. The free steps (capabilities, quote, challenge, status, polling) are
live-verified against the real API throughout `docs/DAY-ONE-FINDINGS.md`. `pay()` itself just POSTs
whatever signature strings it's given — see below for how those are now actually produced.

## `paymentSigning.ts` — IMD's real payment-signing schema

Implements the two EIP-712 signatures IMD's paid `submit` step requires, reverse-engineered
2026-09-29 from IMD's own shipped, public frontend (`explorer.imd.fun`'s JS bundle — see
`docs/DAY-ONE-FINDINGS.md` §13 for the full method and the real schema). This was a genuine, hard
blocker for most of this project's history: no public docs, no accessible reference repo, and the
public `x402` package turned out to have zero Permit2 support (§10). Reading IMD's own production
client code — ordinary public, unauthenticated JS any browser downloads — is what actually unblocked
it.

- **`buildPermit2Authorization`** / **`permit2PaymentTypedData`** — signature 1, a Permit2
  `PermitWitnessTransferFrom` (not the plain `PermitTransferFrom` in
  `server/resolver/src/permit2.ts` — IMD's variant carries a `witness: {to, validAfter}` binding the
  transfer's recipient into the permit). The `spender` is a fixed intermediary contract
  (`0x402085c248EeA27D92E8b30b2C58ed07f9E20001`), not IMD's `payTo` directly; the nonce is a fresh
  random 256-bit value (Permit2's nonces are an unordered bitmap, not a counter).
- **`canonicalJson`** / **`paymentPayloadHash`** — the exact recursive sorted-key JSON serializer
  IMD's frontend uses, then `sha256` of it. This produces `paymentHash`, which cryptographically
  binds signature 2 to the exact payload signed in signature 1.
- **`quoteApprovalTypedData`** — signature 2, under a completely different domain
  (`"IdentityMD Paid Action"`, not `"Permit2"`) binding the resource, quote, and `paymentHash`
  together.
- **`encodePaymentSignatureHeader`** — the real `PAYMENT-SIGNATURE` header encoding: standard base64
  (not base64url) of the full payment payload's JSON.

`server/resolver/src/paymentSigner.ts`'s `imdPaymentSigner(account)` wires all of this into a real,
working `PaymentSigner` — no longer a stub — given anything with an `address` and `signTypedData`
(a viem `LocalAccount`, or once 1Claw's Intents API dashboard toggle is flipped, a 1Claw-backed
signer).

**Live-verified with real money (2026-09-29)**: `server/resolver/scripts/imd-real-payment-demo.ts`
ran this for real — a real `oracle.request`, paid for with the wallet's real `$IMD`, **admitted on
the first attempt, no corrections needed**. Real payment transaction:
[`0x4beb83f6b7653d1f49f0bcc61bd371ff9986ce1a38b7542384d0cd6ddd55e1cb`](https://etherscan.io/tx/0x4beb83f6b7653d1f49f0bcc61bd371ff9986ce1a38b7542384d0cd6ddd55e1cb).
Full record, including the real oracle-request response shape this also captured for the first time,
in `docs/DAY-ONE-FINDINGS.md` §14. This is IMD's *current* shipped frontend, not a versioned
contract, though — it can change without notice; re-derive from a fresh bundle fetch if it ever stops
matching IMD's real verification.

## Local setup

```
npm install
npm run typecheck
npm test
```
