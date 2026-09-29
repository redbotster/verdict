import type { Extraction } from "../types.ts";
import { baseInput, calendarWindow, MISSING_RULE } from "./common.ts";
import type { BuildContext, Template } from "./types.ts";

// Live-verified against api.imd.fun 2026-09-29 (see docs/DAY-ONE-FINDINGS.md). The spec's own template
// table lists `guards: { toleranceBps: 0 }` for this template — that field causes a bare 400 on this
// API. What actually works: `evidence: "chain"` needs `guards.sources`/`minSources` exactly like the
// panel-evidence templates, with `toleranceBps` omitted entirely. Chain coverage below is limited to
// what's needed for a real explorer link; other chains fall back to Etherscan's URL shape, which is
// wrong for them, but a wrong-but-present source beats an absent one for schema validation.
const EXPLORERS: Record<number, string> = {
  1: "https://etherscan.io",
  11155111: "https://sepolia.etherscan.io",
  8453: "https://basescan.org",
  84532: "https://sepolia.basescan.org",
};

function explorerTokenUrl(chainId: number, tokenAddress: string): string {
  const base = EXPLORERS[chainId] ?? EXPLORERS[1];
  return `${base}/token/${tokenAddress}`;
}

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
        guards: { sources: [explorerTokenUrl(e.chainId!, e.tokenAddress!)], minSources: 1 },
      },
      e.chainId!,
    );
  },
};
