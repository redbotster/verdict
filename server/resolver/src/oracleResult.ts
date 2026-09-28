import type { RequestStatus } from "../../imd-client/src/types.ts";
import type { SignedAttestation } from "./types.ts";

// UNCONFIRMED: this has never been observed against a real, paid oracle.request (that costs real
// IMD tokens on mainnet — held back, see docs/DAY-ONE-FINDINGS.md). Best-effort parse from spec
// prose alone: "GET /oracle/requests/:id ... attestation shape with domain, types and signature."
// The exact field name IMD uses to point from `admission` to the result resource, and the exact
// envelope that resource returns, are both guesses. Treat a failure here as informative, not a sign
// the rest of the resolver is broken — see fetchOracleAttestation's error for what to check first.
export class UnconfirmedOracleResultShapeError extends Error {
  constructor(context: string, raw: unknown) {
    super(
      `Could not parse an OracleAttestation from IMD's response (${context}) — this endpoint's shape ` +
        `has never been confirmed against a real paid request. Raw: ${JSON.stringify(raw)}`,
    );
    this.name = "UnconfirmedOracleResultShapeError";
  }
}

export async function fetchOracleAttestation(status: RequestStatus, bearerToken: string): Promise<SignedAttestation> {
  const admission = status.admission as Record<string, unknown> | null;
  const result = admission?.["result"] as Record<string, unknown> | undefined;
  const resultUrl = (result?.["url"] ?? admission?.["resultUrl"] ?? admission?.["url"]) as unknown;
  if (typeof resultUrl !== "string") throw new UnconfirmedOracleResultShapeError("no result URL found in admission", admission);

  const res = await fetch(resultUrl, { headers: { Authorization: `Bearer ${bearerToken}` } });
  const body = (await res.json()) as Record<string, unknown>;
  const message = body["message"] as Record<string, unknown> | undefined;
  const signature = body["signature"];
  if (!message || typeof signature !== "string") throw new UnconfirmedOracleResultShapeError("no message/signature in oracle result", body);

  return {
    message: {
      requestId: BigInt(message["requestId"] as string | number),
      chainId: BigInt(message["chainId"] as string | number),
      questionHash: message["questionHash"] as `0x${string}`,
      answerType: String(message["answerType"]),
      answer: Boolean(message["answer"]),
      figure: String(message["figure"] ?? ""),
      fromBlock: BigInt((message["fromBlock"] as string | number | undefined) ?? 0),
      toBlock: BigInt((message["toBlock"] as string | number | undefined) ?? 0),
      panelJobId: String(message["panelJobId"] ?? ""),
      issuedAt: BigInt(message["issuedAt"] as string | number),
      expiresAt: BigInt(message["expiresAt"] as string | number),
    },
    signature: signature as `0x${string}`,
  };
}
