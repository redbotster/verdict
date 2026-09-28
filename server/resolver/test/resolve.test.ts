import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDeal } from "../src/resolve.ts";
import type { GetAttestationFn } from "../src/resolve.ts";
import type { SignedAttestation, EscrowRef } from "../src/types.ts";
import type { OracleRequestInput } from "../../oracle-compiler/src/types.ts";
import type { PublicClient, WalletClient, Account, Chain, Transport } from "viem";

const ESCROW: EscrowRef = { address: "0x000000000000000000000000000000000000ee", chainId: 11155111 };
const QUESTION_HASH = "0x1111111111111111111111111111111111111111111111111111111111111" as `0x${string}`;

const ORACLE_INPUT: OracleRequestInput = {
  v: 1,
  question: "Did acme/widget publish a release by 2026-10-16?",
  chainId: 1,
  window: { hours: 24 },
  answerType: "bool",
  evidence: "panel",
  panelSize: 5,
  quorum: 4,
  validForSeconds: 604800,
  definitions: { project: "x", calendar: "x", missing: "x" },
  guards: { sources: ["https://github.com/acme/widget/"], minSources: 1 },
  consumer: { chainId: 1, verifyingContract: "0x000000000000000000000000000000000000dead" },
};

function fakeAttestation(overrides: Partial<SignedAttestation["message"]> = {}): SignedAttestation {
  return {
    message: {
      requestId: 1n,
      chainId: BigInt(ESCROW.chainId),
      questionHash: QUESTION_HASH,
      answerType: "bool",
      answer: true,
      figure: "",
      fromBlock: 1n,
      toBlock: 2n,
      panelJobId: "panel-1",
      issuedAt: 1000n,
      expiresAt: 2000n,
      ...overrides,
    },
    signature: "0xsig" as `0x${string}`,
  };
}

interface FakeClients {
  walletClient: WalletClient<Transport, Chain, Account>;
  publicClient: PublicClient;
  writeCalls: { functionName: string }[];
}

function fakeClients(opts: { releaseShouldFail?: boolean } = {}): FakeClients {
  const writeCalls: { functionName: string }[] = [];
  const releaseShouldFail = opts.releaseShouldFail ?? false;

  const walletClient = {
    chain: { id: ESCROW.chainId },
    account: { address: "0xresolver" },
    writeContract: async ({ functionName }: { functionName: string }) => {
      writeCalls.push({ functionName });
      if (functionName === "release" && releaseShouldFail) throw new Error("ChallengeWindowNotElapsed");
      return `0xtxhash-${functionName}`;
    },
  } as unknown as WalletClient<Transport, Chain, Account>;

  const publicClient = {
    waitForTransactionReceipt: async () => ({}),
  } as unknown as PublicClient;

  return { walletClient, publicClient, writeCalls };
}

test("resolveDeal: aborts before relaying on a questionHash mismatch", async () => {
  const { walletClient, publicClient, writeCalls } = fakeClients();
  const getAttestation: GetAttestationFn = async () => fakeAttestation({ questionHash: "0xdeadbeef" as `0x${string}` });

  const result = await resolveDeal(
    { escrow: ESCROW, oracleInput: ORACLE_INPUT, expectedQuestionHash: QUESTION_HASH, payoutEstimateBaseUnits: 100n },
    { getAttestation, walletClient, publicClient },
  );

  assert.equal(result.relayed, false);
  if (!result.relayed) assert.equal(result.reason, "question_hash_mismatch");
  assert.equal(writeCalls.length, 0);
});

test("resolveDeal: denies relay when the approval gate rejects an above-threshold payout", async () => {
  const { walletClient, publicClient, writeCalls } = fakeClients();
  const getAttestation: GetAttestationFn = async () => fakeAttestation();

  const result = await resolveDeal(
    { escrow: ESCROW, oracleInput: ORACLE_INPUT, expectedQuestionHash: QUESTION_HASH, payoutEstimateBaseUnits: 1000n },
    { getAttestation, walletClient, publicClient, approvalThresholdBaseUnits: 500n, approvalGate: async () => "denied" },
  );

  assert.equal(result.relayed, false);
  if (!result.relayed) assert.equal(result.reason, "approval_denied");
  assert.equal(writeCalls.length, 0);
});

test("resolveDeal: relays and settles a true attestation once approved", async () => {
  const { walletClient, publicClient, writeCalls } = fakeClients();
  const getAttestation: GetAttestationFn = async () => fakeAttestation();
  let gateCalledWith: unknown;

  const result = await resolveDeal(
    { escrow: ESCROW, oracleInput: ORACLE_INPUT, expectedQuestionHash: QUESTION_HASH, payoutEstimateBaseUnits: 1000n },
    {
      getAttestation,
      walletClient,
      publicClient,
      approvalThresholdBaseUnits: 500n,
      approvalGate: async (req) => {
        gateCalledWith = req;
        return "approved";
      },
    },
  );

  assert.equal(result.relayed, true);
  if (result.relayed) {
    assert.equal(result.settled, true);
    assert.equal(result.txHash, "0xtxhash-submitAttestation");
    assert.equal(result.settleTxHash, "0xtxhash-release");
  }
  assert.deepEqual(writeCalls.map((c) => c.functionName), ["submitAttestation", "release"]);
  assert.ok(gateCalledWith);
});

test("resolveDeal: below-threshold payouts skip the approval gate entirely", async () => {
  const { walletClient, publicClient, writeCalls } = fakeClients();
  const getAttestation: GetAttestationFn = async () => fakeAttestation();
  let gateCalled = false;

  const result = await resolveDeal(
    { escrow: ESCROW, oracleInput: ORACLE_INPUT, expectedQuestionHash: QUESTION_HASH, payoutEstimateBaseUnits: 100n },
    {
      getAttestation,
      walletClient,
      publicClient,
      approvalThresholdBaseUnits: 500n,
      approvalGate: async () => {
        gateCalled = true;
        return "approved";
      },
    },
  );

  assert.equal(result.relayed, true);
  assert.equal(gateCalled, false);
  assert.deepEqual(writeCalls.map((c) => c.functionName), ["submitAttestation", "release"]);
});

test("resolveDeal: a false attestation relays but never attempts release() or consults the approval gate", async () => {
  const { walletClient, publicClient, writeCalls } = fakeClients();
  const getAttestation: GetAttestationFn = async () => fakeAttestation({ answer: false });
  let gateCalled = false;

  const result = await resolveDeal(
    { escrow: ESCROW, oracleInput: ORACLE_INPUT, expectedQuestionHash: QUESTION_HASH, payoutEstimateBaseUnits: 999_999n },
    { getAttestation, walletClient, publicClient, approvalThresholdBaseUnits: 0n, approvalGate: async () => { gateCalled = true; return "approved"; } },
  );

  assert.equal(result.relayed, true);
  if (result.relayed) assert.equal(result.settled, false);
  assert.equal(gateCalled, false);
  assert.deepEqual(writeCalls.map((c) => c.functionName), ["submitAttestation"]);
});

test("resolveDeal: relaying still succeeds even if the settle attempt fails (challenge window not elapsed)", async () => {
  const { walletClient, publicClient } = fakeClients({ releaseShouldFail: true });
  const getAttestation: GetAttestationFn = async () => fakeAttestation();

  const result = await resolveDeal(
    { escrow: ESCROW, oracleInput: ORACLE_INPUT, expectedQuestionHash: QUESTION_HASH, payoutEstimateBaseUnits: 0n },
    { getAttestation, walletClient, publicClient, approvalGate: async () => "approved" },
  );

  assert.equal(result.relayed, true);
  if (result.relayed) {
    assert.equal(result.settled, false);
    assert.equal(result.settleTxHash, undefined);
    assert.ok(result.txHash);
  }
});
