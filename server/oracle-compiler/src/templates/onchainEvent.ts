import type { Extraction } from "../types.ts";
import { baseInput, calendarWindow, MISSING_RULE } from "./common.ts";
import type { BuildContext, Template } from "./types.ts";

// UNCONFIRMED against the live API: only the release_published shape has actually been dry-run against
// api.imd.fun (see docs/DAY-ONE-FINDINGS.md). The "chain" evidence type's exact guard fields
// (does it want `sources` at all? a block explorer URL? none of these dry-run tested) are the spec's
// own best guess, not verified. Treat a 422 here as informative, not a sign this file is broken.
export const onchainEventTemplate: Template = {
  kind: "onchain_event",

  missingFields(e: Extraction): string[] {
    const missing: string[] = [];
    if (e.chainId == null) missing.push("chainId");
    if (!e.recipientAddress) missing.push("recipientAddress");
    if (!e.tokenAddress) missing.push("tokenAddress");
    if (!e.minAmountBaseUnits) missing.push("minAmountBaseUnits");
    if (!e.deadlineIso) missing.push("deadlineIso");
    return missing;
  },

  build(e, ctx: BuildContext) {
    const { calendar, hours } = calendarWindow(ctx.startIso, e.deadlineIso!);
    return baseInput(
      {
        question: `Did ${e.recipientAddress} receive at least ${e.minAmountBaseUnits} base units of token ${e.tokenAddress} on chain ${e.chainId} between ${ctx.startIso} and ${e.deadlineIso}?`,
        window: { hours },
        evidence: "chain",
        panelSize: 5,
        quorum: 5,
        validForSeconds: ctx.validForSeconds,
        definitions: {
          project: `Read ERC20 Transfer events for token ${e.tokenAddress} to ${e.recipientAddress} on chain ${e.chainId}. Sum amounts; compare to ${e.minAmountBaseUnits} base units.`,
          calendar,
          missing: MISSING_RULE,
        },
        guards: { toleranceBps: 0 },
      },
      e.chainId!,
    );
  },
};
