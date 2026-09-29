import { randomBytes, createHash } from "node:crypto";
import type { Challenge, Quote, X402Accept } from "./types.ts";

// IMD's real Permit2 payment + quote-approval signing scheme, extracted 2026-09-29 from
// explorer.imd.fun's own shipped, public Next.js frontend bundle (chunk 2-2_bbu6gpe2k.js, minified
// but not obfuscated — function names below are this file's own, not IMD's internal ones). This is
// reverse-engineered from IMD's own production client code, not guessed, not from a private repo,
// and not from any authenticated or access-controlled source — it's what IMD serves to every visitor
// of a public page. Cross-checked against IMD's own docs.imd.fun prose (the "sign the Permit2 payment
// and IMD's additional EIP-712 quote approval with the same wallet" description matches exactly) and
// against the openapi.json's `x-imd-quote-approval` field, both already documented in
// docs/DAY-ONE-FINDINGS.md. Caveat: this is IMD's *current* frontend, not a published, versioned
// contract — it could change without notice. Re-verify against a fresh fetch of that bundle if
// anything here stops working.

export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
// The Permit2 permit's `spender` is NOT IMD's payTo directly — it's a separate, fixed intermediary
// contract that (presumably) pulls via Permit2 and forwards to payTo. Confirmed live in the bundle,
// hardcoded as the sole argument to the frontend's payment-builder function.
export const IMD_PERMIT2_SPENDER = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001" as const;

export const QUOTE_APPROVAL_DOMAIN_NAME = "IdentityMD Paid Action";
export const QUOTE_APPROVAL_DOMAIN_VERSION = "1";

export interface EIP712TypedData {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

// The JSON-safe form stored in the payment payload and hashed for paymentHash — note this uses
// decimal-string amounts/nonce/deadline (JSON has no bigint), distinct from the typed-data message
// passed to a signer, which uses real bigints for those same fields (see permit2PaymentTypedData).
export interface Permit2Authorization {
  from: `0x${string}`;
  permitted: { token: `0x${string}`; amount: string };
  spender: `0x${string}`;
  nonce: string;
  deadline: string;
  witness: { to: `0x${string}`; validAfter: string };
}

function chainIdFromNetwork(network: string): number {
  const m = /^eip155:(\d+)$/.exec(network);
  if (!m) throw new Error(`Invalid CAIP-2 chain ID: ${network} (expected eip155:CHAIN_ID)`);
  return Number(m[1]);
}

// Builds the Permit2 authorization object for a given payer and accepted payment method. `accept`
// is normally `challenge.accepts[0]` (IMD's only listed option so far). deadline = now +
// maxTimeoutSeconds, matching the frontend exactly. nonce is a fresh random 256-bit value — Permit2's
// nonces are an unordered bitmap, not a sequential counter, so any unused value works.
// Addresses here are lowercased rather than checksummed (the live bundle uses viem's getAddress()
// checksum instead). Deliberate, not an oversight: EIP-712 encodes `address` fields as raw 20 bytes
// regardless of the JS string's case, so it changes neither the Permit2 signature nor its on-chain
// verification. The only place string case could matter is paymentPayloadHash below, which hashes
// this exact object — since that hash is always computed from (and submitted alongside) this same
// object, it's self-consistent under any casing convention. Matches this project's existing
// lowercase-address convention elsewhere (see docs/DAY-ONE-FINDINGS.md §5) rather than adding a
// keccak256 dependency just to replicate checksumming that has no functional effect here.
export function buildPermit2Authorization(payer: `0x${string}`, accept: X402Accept): Permit2Authorization {
  const nonce = BigInt(`0x${randomBytes(32).toString("hex")}`).toString();
  const deadline = (Math.floor(Date.now() / 1000) + accept.maxTimeoutSeconds).toString();
  return {
    from: payer,
    permitted: { token: accept.asset.toLowerCase() as `0x${string}`, amount: accept.amount },
    spender: IMD_PERMIT2_SPENDER,
    nonce,
    deadline,
    witness: { to: accept.payTo.toLowerCase() as `0x${string}`, validAfter: "0" },
  };
}

// Signature 1 of 2 ("the payment"): a Permit2 PermitWitnessTransferFrom, witnessed with {to, validAfter}
// binding the transfer's ultimate recipient into the permit itself (not just the spender). Domain,
// types, and the witness shape are IMD's own, confirmed from the live bundle — not part of the public
// x402 package (see docs/DAY-ONE-FINDINGS.md §10) and not Permit2's plain PermitTransferFrom (that's
// the generic, witness-less variant implemented separately in server/resolver/src/permit2.ts).
export function permit2PaymentTypedData(network: string, auth: Permit2Authorization): EIP712TypedData {
  return {
    domain: { name: "Permit2", chainId: chainIdFromNetwork(network), verifyingContract: PERMIT2_ADDRESS },
    types: {
      PermitWitnessTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "witness", type: "Witness" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      Witness: [
        { name: "to", type: "address" },
        { name: "validAfter", type: "uint256" },
      ],
    },
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: { token: auth.permitted.token, amount: BigInt(auth.permitted.amount) },
      spender: auth.spender,
      nonce: BigInt(auth.nonce),
      deadline: BigInt(auth.deadline),
      witness: { to: auth.witness.to, validAfter: BigInt(auth.witness.validAfter) },
    },
  };
}

export interface PaymentPayload {
  x402Version: 2;
  payload: { signature: `0x${string}`; permit2Authorization: Permit2Authorization };
  accepted: X402Accept;
}

// Exact canonical-JSON serializer from the live bundle: recursively sorts object keys, standard
// JSON encoding for primitives/arrays, throws on non-finite/non-integer numbers, undefined values,
// or non-plain objects. Order matters for the hash below — this must byte-for-byte match what IMD's
// own server presumably recomputes to verify paymentHash.
export function canonicalJson(value: unknown): string {
  function encode(v: unknown): string {
    if (v === null) return "null";
    switch (typeof v) {
      case "boolean":
        return v ? "true" : "false";
      case "number":
        if (!Number.isFinite(v)) throw new Error("non-finite number");
        if (!Number.isInteger(v)) throw new Error("non-integer number");
        return JSON.stringify(v === 0 ? 0 : v);
      case "string":
        return JSON.stringify(v);
      case "object": {
        if (Array.isArray(v)) return `[${v.map(encode).join(",")}]`;
        const proto = Object.getPrototypeOf(v);
        if (proto === Object.prototype || proto === null) {
          const obj = v as Record<string, unknown>;
          const entries = Object.keys(obj)
            .sort()
            .map((k) => {
              const val = obj[k];
              if (val === undefined) throw new Error(`undefined at key "${k}"`);
              return `${JSON.stringify(k)}:${encode(val)}`;
            });
          return `{${entries.join(",")}}`;
        }
        throw new Error("unsupported object");
      }
      default:
        throw new Error(`unsupported type "${typeof v}"`);
    }
  }
  return encode(value);
}

// sha256(canonicalJson(paymentPayload)) as 0x-prefixed hex — the self-referential hash that binds
// the quote-approval signature to the exact payment payload signed alongside it.
export function paymentPayloadHash(payload: PaymentPayload): `0x${string}` {
  const digest = createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
  return `0x${digest}`;
}

// Signature 2 of 2 ("the quote"): binds the resource, the quote's own hash, and the just-computed
// paymentHash together, so a valid payment signature can't be replayed against a different quote or
// vice versa. Domain name/version and the field list are IMD's own (confirmed live), distinct from
// Permit2's domain.
export function quoteApprovalTypedData(
  quote: Quote,
  challenge: Pick<Challenge, "requesterScopeHash" | "resourceUrl">,
  payload: PaymentPayload,
): EIP712TypedData {
  return {
    domain: {
      name: QUOTE_APPROVAL_DOMAIN_NAME,
      version: QUOTE_APPROVAL_DOMAIN_VERSION,
      chainId: chainIdFromNetwork(quote.payment.network),
    },
    primaryType: "QuoteApproval",
    types: {
      QuoteApproval: [
        { name: "resource", type: "string" },
        { name: "requesterScopeHash", type: "bytes32" },
        { name: "quoteId", type: "string" },
        { name: "quoteHash", type: "bytes32" },
        { name: "paymentHash", type: "bytes32" },
        { name: "action", type: "string" },
        { name: "asset", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "payTo", type: "address" },
        { name: "expiresAt", type: "uint256" },
      ],
    },
    message: {
      resource: challenge.resourceUrl,
      requesterScopeHash: hexPrefixed(challenge.requesterScopeHash),
      quoteId: quote.id,
      quoteHash: hexPrefixed(quote.quoteHash),
      paymentHash: paymentPayloadHash(payload),
      action: quote.action,
      asset: quote.payment.asset,
      amount: BigInt(quote.payment.amount),
      payTo: quote.payment.payTo,
      expiresAt: BigInt(quote.expiresAt),
    },
  };
}

function hexPrefixed(s: string): `0x${string}` {
  return (s.startsWith("0x") ? s : `0x${s}`) as `0x${string}`;
}

// The exact PAYMENT-SIGNATURE header value: standard base64 (not base64url) of the payment
// payload's JSON, confirmed live from the bundle's actual submit call
// (`headers: {"payment-signature": btoa(JSON.stringify(payment))}`).
export function encodePaymentSignatureHeader(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}
