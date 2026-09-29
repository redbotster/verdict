import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { permit2TypedData, verifyPermit2Signature, signPermit2Transfer, PERMIT2_ADDRESS, type IntentsSigner } from "../src/permit2.ts";

const PERMIT = {
  token: "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7" as const,
  amount: 500_000_000_000_000_000n,
  spender: "0x4e0fa57bde726079356537e2f34d671e9f41adbc" as const,
  nonce: 0n,
  deadline: 1_800_000_000n,
};

test("permit2TypedData: matches Permit2's real public schema exactly (Uniswap/permit2 PermitHash.sol)", () => {
  const typedData = permit2TypedData(PERMIT, 1);
  assert.deepEqual(typedData.domain, { name: "Permit2", chainId: 1, verifyingContract: PERMIT2_ADDRESS });
  assert.equal(typedData.primaryType, "PermitTransferFrom");
  assert.deepEqual(typedData.types.PermitTransferFrom, [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ]);
  assert.deepEqual(typedData.types.TokenPermissions, [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ]);
  assert.deepEqual(typedData.message, {
    permitted: { token: PERMIT.token, amount: PERMIT.amount.toString() },
    spender: PERMIT.spender,
    nonce: PERMIT.nonce.toString(),
    deadline: PERMIT.deadline.toString(),
  });
});

test("verifyPermit2Signature: a real local signature over the exact typed data verifies true", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const typedData = permit2TypedData(PERMIT, 1);
  const signature = await account.signTypedData({
    domain: typedData.domain as Parameters<typeof account.signTypedData>[0]["domain"],
    types: typedData.types as Parameters<typeof account.signTypedData>[0]["types"],
    primaryType: "PermitTransferFrom",
    message: typedData.message,
  });
  assert.equal(await verifyPermit2Signature(typedData, signature, account.address), true);
});

test("verifyPermit2Signature: a signature from the wrong signer verifies false", async () => {
  const signer = privateKeyToAccount(generatePrivateKey());
  const impostor = privateKeyToAccount(generatePrivateKey());
  const typedData = permit2TypedData(PERMIT, 1);
  const signature = await signer.signTypedData({
    domain: typedData.domain as Parameters<typeof signer.signTypedData>[0]["domain"],
    types: typedData.types as Parameters<typeof signer.signTypedData>[0]["types"],
    primaryType: "PermitTransferFrom",
    message: typedData.message,
  });
  assert.equal(await verifyPermit2Signature(typedData, signature, impostor.address), false);
});

test("verifyPermit2Signature: tampering with the amount after signing invalidates it", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const typedData = permit2TypedData(PERMIT, 1);
  const signature = await account.signTypedData({
    domain: typedData.domain as Parameters<typeof account.signTypedData>[0]["domain"],
    types: typedData.types as Parameters<typeof account.signTypedData>[0]["types"],
    primaryType: "PermitTransferFrom",
    message: typedData.message,
  });
  const tampered = { ...typedData, message: { ...typedData.message, permitted: { token: PERMIT.token, amount: "999999999999999999" } } };
  assert.equal(await verifyPermit2Signature(tampered, signature, account.address), false);
});

test("signPermit2Transfer: calls the signer with the exact typed data and returns its signature", async () => {
  let captured: unknown;
  const fakeSigner: IntentsSigner = {
    sign: async (agentId, request) => {
      captured = { agentId, request };
      return { signature: "0xdeadbeef" as `0x${string}`, from: "0x0000000000000000000000000000000000dead" };
    },
  };
  const { signature, typedData } = await signPermit2Transfer(fakeSigner, "agent-1", "ethereum", 1, PERMIT);
  assert.equal(signature, "0xdeadbeef");
  assert.deepEqual(typedData, permit2TypedData(PERMIT, 1));
  assert.deepEqual(captured, {
    agentId: "agent-1",
    request: { intent_type: "typed_data", chain: "ethereum", typed_data: permit2TypedData(PERMIT, 1) },
  });
});
