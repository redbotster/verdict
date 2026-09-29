import { test } from "node:test";
import assert from "node:assert/strict";
import { oneClawTypedDataSigner, oneClawChainName } from "../src/typedDataSigner.ts";
import type { OneClawClient } from "../src/client.ts";
import type { EIP712TypedData, SignResult } from "../src/types.ts";

const TYPED_DATA: EIP712TypedData = {
  domain: { name: "Permit2", chainId: 1, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
  types: { Foo: [{ name: "bar", type: "uint256" }] },
  primaryType: "Foo",
  message: { bar: 1n },
};

test("oneClawTypedDataSigner: exposes the given address directly (no network call)", () => {
  const fakeClient = { sign: async () => ({ signature: "0x00", from: "0x00" }) } as unknown as OneClawClient;
  const signer = oneClawTypedDataSigner({ client: fakeClient, agentId: "agent-1", address: "0xF57CfAF1f2b12E7f23C342c4fAfd675379840668", chain: "ethereum" });
  assert.equal(signer.address, "0xF57CfAF1f2b12E7f23C342c4fAfd675379840668");
});

test("oneClawTypedDataSigner: signTypedData calls client.sign with the right agent, chain, and typed data", async () => {
  let captured: unknown;
  const fakeClient = {
    sign: async (agentId: string, request: unknown) => {
      captured = { agentId, request };
      return { signature: "0xabc123", from: "0xF57CfAF1f2b12E7f23C342c4fAfd675379840668" } satisfies SignResult;
    },
  } as unknown as OneClawClient;

  const signer = oneClawTypedDataSigner({ client: fakeClient, agentId: "agent-1", address: "0xF57CfAF1f2b12E7f23C342c4fAfd675379840668", chain: "ethereum" });
  const signature = await signer.signTypedData(TYPED_DATA);

  assert.equal(signature, "0xabc123");
  assert.deepEqual(captured, {
    agentId: "agent-1",
    request: {
      intent_type: "typed_data",
      chain: "ethereum",
      // EIP712Domain is injected — see the withDomainType tests below for why.
      typed_data: { ...TYPED_DATA, types: { ...TYPED_DATA.types, EIP712Domain: [{ name: "name", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] } },
    },
  });
});

test("oneClawTypedDataSigner: injects EIP712Domain into types, matching the domain's actual fields", async () => {
  // 1Claw's server-side EIP-712 hasher requires this explicitly (confirmed live 2026-09-29: 400s
  // "Type 'EIP712Domain' not found in types" without it) — viem's own signTypedData derives it
  // automatically and rejects/ignores it in `types`, so every EIP712TypedData object built for local
  // viem signing throughout this repo omits it. See docs/DAY-ONE-FINDINGS.md §20.
  let capturedTypedData: EIP712TypedData | undefined;
  const fakeClient = {
    sign: async (_agentId: string, request: any) => {
      capturedTypedData = request.typed_data;
      return { signature: "0xabc", from: "0x0" } satisfies SignResult;
    },
  } as unknown as OneClawClient;

  const signer = oneClawTypedDataSigner({ client: fakeClient, agentId: "agent-1", address: "0xF57CfAF1f2b12E7f23C342c4fAfd675379840668", chain: "ethereum" });
  // A domain with all five standard fields, to confirm every one gets mapped to its right type.
  await signer.signTypedData({
    domain: { name: "Test", version: "1", chainId: 1, verifyingContract: "0xabc", salt: "0xdead" },
    types: { Foo: [{ name: "bar", type: "uint256" }] },
    primaryType: "Foo",
    message: { bar: 1n },
  });

  assert.deepEqual(capturedTypedData?.types.EIP712Domain, [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
    { name: "salt", type: "bytes32" },
  ]);
});

test("oneClawTypedDataSigner: doesn't overwrite an EIP712Domain type the caller already supplied", async () => {
  let capturedTypedData: EIP712TypedData | undefined;
  const fakeClient = {
    sign: async (_agentId: string, request: any) => {
      capturedTypedData = request.typed_data;
      return { signature: "0xabc", from: "0x0" } satisfies SignResult;
    },
  } as unknown as OneClawClient;

  const signer = oneClawTypedDataSigner({ client: fakeClient, agentId: "agent-1", address: "0xF57CfAF1f2b12E7f23C342c4fAfd675379840668", chain: "ethereum" });
  const customDomainType = [{ name: "name", type: "string" }];
  await signer.signTypedData({
    domain: { name: "Test", chainId: 1 },
    types: { Foo: [{ name: "bar", type: "uint256" }], EIP712Domain: customDomainType },
    primaryType: "Foo",
    message: { bar: 1n },
  });

  assert.deepEqual(capturedTypedData?.types.EIP712Domain, customDomainType);
});

test("oneClawChainName: maps known EVM chain ids to 1Claw's real chain-name strings", () => {
  assert.equal(oneClawChainName(1), "ethereum");
  assert.equal(oneClawChainName(8453), "base");
  assert.equal(oneClawChainName(11155111), "sepolia");
});

test("oneClawChainName: throws a clear error for an unmapped chain id rather than guessing", () => {
  assert.throws(() => oneClawChainName(999999), /No known 1Claw chain name/);
});
