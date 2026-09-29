import { decodeAbiParameters } from "viem";
import { BASE_URL } from "../../imd-client/src/client.ts";
import type { SignedAttestation } from "./types.ts";

// Real shape, confirmed 2026-09-29 against real paid oracle.requests (docs/DAY-ONE-FINDINGS.md
// §14-15, §25) — GET /oracle/requests/:id, no auth required. Three states confirmed: "assessing"
// (still being worked), "disagreed" (a real, observed terminal failure — every panelist can give the
// same answer and it still disagrees, if their cited sources don't cluster; see §15), and "attested"
// (a real quorum reached — see §19, §25). This endpoint's own `attestation`/`signature`/`signer`
// fields are enough to know an attestation exists, but NOT enough to actually verify or submit
// it on-chain — see getRealAttestation() below for why, and docs/DAY-ONE-FINDINGS.md §25 for the
// full story of finding this out the hard way.
export interface OracleRequestStatus {
  id: string;
  status: string;
  questionHash: `0x${string}`;
  chainId: number;
  failure: string | null;
  agreement: { agreed: number; quorum: number; answer: boolean | null; cluster: string[]; outsideSources: string[] } | null;
  members: unknown[];
  attestation: Record<string, unknown> | null;
  signature: string | null;
  signer: string | null;
  attestedAt: string | null;
  [key: string]: unknown;
}

// The REAL EIP-712 signing package — confirmed live 2026-09-29 via IMD's own dedicated endpoint,
// GET /oracle/requests/:id/attestation (404 "not_attested" until signed). This is the only source of
// the actual domain/types/primaryType IMD signed with; OracleRequestStatus's own `attestation` field
// looks similar but is missing the domain/types/primaryType entirely, and its `message.answerType`
// is a human-readable string ("bool") rather than the numeric enum the real signature actually
// commits to. See docs/DAY-ONE-FINDINGS.md §25 for the real values and how they were verified
// (independently recovering a real signature and matching IMD's own reported signer).
export interface OracleAttestationResponse {
  requestId: string;
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: {
    requestId: `0x${string}`;
    chainId: number;
    questionHash: `0x${string}`;
    answerType: string; // human-readable ("bool", per the enum's zero value — confirmed live), NOT the numeric value actually signed
    answer: `0x${string}`; // ABI-encoded dynamic bytes, e.g. a bool encodes to 32 bytes, 0 or 1
    figure: string; // decimal string
    fromBlock: number;
    toBlock: number;
    blockHash: `0x${string}`;
    panelJobId: `0x${string}`;
    issuedAt: number;
    expiresAt: number;
  };
  signature: `0x${string}`;
  signer: `0x${string}`;
  attestedAt: string;
}

export class UnsupportedAnswerTypeError extends Error {
  constructor(answerType: string) {
    super(
      `IMD's real attestation reports answerType "${answerType}" — this project's contract (and this ` +
        `parsing code) only ever supports "bool". See docs/DAY-ONE-FINDINGS.md §25.`,
    );
    this.name = "UnsupportedAnswerTypeError";
  }
}

// A real, observed outcome, not a parsing failure — see docs/DAY-ONE-FINDINGS.md §15. No
// attestation is ever signed on disagreement, true or false; the deal is stuck until
// `deadline + grace`, at which point the payer can reclaim() regardless of what actually happened.
export class OracleDisagreedError extends Error {
  status: OracleRequestStatus;
  constructor(status: OracleRequestStatus) {
    super(
      `Oracle request ${status.id} disagreed: ${status.failure ?? "no quorum reached"} — no ` +
        `attestation will ever be signed for this request. See docs/DAY-ONE-FINDINGS.md §15.`,
    );
    this.name = "OracleDisagreedError";
    this.status = status;
  }
}

export class OracleStillAssessingError extends Error {
  status: OracleRequestStatus;
  constructor(status: OracleRequestStatus) {
    super(`Oracle request ${status.id} is still "${status.status}" — no result yet.`);
    this.name = "OracleStillAssessingError";
    this.status = status;
  }
}

function resolveUrl(path: unknown, label: string): string {
  if (typeof path !== "string") throw new Error(`admission.result has no ${label} for the oracle request`);
  return path.startsWith("http") ? path : `${BASE_URL}${path}`;
}

function oracleStatusUrl(admissionResult: Record<string, unknown>): string {
  return resolveUrl(admissionResult["statusUrl"] ?? admissionResult["url"], "statusUrl/url");
}

// oracle.request's admission result includes this directly (confirmed live, docs.imd.fun) — no need
// to derive it from the request id by hand.
function oracleAttestationUrl(admissionResult: Record<string, unknown>): string {
  return resolveUrl(admissionResult["attestationUrl"], "attestationUrl");
}

// One check, no polling — throws OracleDisagreedError or OracleStillAssessingError for those exact
// states so a caller can tell "never coming" apart from "not yet." `fetchImpl` is injectable for
// tests; defaults to the real global fetch.
export async function getOracleStatus(admissionResult: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<OracleRequestStatus> {
  const res = await fetchImpl(oracleStatusUrl(admissionResult));
  if (!res.ok) throw new Error(`GET oracle status failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as OracleRequestStatus;
}

// The actual signing package to verify/submit on-chain — see OracleAttestationResponse's own comment
// for why this, not OracleRequestStatus's `attestation` field, is the real source of truth. 404s with
// "not_attested" until the status endpoint reports attestation/signature/signer are all non-null.
export async function getRealAttestation(admissionResult: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<OracleAttestationResponse> {
  const res = await fetchImpl(oracleAttestationUrl(admissionResult));
  if (!res.ok) throw new Error(`GET oracle attestation failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as OracleAttestationResponse;
}

// Polls until the oracle panel reaches a terminal state. Panel assessment takes real wall-clock
// time — a real run took ~2 minutes even for a trivial question — so this is a genuinely separate
// wait from ImdClient.pollUntilAdmitted (which only waits for *payment* admission, not the oracle's
// own resolution). Terminal states confirmed so far: "disagreed" (see OracleDisagreedError above);
// anything else is treated as still-in-progress until attestation/signature/signer are all
// non-null, or the timeout elapses.
export async function pollOracleUntilResolved(
  admissionResult: Record<string, unknown>,
  opts: { intervalMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<OracleRequestStatus> {
  const intervalMs = opts.intervalMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await getOracleStatus(admissionResult, opts.fetchImpl);
    if (status.status === "disagreed") throw new OracleDisagreedError(status);
    if (status.attestation != null && status.signature != null && status.signer != null) return status;
    if (Date.now() > deadline) throw new OracleStillAssessingError(status);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Parses IMD's real, dedicated attestation-endpoint response (not the general status endpoint's own
// `attestation` field — see OracleAttestationResponse's comment) into this project's convenience
// shape. `answerType`/`answer` are IMD's real wire values (a human-readable string and ABI-encoded
// dynamic bytes, respectively, both confirmed live — docs/DAY-ONE-FINDINGS.md §25); this contract
// only ever supports "bool", so anything else throws rather than silently misinterpreting an answer
// this project was never built to handle.
export function parseSignedAttestation(real: OracleAttestationResponse): SignedAttestation {
  if (real.message.answerType !== "bool") throw new UnsupportedAnswerTypeError(real.message.answerType);
  const [answer] = decodeAbiParameters([{ type: "bool" }], real.message.answer);
  return {
    message: {
      requestId: real.message.requestId,
      chainId: BigInt(real.message.chainId),
      questionHash: real.message.questionHash,
      answerType: 0, // ANSWER_TYPE_BOOL — the only value MilestoneEscrow.sol accepts, confirmed live
      answer,
      figure: BigInt(real.message.figure),
      fromBlock: BigInt(real.message.fromBlock),
      toBlock: BigInt(real.message.toBlock),
      blockHash: real.message.blockHash,
      panelJobId: real.message.panelJobId,
      issuedAt: BigInt(real.message.issuedAt),
      expiresAt: BigInt(real.message.expiresAt),
    },
    signature: real.signature,
  };
}

// Convenience: poll the status endpoint to a terminal state, then fetch the real signing package
// from the dedicated attestation endpoint and parse it. What resolve.ts actually calls.
export async function fetchOracleAttestation(
  admissionResult: Record<string, unknown>,
  opts?: { intervalMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<SignedAttestation> {
  await pollOracleUntilResolved(admissionResult, opts);
  const real = await getRealAttestation(admissionResult, opts?.fetchImpl);
  return parseSignedAttestation(real);
}
