import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDeal, TransactionRelayNotConfiguredError } from "../src/resolve.ts";
import type { GetAttestationFn } from "../src/resolve.ts";
import type { TransactionRelay } from "../src/relay.ts";
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

// resolveDeal() reads on-chain state/trueAt before ever calling getAttestation, to avoid re-buying a
// real IMD attestation on a retry — defaults here match a fresh, never-attested Funded escrow (state
// 0, trueAt 0n), i.e. the "first real attempt" path every existing test below expects.
function fakePublicClient(opts: { onChainState?: 0 | 1 | 2; onChainTrueAt?: bigint } = {}): PublicClient {
  const onChainState = opts.onChainState ?? 0;
  const onChainTrueAt = opts.onChainTrueAt ?? 0n;
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "state") return onChainState;
      if (functionName === "trueAt") return onChainTrueAt;
      throw new Error(`fakePublicClient: unexpected readContract functionName ${functionName}`);
    },
    waitForTransactionReceipt: async () => ({}),
  } as unknown as PublicClient;
}

function fakeClients(opts: { releaseShouldFail?: boolean; onChainState?: 0 | 1 | 2; onChainTrueAt?: bigint } = {}): FakeClients {
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

  const publicClient = fakePublicClient(opts);

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

test("resolveDeal: an above-threshold payout still submits the attestation on-chain, but reports settled: false when the approval gate denies it", async () => {
  // The attestation itself is harmless and permanent (no funds move) and starts the challenge
  // window regardless of approval — only release() (the actual fund movement) is gated. See
  // resolve.ts's attemptRelease() for why this is no longer treated as an exceptional outcome.
  const { walletClient, publicClient, writeCalls } = fakeClients();
  const getAttestation: GetAttestationFn = async () => fakeAttestation();

  const result = await resolveDeal(
    { escrow: ESCROW, oracleInput: ORACLE_INPUT, expectedQuestionHash: QUESTION_HASH, payoutEstimateBaseUnits: 1000n },
    { getAttestation, walletClient, publicClient, approvalThresholdBaseUnits: 500n, approvalGate: async () => "denied" },
  );

  assert.equal(result.relayed, true);
  if (result.relayed) {
    assert.equal(result.settled, false);
    assert.equal(result.settleBlockedReason, "approval_required");
    assert.ok(result.txHash);
  }
  assert.deepEqual(writeCalls.map((c) => c.functionName), ["submitAttestation"]);
});

test("resolveDeal: an above-threshold payout with no ApprovalGate wired at all also just reports settled: false, not a thrown error", async () => {
  const { walletClient, publicClient, writeCalls } = fakeClients();
  const getAttestation: GetAttestationFn = async () => fakeAttestation();

  const result = await resolveDeal(
    { escrow: ESCROW, oracleInput: ORACLE_INPUT, expectedQuestionHash: QUESTION_HASH, payoutEstimateBaseUnits: 1000n },
    { getAttestation, walletClient, publicClient, approvalThresholdBaseUnits: 500n }, // no approvalGate at all
  );

  assert.equal(result.relayed, true);
  if (result.relayed) {
    assert.equal(result.settled, false);
    assert.equal(result.settleBlockedReason, "approval_required");
  }
  assert.deepEqual(writeCalls.map((c) => c.functionName), ["submitAttestation"]);
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

test("resolveDeal: options.relay is used instead of walletClient when both submitting writes", async () => {
  const publicClient = fakePublicClient();
  const getAttestation: GetAttestationFn = async () => fakeAttestation();
  const relayCalls: string[] = [];
  const relay: TransactionRelay = {
    submitAttestation: async () => {
      relayCalls.push("submitAttestation");
      return "0xtxhash-relay-submit" as `0x${string}`;
    },
    release: async () => {
      relayCalls.push("release");
      return "0xtxhash-relay-release" as `0x${string}`;
    },
  };

  const result = await resolveDeal(
    { escrow: ESCROW, oracleInput: ORACLE_INPUT, expectedQuestionHash: QUESTION_HASH, payoutEstimateBaseUnits: 0n },
    { getAttestation, relay, publicClient, approvalGate: async () => "approved" },
  );

  assert.equal(result.relayed, true);
  if (result.relayed) {
    assert.equal(result.txHash, "0xtxhash-relay-submit");
    assert.equal(result.settleTxHash, "0xtxhash-relay-release");
  }
  assert.deepEqual(relayCalls, ["submitAttestation", "release"]);
});

test("resolveDeal: throws a clear error if neither walletClient nor relay is configured, once it actually needs to relay", async () => {
  const publicClient = fakePublicClient();
  const getAttestation: GetAttestationFn = async () => fakeAttestation();

  await assert.rejects(
    () =>
      resolveDeal(
        { escrow: ESCROW, oracleInput: ORACLE_INPUT, expectedQuestionHash: QUESTION_HASH, payoutEstimateBaseUnits: 0n },
        { getAttestation, publicClient, approvalGate: async () => "approved" },
      ),
    TransactionRelayNotConfiguredError,
  );
});

test("resolveDeal: a questionHash mismatch aborts before ever needing a relay at all", async () => {
  const publicClient = fakePublicClient();
  const getAttestation: GetAttestationFn = async () => fakeAttestation({ questionHash: "0xdeadbeef" as `0x${string}` });

  // No walletClient, no relay — must not throw, since it should never reach the relay step.
  const result = await resolveDeal(
    { escrow: ESCROW, oracleInput: ORACLE_INPUT, expectedQuestionHash: QUESTION_HASH, payoutEstimateBaseUnits: 0n },
    { getAttestation, publicClient },
  );

  assert.equal(result.relayed, false);
  if (!result.relayed) assert.equal(result.reason, "question_hash_mismatch");
});

test("resolveDeal: a state that's already Released/Refunded on-chain short-circuits before ever calling getAttestation (no re-buying IMD)", async () => {
  const publicClient = fakePublicClient({ onChainState: 1 }); // 1 = Released
  let getAttestationCalled = false;
  const getAttestation: GetAttestationFn = async () => {
    getAttestationCalled = true;
    return fakeAttestation();
  };

  const result = await resolveDeal(
    { escrow: ESCROW, oracleInput: ORACLE_INPUT, expectedQuestionHash: QUESTION_HASH, payoutEstimateBaseUnits: 0n },
    { getAttestation, publicClient },
  );

  assert.equal(result.relayed, false);
  if (!result.relayed) assert.equal(result.reason, "already_resolved");
  assert.equal(getAttestationCalled, false);
});

test("resolveDeal: a true attestation already on-chain (trueAt != 0) skips re-buying and just retries release()", async () => {
  const { walletClient, writeCalls } = fakeClients();
  const publicClient = fakePublicClient({ onChainState: 0, onChainTrueAt: 12345n });
  let getAttestationCalled = false;
  const getAttestation: GetAttestationFn = async () => {
    getAttestationCalled = true;
    return fakeAttestation();
  };

  const result = await resolveDeal(
    // needsApproval() is payout >= threshold, so a 0n payout against the default 0n threshold would
    // itself need approval (an edge case of that comparison, not what this test is about) — use a
    // real non-zero payout with no threshold set, i.e. clearly below the "no cap configured" default.
    { escrow: ESCROW, oracleInput: ORACLE_INPUT, expectedQuestionHash: QUESTION_HASH, payoutEstimateBaseUnits: 100n },
    { getAttestation, walletClient, publicClient, approvalThresholdBaseUnits: 1000n },
  );

  assert.equal(result.relayed, false);
  if (!result.relayed) {
    assert.equal(result.reason, "already_attested_awaiting_release");
    if (result.reason === "already_attested_awaiting_release") assert.equal(result.settled, true);
  }
  assert.equal(getAttestationCalled, false);
  assert.deepEqual(writeCalls.map((c) => c.functionName), ["release"]);
});

test("resolveDeal: a true attestation already on-chain, but release() isn't ready yet, reports settled: false without throwing", async () => {
  const { walletClient, publicClient } = fakeClients({ releaseShouldFail: true, onChainState: 0, onChainTrueAt: 12345n });
  const getAttestation: GetAttestationFn = async () => fakeAttestation();

  const result = await resolveDeal(
    { escrow: ESCROW, oracleInput: ORACLE_INPUT, expectedQuestionHash: QUESTION_HASH, payoutEstimateBaseUnits: 0n },
    { getAttestation, walletClient, publicClient },
  );

  assert.equal(result.relayed, false);
  if (!result.relayed) {
    assert.equal(result.reason, "already_attested_awaiting_release");
    if (result.reason === "already_attested_awaiting_release") assert.equal(result.settled, false);
  }
});
