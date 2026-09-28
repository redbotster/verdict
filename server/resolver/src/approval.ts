// Maps to the spec's "Human-Readable Action Approvals" via 1Claw — not wired up yet (no 1Claw
// credentials or Intents API access confirmed in this pass, same class of gap as imd-client's
// Permit2 signing). The threshold logic itself is real and tested; only the actual "ask a human"
// transport is a stub, so a real ApprovalGate can be plugged in later without touching resolve.ts.

export interface ApprovalRequest {
  dealSummary: string;
  payoutBaseUnits: bigint;
  recipient: `0x${string}`;
}

export type ApprovalDecision = "approved" | "denied";
export type ApprovalGate = (req: ApprovalRequest) => Promise<ApprovalDecision>;

export class ApprovalNotWiredError extends Error {
  constructor(req: ApprovalRequest) {
    super(
      `Payout of ${req.payoutBaseUnits} base units to ${req.recipient} is above the approval threshold ` +
        `and needs human sign-off, but no 1Claw Human-Readable Action Approval integration is wired up. ` +
        `Provide a real ApprovalGate via ResolveOptions.approvalGate — see docs/SPEC.md's 1Claw integration table.`,
    );
    this.name = "ApprovalNotWiredError";
  }
}

export const NOT_IMPLEMENTED_APPROVAL_GATE: ApprovalGate = async (req) => {
  throw new ApprovalNotWiredError(req);
};

export function needsApproval(payoutBaseUnits: bigint, thresholdBaseUnits: bigint): boolean {
  return payoutBaseUnits >= thresholdBaseUnits;
}
