import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { imdPaymentSigner } from "../src/paymentSigner.ts";
import { permit2PaymentTypedData, buildPermit2Authorization, quoteApprovalTypedData } from "../../imd-client/src/paymentSigning.ts";
import type { Challenge, Quote, X402Accept } from "../../imd-client/src/types.ts";

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
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  payment: { network: "eip155:1", asset: ACCEPT.asset, amount: ACCEPT.amount, payTo: ACCEPT.payTo, decimals: 18, scheme: "exact" },
  terms: { purchase: "action-admission", resultGuaranteed: false },
  quoteHash: "b".repeat(64),
};

const CHALLENGE: Challenge = {
  x402Version: 2,
  resource: { url: "https://api.imd.fun/requests/order-1" },
  accepts: [ACCEPT],
  quote: QUOTE,
  requesterScopeHash: "cc".repeat(32),
  resourceUrl: "https://api.imd.fun/requests/order-1",
  input: {},
};

// This is the real payment-signing schema reverse-engineered from IMD's own shipped frontend (see
// docs/DAY-ONE-FINDINGS.md §13) — never live-tested against a real paid submission. What this test
// DOES prove: both signatures imdPaymentSigner produces are genuinely valid EIP-712 signatures that
// independently recover to the signer's own address — not just well-formed-looking output.
test("imdPaymentSigner: produces two independently-verifiable real signatures", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const signer = imdPaymentSigner(account);

  const { paymentSignatureB64, quoteSignature } = await signer(CHALLENGE);

  const decoded = JSON.parse(Buffer.from(paymentSignatureB64, "base64").toString("utf8"));
  assert.equal(decoded.x402Version, 2);
  assert.equal(decoded.accepted.asset, ACCEPT.asset);

  const auth = decoded.payload.permit2Authorization;
  const paymentTypedData = permit2PaymentTypedData(ACCEPT.network, auth);
  const recoveredPayer = await recoverTypedDataAddress({
    domain: paymentTypedData.domain as Parameters<typeof recoverTypedDataAddress>[0]["domain"],
    types: paymentTypedData.types as Parameters<typeof recoverTypedDataAddress>[0]["types"],
    primaryType: paymentTypedData.primaryType,
    message: paymentTypedData.message,
    signature: decoded.payload.signature,
  });
  assert.equal(recoveredPayer.toLowerCase(), account.address.toLowerCase());

  const approvalTypedData = quoteApprovalTypedData(QUOTE, CHALLENGE, decoded);
  const recoveredApprover = await recoverTypedDataAddress({
    domain: approvalTypedData.domain as Parameters<typeof recoverTypedDataAddress>[0]["domain"],
    types: approvalTypedData.types as Parameters<typeof recoverTypedDataAddress>[0]["types"],
    primaryType: approvalTypedData.primaryType,
    message: approvalTypedData.message,
    signature: quoteSignature as `0x${string}`,
  });
  assert.equal(recoveredApprover.toLowerCase(), account.address.toLowerCase());
});

test("imdPaymentSigner: throws clearly when the challenge has no accepted payment methods", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const signer = imdPaymentSigner(account);
  await assert.rejects(() => signer({ ...CHALLENGE, accepts: [] }), /accepts is empty/);
});

test("imdPaymentSigner: a tampered payment payload no longer verifies (sanity check on the recovery itself)", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const signer = imdPaymentSigner(account);
  const { paymentSignatureB64 } = await signer(CHALLENGE);
  const decoded = JSON.parse(Buffer.from(paymentSignatureB64, "base64").toString("utf8"));

  const tamperedAuth = buildPermit2Authorization(account.address, { ...ACCEPT, amount: "999999999999999999" });
  const typedData = permit2PaymentTypedData(ACCEPT.network, tamperedAuth);
  const recovered = await recoverTypedDataAddress({
    domain: typedData.domain as Parameters<typeof recoverTypedDataAddress>[0]["domain"],
    types: typedData.types as Parameters<typeof recoverTypedDataAddress>[0]["types"],
    primaryType: typedData.primaryType,
    message: typedData.message,
    signature: decoded.payload.signature,
  });
  assert.notEqual(recovered.toLowerCase(), account.address.toLowerCase());
});
