"use server";

// Runs server-side because IMD's paid routes refuse cross-origin browser calls (per docs/SPEC.md).
// Deliberately skips oracle-compiler's LLM extraction step: this form takes structured input
// directly, so there's nothing to extract — it calls the template builder and lint checks that sit
// downstream of extraction, plus a real (free) IMD quote, the same way compileDeal() would.
import { randomUUID } from "node:crypto";
import { ImdClient, generateClientToken, ImdApiError } from "@verdict/imd-client";
import { releasePublishedTemplate, lintDealText, lintSourceUrls } from "@verdict/oracle-compiler";
import type { Extraction, OracleRequestInput } from "@verdict/oracle-compiler";

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
