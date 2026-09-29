"use server";

// Runs server-side because IMD's paid routes refuse cross-origin browser calls (per docs/SPEC.md).
// Deliberately skips oracle-compiler's LLM extraction step: this form takes structured input
// directly, so there's nothing to extract — it calls the template builder and lint checks that sit
// downstream of extraction, plus a real (free) IMD quote, the same way compileDeal() would.
import { randomUUID } from "node:crypto";
import { isAddress } from "viem";
import { ImdClient, generateClientToken, ImdApiError } from "@verdict/imd-client";
import { releasePublishedTemplate, lintDealText, lintSourceUrls } from "@verdict/oracle-compiler";
import type { Extraction, OracleRequestInput } from "@verdict/oracle-compiler";
import { readEscrowOnChainState } from "@/lib/escrow";
import { createDeal } from "@/lib/deals";

export interface CompileFormInput {
  githubRepo: string;
  deadlineIso: string;
}

export type CompileActionResult = { ok: true; input: OracleRequestInput; questionHash: string } | { ok: false; error: string };

export async function compileReleaseDeal(form: CompileFormInput): Promise<CompileActionResult> {
  const repo = form.githubRepo
    .trim()
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/\/+$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, error: "Enter a GitHub repo as owner/repo." };

  const deadline = new Date(form.deadlineIso);
  if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= Date.now()) {
    return { ok: false, error: "Deadline must be a valid time in the future." };
  }

  const extraction: Extraction = {
    claim: `${repo} publishes a release`,
    evidenceUrls: [`https://github.com/${repo}`],
    deadlineIso: deadline.toISOString(),
    timezone: "UTC",
    ambiguousTerms: [],
    kind: "release_published",
    githubRepo: repo,
    urlToCheck: null,
    urlContentCheck: null,
    chainId: null,
    recipientAddress: null,
    tokenAddress: null,
    minAmountBaseUnits: null,
  };

  const findings = [...lintDealText(extraction.claim, true), ...lintSourceUrls(extraction.evidenceUrls)];
  if (findings.length > 0) {
    return { ok: false, error: `Rejected by lint: ${findings.map((f) => f.detail).join(", ")}` };
  }

  const input = releasePublishedTemplate.build(extraction, {
    evidenceChainId: 1, // Sepolia has no configured oracle RPC yet — see docs/DAY-ONE-FINDINGS.md
    startIso: new Date().toISOString(),
    validForSeconds: 7 * 24 * 60 * 60,
  });

  try {
    const client = new ImdClient(generateClientToken());
    const { order } = await client.quote("oracle.request", input, randomUUID());
    const parsed = JSON.parse(order.inputJson) as { questionHash: string };
    return { ok: true, input, questionHash: parsed.questionHash };
  } catch (err) {
    if (err instanceof ImdApiError) return { ok: false, error: `IMD rejected this: ${err.body.detail ?? err.body.error}` };
    return { ok: false, error: `Could not reach IMD: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface RegisterDealInput {
  escrowAddress: string;
  chainId: number;
  rpcUrl: string;
  githubRepo: string;
  input: OracleRequestInput;
  questionHash: string;
}

export type RegisterDealResult = { ok: true } | { ok: false; error: string };

// Called once an escrow compiled by compileReleaseDeal() above has actually been deployed (this
// form doesn't deploy anything itself — the payer/payee take the "done" step's payload and deploy
// with it separately, then come back here to register the resulting address). Reads the real
// on-chain state first and refuses to save anything whose questionHash doesn't match what was
// compiled — never trusts a pasted address at face value.
export async function registerDeal(form: RegisterDealInput): Promise<RegisterDealResult> {
  if (!isAddress(form.escrowAddress)) return { ok: false, error: "Not a valid address." };

  let state;
  try {
    state = await readEscrowOnChainState(form.rpcUrl, form.escrowAddress);
  } catch (err) {
    return { ok: false, error: `Could not read on-chain state at ${form.escrowAddress} via ${form.rpcUrl}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (state.questionHash.toLowerCase() !== form.questionHash.toLowerCase()) {
    return { ok: false, error: `On-chain questionHash (${state.questionHash}) doesn't match the compiled one (${form.questionHash}) — wrong address, or wrong deploy?` };
  }

  // Matches MilestoneEscrow.sol's own fee math exactly (Math.mulDiv, floor division) — this is an
  // estimate for the approval-threshold check in resolveDeal(), not a payment calculation, but it
  // should still reflect reality rather than the gross amount.
  const fee = (state.amount * BigInt(state.feeBps)) / 10000n;
  const payoutEstimateBaseUnits = (state.amount - fee).toString();

  try {
    await createDeal({
      address: form.escrowAddress as `0x${string}`,
      title: `${form.githubRepo} release bounty`,
      rpcUrl: form.rpcUrl,
      chainId: form.chainId,
      question: form.input.question,
      sources: form.input.guards.sources ?? [],
      panelSize: form.input.panelSize,
      quorum: form.input.quorum,
      oracleInput: form.input,
      expectedQuestionHash: form.questionHash as `0x${string}`,
      payoutEstimateBaseUnits,
    });
  } catch (err) {
    return { ok: false, error: `Could not save to the database: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { ok: true };
}
