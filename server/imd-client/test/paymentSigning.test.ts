import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PERMIT2_ADDRESS,
  IMD_PERMIT2_SPENDER,
  QUOTE_APPROVAL_DOMAIN_NAME,
  QUOTE_APPROVAL_DOMAIN_VERSION,
  buildPermit2Authorization,
  permit2PaymentTypedData,
  canonicalJson,
  paymentPayloadHash,
  quoteApprovalTypedData,
  encodePaymentSignatureHeader,
} from "../src/paymentSigning.ts";
import type { PaymentPayload } from "../src/paymentSigning.ts";
import type { Quote, X402Accept } from "../src/types.ts";

const ACCEPT: X402Accept = {
  scheme: "exact",
  network: "eip155:1",
  asset: "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7",
  amount: "500000000000000000",
  payTo: "0x4e0fa57bde726079356537e2f34d671e9f41adbc",
  maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: "permit2" },
};

const QUOTE: Quote = {
  v: 1,
  id: "order-1",
  action: "oracle.request",
  policyVersion: "oracle-1",
  inputHash: "a".repeat(64),
  issuedAt: 1_000_000,
  expiresAt: 1_000_600,
  payment: { network: "eip155:1", asset: ACCEPT.asset, amount: ACCEPT.amount, payTo: ACCEPT.payTo, decimals: 18, scheme: "exact" },
  terms: { purchase: "action-admission", resultGuaranteed: false },
  quoteHash: "b".repeat(64),
};

// canonicalJson: real, exact recursive sorted-key serializer extracted from IMD's own shipped
// frontend (see docs/DAY-ONE-FINDINGS.md §13) — key order in the input must not affect the output.
test("canonicalJson: sorts object keys regardless of input order", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: 2, b: 1 }), '{"a":2,"b":1}');
});

test("canonicalJson: recurses into nested objects and arrays", () => {
  assert.equal(canonicalJson({ z: { d: 1, c: 2 }, a: [3, { y: 1, x: 2 }] }), '{"a":[3,{"x":2,"y":1}],"z":{"c":2,"d":1}}');
});

test("canonicalJson: rejects undefined values and non-finite numbers", () => {
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson({ a: Infinity }));
  assert.throws(() => canonicalJson({ a: 1.5 }));
});

test("buildPermit2Authorization: uses IMD's real fixed spender and a maxTimeoutSeconds-based deadline", () => {
  const payer = "0xF57CfAF1f2b12E7f23C342c4fAfd675379840668" as const;
  const before = Math.floor(Date.now() / 1000);
  const auth = buildPermit2Authorization(payer, ACCEPT);
  const after = Math.floor(Date.now() / 1000);

  assert.equal(auth.from, payer);
  assert.equal(auth.spender, IMD_PERMIT2_SPENDER);
  assert.equal(auth.permitted.token, ACCEPT.asset.toLowerCase());
  assert.equal(auth.permitted.amount, ACCEPT.amount);
  assert.equal(auth.witness.to, ACCEPT.payTo.toLowerCase());
  assert.equal(auth.witness.validAfter, "0");

  const deadline = Number(auth.deadline);
  assert.ok(deadline >= before + ACCEPT.maxTimeoutSeconds && deadline <= after + ACCEPT.maxTimeoutSeconds);

  // nonce is a random 256-bit value, not a small counter
  assert.ok(BigInt(auth.nonce) > 0n);
  assert.ok(BigInt(auth.nonce) < 2n ** 256n);
});

test("buildPermit2Authorization: nonces are not reused across calls", () => {
  const payer = "0xF57CfAF1f2b12E7f23C342c4fAfd675379840668" as const;
  const a = buildPermit2Authorization(payer, ACCEPT);
  const b = buildPermit2Authorization(payer, ACCEPT);
  assert.notEqual(a.nonce, b.nonce);
});

test("permit2PaymentTypedData: matches IMD's real domain/types (Permit2, PermitWitnessTransferFrom)", () => {
  const auth = buildPermit2Authorization("0xF57CfAF1f2b12E7f23C342c4fAfd675379840668", ACCEPT);
  const typedData = permit2PaymentTypedData("eip155:1", auth);

  assert.deepEqual(typedData.domain, { name: "Permit2", chainId: 1, verifyingContract: PERMIT2_ADDRESS });
  assert.equal(typedData.primaryType, "PermitWitnessTransferFrom");
  assert.deepEqual(typedData.types.PermitWitnessTransferFrom, [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "Witness" },
  ]);
  assert.deepEqual(typedData.types.TokenPermissions, [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ]);
  assert.deepEqual(typedData.types.Witness, [
    { name: "to", type: "address" },
    { name: "validAfter", type: "uint256" },
  ]);
  assert.deepEqual(typedData.message, {
    permitted: { token: auth.permitted.token, amount: BigInt(auth.permitted.amount) },
    spender: auth.spender,
    nonce: BigInt(auth.nonce),
    deadline: BigInt(auth.deadline),
    witness: { to: auth.witness.to, validAfter: BigInt(auth.witness.validAfter) },
  });
});

test("permit2PaymentTypedData: rejects a malformed network string", () => {
  const auth = buildPermit2Authorization("0xF57CfAF1f2b12E7f23C342c4fAfd675379840668", ACCEPT);
  assert.throws(() => permit2PaymentTypedData("not-a-caip2-id", auth));
});

function fakePayload(auth: ReturnType<typeof buildPermit2Authorization>): PaymentPayload {
  return {
    x402Version: 2,
    payload: { signature: "0xdeadbeef" as `0x${string}`, permit2Authorization: auth },
    accepted: ACCEPT,
  };
}

test("paymentPayloadHash: deterministic and sensitive to any field change", () => {
  const auth = buildPermit2Authorization("0xF57CfAF1f2b12E7f23C342c4fAfd675379840668", ACCEPT);
  const payload = fakePayload(auth);
  const h1 = paymentPayloadHash(payload);
  const h2 = paymentPayloadHash(payload);
  assert.equal(h1, h2);
  assert.match(h1, /^0x[0-9a-f]{64}$/);

  const tampered = fakePayload({ ...auth, nonce: (BigInt(auth.nonce) + 1n).toString() });
  assert.notEqual(paymentPayloadHash(tampered), h1);
});

test("quoteApprovalTypedData: matches IMD's real domain/types (IdentityMD Paid Action, QuoteApproval)", () => {
  const auth = buildPermit2Authorization("0xF57CfAF1f2b12E7f23C342c4fAfd675379840668", ACCEPT);
  const payload = fakePayload(auth);
  const challenge = { requesterScopeHash: "cc".repeat(32), resourceUrl: "https://api.imd.fun/requests/order-1" };
  const typedData = quoteApprovalTypedData(QUOTE, challenge, payload);

  assert.deepEqual(typedData.domain, { name: QUOTE_APPROVAL_DOMAIN_NAME, version: QUOTE_APPROVAL_DOMAIN_VERSION, chainId: 1 });
  assert.equal(typedData.primaryType, "QuoteApproval");
  assert.deepEqual(typedData.types.QuoteApproval, [
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
  ]);
  assert.equal(typedData.message.resource, challenge.resourceUrl);
  assert.equal(typedData.message.requesterScopeHash, `0x${challenge.requesterScopeHash}`);
  assert.equal(typedData.message.quoteId, QUOTE.id);
  assert.equal(typedData.message.quoteHash, `0x${QUOTE.quoteHash}`);
  assert.equal(typedData.message.paymentHash, paymentPayloadHash(payload));
  assert.equal(typedData.message.action, QUOTE.action);
  assert.equal(typedData.message.amount, BigInt(QUOTE.payment.amount));
  assert.equal(typedData.message.expiresAt, BigInt(QUOTE.expiresAt));
});

test("encodePaymentSignatureHeader: standard base64 that round-trips to the exact JSON", () => {
  const auth = buildPermit2Authorization("0xF57CfAF1f2b12E7f23C342c4fAfd675379840668", ACCEPT);
  const payload = fakePayload(auth);
  const encoded = encodePaymentSignatureHeader(payload);
  const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  assert.equal(decoded.x402Version, 2);
  assert.equal(decoded.payload.signature, "0xdeadbeef");
  assert.equal(decoded.payload.permit2Authorization.nonce, auth.nonce);
});
