import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isAddress as viemIsAddress } from "viem";
import { supabaseSelect, supabaseInsert } from "./supabase.ts";
import type { OracleRequestInput } from "@verdict/oracle-compiler";

// Off-chain deal metadata (the question text, sources, quorum) keyed by the deployed escrow address.
// Nothing on-chain records this beyond questionHash itself, so it has to live somewhere off-chain.
// Real deals live in Supabase (see supabase.ts); `oracleInput`/`expectedQuestionHash`/
// `payoutEstimateBaseUnits` are only required for a deal the resolve webhook still needs to act on —
// display-only entries (the local Anvil demo below, already-settled historical demos) can omit them.
export interface DealMetadata {
  title: string;
  rpcUrl: string;
  chainId: number;
  question: string;
  sources: string[];
  panelSize: number;
  quorum: number;
  oracleInput?: OracleRequestInput;
  expectedQuestionHash?: `0x${string}`;
  payoutEstimateBaseUnits?: string;
  approvalThresholdBaseUnits?: string;
}

interface DealRow {
  address: string;
  title: string;
  rpc_url: string;
  chain_id: number;
  question: string;
  sources: string[];
  panel_size: number;
  quorum: number;
  oracle_input: OracleRequestInput;
  expected_question_hash: string;
  payout_estimate_base_units: string;
  approval_threshold_base_units: string | null;
}

function rowToMetadata(row: DealRow): DealMetadata {
  return {
    title: row.title,
    rpcUrl: row.rpc_url,
    chainId: row.chain_id,
    question: row.question,
    sources: row.sources,
    panelSize: row.panel_size,
    quorum: row.quorum,
    oracleInput: row.oracle_input,
    expectedQuestionHash: row.expected_question_hash as `0x${string}`,
    payoutEstimateBaseUnits: row.payout_estimate_base_units,
    approvalThresholdBaseUnits: row.approval_threshold_base_units ?? undefined,
  };
}

// Local-only, gitignored: `scripts/deploy-demo.ts` deploys a real escrow to a throwaway local Anvil
// chain and writes this file so the site can be tested against genuine on-chain state without
// touching Supabase (the address only exists while that local chain is running, so it wouldn't be a
// meaningful row in a persistent table). See site/README.md.
function loadLocalDemoDeals(): Record<string, DealMetadata> {
  const demoPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "demo-deal.local.json");
  if (!existsSync(demoPath)) return {};
  return JSON.parse(readFileSync(demoPath, "utf-8"));
}

export async function listDeals(): Promise<Record<string, DealMetadata>> {
  const rows = await supabaseSelect<DealRow>("deals", "?select=*").catch(() => [] as DealRow[]);
  const fromSupabase = Object.fromEntries(rows.map((row) => [row.address.toLowerCase(), rowToMetadata(row)]));
  return { ...loadLocalDemoDeals(), ...fromSupabase };
}

export async function getDealMetadata(address: string): Promise<DealMetadata | undefined> {
  const local = loadLocalDemoDeals()[address.toLowerCase()];
  if (local) return local;
  const rows = await supabaseSelect<DealRow>("deals", `?address=eq.${address.toLowerCase()}&select=*`);
  return rows[0] ? rowToMetadata(rows[0]) : undefined;
}

export interface CreateDealInput {
  address: `0x${string}`;
  title: string;
  rpcUrl: string;
  chainId: number;
  question: string;
  sources: string[];
  panelSize: number;
  quorum: number;
  oracleInput: OracleRequestInput;
  expectedQuestionHash: `0x${string}`;
  payoutEstimateBaseUnits: string;
  approvalThresholdBaseUnits?: string;
}

// Persists a real deal once its escrow is actually deployed — not called by /new today, which only
// produces a signed deployment payload without deploying anything (see site/README.md). This is the
// write path a future "register this deployed escrow" step would call.
export async function createDeal(input: CreateDealInput): Promise<void> {
  await supabaseInsert("deals", {
    address: input.address.toLowerCase(),
    title: input.title,
    rpc_url: input.rpcUrl,
    chain_id: input.chainId,
    question: input.question,
    sources: input.sources,
    panel_size: input.panelSize,
    quorum: input.quorum,
    oracle_input: input.oracleInput,
    expected_question_hash: input.expectedQuestionHash,
    payout_estimate_base_units: input.payoutEstimateBaseUnits,
    approval_threshold_base_units: input.approvalThresholdBaseUnits ?? null,
  });
}

export { viemIsAddress as isAddress };
