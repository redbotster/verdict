import { BASE_URL } from "../../imd-client/src/client.ts";
import type { SignedAttestation } from "./types.ts";

// Real shape, confirmed 2026-09-29 against a real paid oracle.request (docs/DAY-ONE-FINDINGS.md
// §14-15) — GET /oracle/requests/:id, no auth required. Two states are now confirmed:
// "assessing" (still being worked) and "disagreed" (a real, observed terminal failure — every
// panelist can give the same answer and it still disagrees, if their cited sources don't cluster;
// see §15). The *successful* shape — what attestation/signature/signer actually look like once
// populated — has never been observed, since the one real request run so far disagreed instead of
// reaching quorum. Best-effort parsed below, clearly marked as such.
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

export class UnconfirmedOracleResultShapeError extends Error {
  constructor(context: string, raw: unknown) {
    super(
      `Could not parse a SignedAttestation from IMD's oracle status (${context}) — the successful ` +
        `response shape has never been observed against a real request. Raw: ${JSON.stringify(raw)}`,
    );
    this.name = "UnconfirmedOracleResultShapeError";
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

function oracleStatusUrl(admissionResult: Record<string, unknown>): string {
  const path = (admissionResult["statusUrl"] ?? admissionResult["url"]) as unknown;
  if (typeof path !== "string") throw new Error("admission.result has no statusUrl/url for the oracle request");
  return path.startsWith("http") ? path : `${BASE_URL}${path}`;
}

// One check, no polling — throws OracleDisagreedError or OracleStillAssessingError for those exact
// states so a caller can tell "never coming" apart from "not yet." `fetchImpl` is injectable for
// tests; defaults to the real global fetch.
export async function getOracleStatus(admissionResult: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<OracleRequestStatus> {
  const res = await fetchImpl(oracleStatusUrl(admissionResult));
  if (!res.ok) throw new Error(`GET oracle status failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as OracleRequestStatus;
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

// Best-effort parse of the still-unconfirmed successful shape: assumes `attestation` holds the same
// fields as the contract's Attestation struct (matching ATTESTATION_TYPES in eip712.ts), since
// that's what a signature over it would need to mean to be useful — not confirmed against a real
// resolved request. A parse failure here is informative, not proof the rest of the resolver is
// broken; see UnconfirmedOracleResultShapeError.
export function parseSignedAttestation(status: OracleRequestStatus): SignedAttestation {
  const m = status.attestation;
  const signature = status.signature;
  if (!m || typeof signature !== "string") {
    throw new UnconfirmedOracleResultShapeError("attestation/signature missing on a status without disagreement", status);
  }
  return {
    message: {
      requestId: BigInt((m["requestId"] as string | number | undefined) ?? 0),
      chainId: BigInt((m["chainId"] as string | number | undefined) ?? status.chainId),
      questionHash: (m["questionHash"] as `0x${string}` | undefined) ?? status.questionHash,
      answerType: String(m["answerType"] ?? "bool"),
      answer: Boolean(m["answer"]),
      figure: String(m["figure"] ?? ""),
      fromBlock: BigInt((m["fromBlock"] as string | number | undefined) ?? 0),
      toBlock: BigInt((m["toBlock"] as string | number | undefined) ?? 0),
      panelJobId: String(m["panelJobId"] ?? status["jobId"] ?? ""),
      issuedAt: BigInt((m["issuedAt"] as string | number | undefined) ?? 0),
      expiresAt: BigInt((m["expiresAt"] as string | number | undefined) ?? 0),
    },
    signature: signature as `0x${string}`,
  };
}

// Convenience: poll to a terminal state, then parse. What resolve.ts should actually call.
export async function fetchOracleAttestation(
  admissionResult: Record<string, unknown>,
  opts?: { intervalMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<SignedAttestation> {
  const status = await pollOracleUntilResolved(admissionResult, opts);
  return parseSignedAttestation(status);
}
