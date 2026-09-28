import type { OracleRequestInput } from "../types.ts";
import { PLACEHOLDER_VERIFYING_CONTRACT } from "../types.ts";

export const MISSING_RULE = "Unavailable evidence is not false. Report inability rather than guessing.";

// The spec's own example runs [start, deadline+1day) — the +1 day buffer avoids an exact-deadline
// boundary edge case where the evidence check and the escrow's own deadline timestamp disagree by a second.
export function calendarWindow(startIso: string, deadlineIso: string): { calendar: string; hours: number } {
  const start = new Date(startIso);
  const end = new Date(new Date(deadlineIso).getTime() + 24 * 60 * 60 * 1000);
  const hours = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (60 * 60 * 1000)));
  return {
    calendar: `Use [${start.toISOString()}, ${end.toISOString()}). Blocks are context only.`,
    hours,
  };
}

export function baseInput(
  partial: Omit<OracleRequestInput, "consumer" | "v" | "answerType" | "chainId">,
  chainId: number,
): OracleRequestInput {
  return {
    v: 1,
    answerType: "bool",
    chainId,
    consumer: { chainId, verifyingContract: PLACEHOLDER_VERIFYING_CONTRACT },
    ...partial,
  };
}

export function withConsumer(input: OracleRequestInput, chainId: number, verifyingContract: string): OracleRequestInput {
  // IMD's schema requires lowercase hex (see PLACEHOLDER_VERIFYING_CONTRACT) — a checksummed address
  // from a wallet library or UI would otherwise fail schema validation with an unhelpful bare 400.
  return { ...input, consumer: { chainId, verifyingContract: verifyingContract.toLowerCase() } };
}
