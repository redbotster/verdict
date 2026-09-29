import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getOracleStatus,
  pollOracleUntilResolved,
  parseSignedAttestation,
  fetchOracleAttestation,
  OracleDisagreedError,
  OracleStillAssessingError,
  UnconfirmedOracleResultShapeError,
  type OracleRequestStatus,
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

function resolvedStatus(): OracleRequestStatus {
  return {
    ...assessingStatus(),
    status: "resolved",
    attestedAt: "2026-09-29T16:00:00.000Z",
    signer: "0x000000000000000000000000000000000000dEaD",
    signature: "0xdeadbeef",
    attestation: {
      requestId: 1,
      chainId: 1,
      questionHash: "0x4cac90cb903813abf60a01e873357236901901e026bff048d041fdb609565cb5",
      answerType: "bool",
      answer: true,
      figure: "",
      fromBlock: 26076682,
      toBlock: 26084152,
      panelJobId: "605aeecc-4f7b-4e60-bb66-e2232a5e433a",
      issuedAt: 1790697940,
      expiresAt: 1790698840,
    },
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
  assert.equal(status.status, "resolved");
  assert.equal(status.signature, "0xdeadbeef");
});

test("pollOracleUntilResolved: throws OracleStillAssessingError once the timeout elapses", async () => {
  const fetchImpl = fakeFetch([assessingStatus()]);
  await assert.rejects(
    () => pollOracleUntilResolved(ADMISSION_RESULT, { fetchImpl, intervalMs: 1, timeoutMs: 5 }),
    OracleStillAssessingError,
  );
});

test("parseSignedAttestation: parses a well-formed resolved status into a SignedAttestation", () => {
  const attestation = parseSignedAttestation(resolvedStatus());
  assert.equal(attestation.signature, "0xdeadbeef");
  assert.equal(attestation.message.answer, true);
  assert.equal(attestation.message.requestId, 1n);
  assert.equal(attestation.message.fromBlock, 26076682n);
  assert.equal(attestation.message.panelJobId, "605aeecc-4f7b-4e60-bb66-e2232a5e433a");
});

test("parseSignedAttestation: throws UnconfirmedOracleResultShapeError when attestation is missing", () => {
  assert.throws(() => parseSignedAttestation(assessingStatus()), UnconfirmedOracleResultShapeError);
});

test("fetchOracleAttestation: end to end, polls then parses", async () => {
  const fetchImpl = fakeFetch([assessingStatus(), resolvedStatus()]);
  const attestation = await fetchOracleAttestation(ADMISSION_RESULT, { fetchImpl, intervalMs: 1 });
  assert.equal(attestation.signature, "0xdeadbeef");
});

test("fetchOracleAttestation: propagates OracleDisagreedError rather than misreporting it as a parse failure", async () => {
  const fetchImpl = fakeFetch([disagreedStatus()]);
  await assert.rejects(() => fetchOracleAttestation(ADMISSION_RESULT, { fetchImpl }), OracleDisagreedError);
});
