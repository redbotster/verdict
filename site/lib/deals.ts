import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isAddress as viemIsAddress } from "viem";

// Off-chain deal metadata (the question text, sources, quorum) keyed by the deployed escrow address.
// Nothing on-chain records this beyond questionHash itself, so it has to live somewhere off-chain —
// this is a placeholder for the real datastore the spec calls for once real deals exist
// (docs/SPEC.md's Economics section lists this under Partner plan / future infra, not MVP-blocking).
// Sourced from server/oracle-compiler's compileDeal() output in practice.
export interface DealMetadata {
  title: string;
  rpcUrl: string;
  chainId: number;
  question: string;
  sources: string[];
  panelSize: number;
  quorum: number;
}

// No real deals exist yet (see docs/DAY-ONE-FINDINGS.md — real deployment is blocked on IMD's
// unconfirmed payment-signing schema). `scripts/deploy-demo.ts` deploys a real local escrow to
// Anvil and writes demo-deal.local.json (gitignored) so this page can be tested against genuine
// on-chain state — see site/README.md.
const STATIC_DEALS: Record<string, DealMetadata> = {};

function loadDemoDeals(): Record<string, DealMetadata> {
  const demoPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "demo-deal.local.json");
  if (!existsSync(demoPath)) return {};
  return JSON.parse(readFileSync(demoPath, "utf-8"));
}

export const DEALS: Record<string, DealMetadata> = { ...STATIC_DEALS, ...loadDemoDeals() };

export function getDealMetadata(address: string): DealMetadata | undefined {
  return DEALS[address.toLowerCase()];
}

export { viemIsAddress as isAddress };
