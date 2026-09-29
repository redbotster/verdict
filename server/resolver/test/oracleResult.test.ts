import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters } from "viem";
import {
  getOracleStatus,
  pollOracleUntilResolved,
  parseSignedAttestation,
  fetchOracleAttestation,
  OracleDisagreedError,
  OracleStillAssessingError,
  UnsupportedAnswerTypeError,
  type OracleRequestStatus,
  type OracleAttestationResponse,
} from "../src/oracleResult.ts";

const ADMISSION_RESULT = {
  kind: "oracle",
  requestId: "b3184afe-f7b7-4038-87f3-8737dc29f16d",
  jobId: "605aeecc-4f7b-4e60-bb66-e2232a5e433a",
  statusUrl: "/oracle/requests/b3184afe-f7b7-4038-87f3-8737dc29f16d",
  attestationUrl: "/oracle/requests/b3184afe-f7b7-4038-87f3-8737dc29f16d/attestation",
};

function assessingStatus(): OracleRequestStatus {
  return {
    id: "b3184afe-f7b7-4038-87f3-8737dc29f16d",
    status: "assessing",
    questionHash: "0x4cac90cb903813abf60a01e873357236901901e026bff048d041fdb609565cb5",
    chainId: 1,
    failure: null,
    agreement: null,
    members: [],
    attestation: null,
    signature: null,
    signer: null,
    attestedAt: null,
  };
}

// The exact real response captured from a real paid request — docs/DAY-ONE-FINDINGS.md §15.
function disagreedStatus(): OracleRequestStatus {
  return {
    ...assessingStatus(),
    status: "disagreed",
    failure: "1 of 4 answers agreed; 4 were required.",
    agreement: { agreed: 1, quorum: 4, answer: false, cluster: ["b7f7871..."], outsideSources: ["97a1005b...", "a18b9c99...", "ed634afb..."] },
    members: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }],
  };
}

// The status endpoint just needs non-null attestation/signature/signer to signal "ready" to
// pollOracleUntilResolved — the real content used to build a SignedAttestation now comes from
// getRealAttestation()'s dedicated endpoint instead (see realAttestation() below).
function resolvedStatus(): OracleRequestStatus {
  return {
    ...assessingStatus(),
    status: "attested",
    attestedAt: "2026-09-29T16:00:00.000Z",
    signer: "0x5598aa9146215bc13eb26f2c692ad1461fd32982",
    signature: "0xdeadbeef",
    attestation: { placeholder: true },
  };
}

// Shape and field values match the real response captured live 2026-09-29 from IMD's dedicated
// GET /oracle/requests/:id/attestation endpoint — see docs/DAY-ONE-FINDINGS.md §25.
function realAttestation(overrides: Partial<OracleAttestationResponse["message"]> = {}): OracleAttestationResponse {
  return {
    requestId: "b3184afe-f7b7-4038-87f3-8737dc29f16d",
    domain: { name: "IdentityMD Oracle", version: "1", chainId: 1, verifyingContract: "0x1234567890123456789012345678901234567890" },
    types: { OracleAttestation: [] },
    primaryType: "OracleAttestation",
    message: {
      requestId: "0x52523387b5be49339932634f90e2dc3000000000000000000000000000000000" as `0x${string}`,
      chainId: 1,
      questionHash: "0xa34745703a3601fbca040a13ea8926f8f8e0752f58ce955f3b43e3651fa18a91",
      answerType: "bool",
      answer: encodeAbiParameters([{ type: "bool" }], [true]),
      figure: "0",
      fromBlock: 26078576,
      toBlock: 26086048,
      blockHash: "0x75592d9457551014314a3fe70ea934406dc680bd9e26d6d30361812e1ab93210",
      panelJobId: "0xd57e7d7838d54b6193e97192ff7909dd00000000000000000000000000000000" as `0x${string}`,
      issuedAt: 1790720297,
      expiresAt: 1791325097,
      ...overrides,
    },
    signature: "0x56ad79550bcfe2e08e453819f60873340e9ae2134c2222a65f7ff2546cc49e5249dcbd1dfb4fd3804cd936c9a1f56164aebbf6707ea07d0f315a0d49cf6fde511b",
    signer: "0x5598aa9146215bc13eb26f2c692ad1461fd32982",
    attestedAt: "2026-09-29T22:18:17.348Z",
  };
}

function fakeFetch(bodies: unknown[]): typeof fetch {
  let call = 0;
  return (async () => {
    const body = bodies[Math.min(call, bodies.length - 1)];
    call++;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

test("getOracleStatus: prefixes a relative statusUrl with IMD's base URL", async () => {
  let capturedUrl: string | undefined;
  const fetchImpl = (async (input: unknown) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify(assessingStatus()), { status: 200 });
  }) as typeof fetch;
  await getOracleStatus(ADMISSION_RESULT, fetchImpl);
  assert.equal(capturedUrl, "https://api.imd.fun/oracle/requests/b3184afe-f7b7-4038-87f3-8737dc29f16d");
});

test("getOracleStatus: throws on a non-ok response", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
  await assert.rejects(() => getOracleStatus(ADMISSION_RESULT, fetchImpl), /GET oracle status failed: 500/);
});

test("pollOracleUntilResolved: throws OracleDisagreedError immediately on a real disagreed response", async () => {
  const fetchImpl = fakeFetch([disagreedStatus()]);
  await assert.rejects(
    () => pollOracleUntilResolved(ADMISSION_RESULT, { fetchImpl }),
    (err: unknown) => {
      assert.ok(err instanceof OracleDisagreedError);
      assert.match(err.message, /1 of 4 answers agreed/);
      return true;
    },
  );
});

test("pollOracleUntilResolved: keeps polling through assessing, then returns once resolved", async () => {
  const fetchImpl = fakeFetch([assessingStatus(), assessingStatus(), resolvedStatus()]);
  const status = await pollOracleUntilResolved(ADMISSION_RESULT, { fetchImpl, intervalMs: 1 });
  assert.equal(status.status, "attested");
  assert.equal(status.signature, "0xdeadbeef");
});

test("pollOracleUntilResolved: throws OracleStillAssessingError once the timeout elapses", async () => {
  const fetchImpl = fakeFetch([assessingStatus()]);
  await assert.rejects(
    () => pollOracleUntilResolved(ADMISSION_RESULT, { fetchImpl, intervalMs: 1, timeoutMs: 5 }),
    OracleStillAssessingError,
  );
});

test("parseSignedAttestation: parses the real dedicated attestation-endpoint shape into a SignedAttestation", () => {
  const attestation = parseSignedAttestation(realAttestation());
  assert.equal(attestation.signature, "0x56ad79550bcfe2e08e453819f60873340e9ae2134c2222a65f7ff2546cc49e5249dcbd1dfb4fd3804cd936c9a1f56164aebbf6707ea07d0f315a0d49cf6fde511b");
  assert.equal(attestation.message.answer, true);
  assert.equal(attestation.message.answerType, 0);
  assert.equal(attestation.message.requestId, "0x52523387b5be49339932634f90e2dc3000000000000000000000000000000000");
  assert.equal(attestation.message.fromBlock, 26078576n);
  assert.equal(attestation.message.figure, 0n);
  assert.equal(attestation.message.blockHash, "0x75592d9457551014314a3fe70ea934406dc680bd9e26d6d30361812e1ab93210");
  assert.equal(attestation.message.panelJobId, "0xd57e7d7838d54b6193e97192ff7909dd00000000000000000000000000000000");
});

test("parseSignedAttestation: a false answer decodes correctly too", () => {
  const attestation = parseSignedAttestation(realAttestation({ answer: encodeAbiParameters([{ type: "bool" }], [false]) }));
  assert.equal(attestation.message.answer, false);
});

test("parseSignedAttestation: throws UnsupportedAnswerTypeError for anything other than bool", () => {
  assert.throws(() => parseSignedAttestation(realAttestation({ answerType: "uint256" })), UnsupportedAnswerTypeError);
});

test("fetchOracleAttestation: end to end, polls the status endpoint then fetches and parses the real attestation", async () => {
  const fetchImpl = fakeFetch([assessingStatus(), resolvedStatus(), realAttestation()]);
  const attestation = await fetchOracleAttestation(ADMISSION_RESULT, { fetchImpl, intervalMs: 1 });
  assert.equal(attestation.message.answer, true);
});

test("fetchOracleAttestation: propagates OracleDisagreedError rather than misreporting it as a parse failure", async () => {
  const fetchImpl = fakeFetch([disagreedStatus()]);
  await assert.rejects(() => fetchOracleAttestation(ADMISSION_RESULT, { fetchImpl }), OracleDisagreedError);
});
