import { randomUUID } from "node:crypto";
import { ImdClient, generateClientToken } from "../../imd-client/src/client.ts";
import { ImdApiError } from "../../imd-client/src/types.ts";
import type { Order } from "../../imd-client/src/types.ts";
import { extractDealFields, type ExtractFn } from "./extract.ts";
import { lintDealText, lintSourceUrls } from "./lint.ts";
import { TEMPLATES } from "./templates/index.ts";
import { withConsumer } from "./templates/common.ts";
import type { ApprovalSummary, CompileResult, Extraction, OracleRequestInput } from "./types.ts";

export type QuoteFn = (input: OracleRequestInput, requestKey: string) => Promise<{ order: Order }>;

function defaultQuoteFn(imdToken?: string): QuoteFn {
  const client = new ImdClient(imdToken ?? generateClientToken());
  return (input, requestKey) => client.quote("oracle.request", input, requestKey);
}

export interface CompileOptions {
  extract?: ExtractFn;
  /** Injectable for tests; production defaults to a real ImdClient. Reuse imdToken across a deal's lifecycle. */
  quote?: QuoteFn;
  /** Reused across the whole compile+pin+resolve lifecycle for one deal; generate once and store in the 1Claw vault. */
  imdToken?: string;
  // DAY-ONE-FINDINGS.md: this IMD instance has no ORACLE_RPC_URLS entry for chain 11155111 (Sepolia)
  // yet, so the evidence window defaults to mainnet until that's fixed upstream. This is independent of
  // the escrow's own deploy chain (always Sepolia for the MVP), which is set separately via `consumer`.
  evidenceChainId?: number;
  /** Per spec: longer than challengeWindow + relay time; 7 days is the suggested safe default. */
  validForSeconds?: number;
  /** A 422 dry-run is free, so a bounded retry costs nothing but time. */
  maxAttempts?: number;
  model?: string;
}

const DEFAULT_VALID_FOR_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_EVIDENCE_CHAIN_ID = 1;

// extract -> match a vetted template -> lint -> free dry-run quote. `consumer` doesn't affect
// questionHash (confirmed empirically, see types.ts), so this quote's questionHash — even with a
// placeholder consumer — is already the real, binding one to put in the escrow constructor and show
// both parties for dual approval. Call pinQuestion() later, once the escrow is actually deployed, to
// register its real address with IMD before the resolver's real paid oracle.request call.
export async function compileDeal(dealText: string, options: CompileOptions = {}): Promise<CompileResult> {
  const extract = options.extract ?? extractDealFields;
  const quote = options.quote ?? defaultQuoteFn(options.imdToken);
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const evidenceChainId = options.evidenceChainId ?? DEFAULT_EVIDENCE_CHAIN_ID;
  const validForSeconds = options.validForSeconds ?? DEFAULT_VALID_FOR_SECONDS;
  const startIso = new Date().toISOString();

  let priorError: string | undefined;
  let extraction: Extraction | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      extraction = await extract(dealText, { model: options.model, priorError });
    } catch (err) {
      return { ok: false, reason: { code: "extraction_failed", detail: String(err) }, attempts: attempt };
    }

    if (extraction.kind === "unsupported") {
      return {
        ok: false,
        reason: {
          code: "no_template_match",
          detail: "The deal doesn't match a supported template (GitHub release, page/file content, or an on-chain transfer).",
        },
        extraction,
        attempts: attempt,
      };
    }

    const template = TEMPLATES.find((t) => t.kind === extraction!.kind);
    if (!template) {
      return { ok: false, reason: { code: "no_template_match", detail: `Unknown template kind: ${extraction.kind}` }, extraction, attempts: attempt };
    }

    const missing = template.missingFields(extraction);
    if (missing.length > 0) {
      return {
        ok: false,
        reason: { code: "no_template_match", detail: `Missing required fields for ${template.kind}: ${missing.join(", ")}` },
        extraction,
        attempts: attempt,
      };
    }

    const hasConcreteDeadline = !!extraction.deadlineIso;
    const findings = [
      ...lintDealText(dealText, hasConcreteDeadline),
      ...lintSourceUrls(extraction.evidenceUrls),
      ...extraction.ambiguousTerms.map((t) => ({ code: "subjective_word" as const, detail: t })),
    ];
    if (findings.length > 0) {
      return {
        ok: false,
        reason: { code: "lint_failed", detail: findings.map((f) => `${f.code}: ${f.detail}`).join("; ") },
        extraction,
        attempts: attempt,
      };
    }

    const input = template.build(extraction, { evidenceChainId, startIso, validForSeconds });

    try {
      const { order } = await quote(input, randomUUID());
      const parsed = JSON.parse(order.inputJson) as { questionHash: string };
      return { ok: true, kind: template.kind, extraction, input, questionHash: parsed.questionHash, attempts: attempt };
    } catch (err) {
      if (err instanceof ImdApiError && err.httpStatus === 422) {
        priorError = `${err.body.error}${err.body.detail ? ` — ${err.body.detail}` : ""}`;
        if (attempt === maxAttempts) {
          return { ok: false, reason: { code: "quote_rejected", detail: priorError, problems: err.body.problems }, extraction, attempts: attempt };
        }
        continue;
      }
      throw err; // anything besides a validation 422 isn't this function's to swallow
    }
  }

  return { ok: false, reason: { code: "quote_rejected", detail: "exhausted attempts" }, extraction, attempts: maxAttempts };
}

// Registers the real deployed escrow address with IMD before the resolver's real paid oracle.request
// call. Does NOT change questionHash (see types.ts) — this is bookkeeping on IMD's side, not a
// correctness requirement for the escrow, which already has its binding questionHash from compileDeal().
export async function pinQuestion(
  input: OracleRequestInput,
  consumer: { chainId: number; verifyingContract: string },
  options: { imdToken?: string; quote?: QuoteFn } = {},
): Promise<Order> {
  const quote = options.quote ?? defaultQuoteFn(options.imdToken);
  const finalInput = withConsumer(input, consumer.chainId, consumer.verifyingContract);
  const { order } = await quote(finalInput, randomUUID());
  return order;
}

export function approvalSummaryFromOrder(input: OracleRequestInput, order: Order): ApprovalSummary {
  const parsed = JSON.parse(order.inputJson) as { questionHash: string; pinned?: ApprovalSummary["pinned"] };
  return {
    questionPlainLanguage: input.question,
    sources: input.guards.sources ?? [],
    panelSize: input.panelSize,
    quorum: input.quorum,
    questionHash: parsed.questionHash,
    pinned: parsed.pinned ?? {},
    expiresAt: order.quote.expiresAt,
  };
}
