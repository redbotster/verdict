import { generateText, tool } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import type { Extraction } from "./types.ts";

// Default is a small, cheap model: this is bounded classification + field extraction against a fixed
// schema, not open-ended reasoning, and every output is re-validated by lint.ts and a template matcher
// before anything is trusted — a wrong extraction fails closed (refused) rather than being acted on.
const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";

const ExtractionSchema = z.object({
  claim: z.string().describe("The single factual, checkable claim to verify, stated objectively — no adjectives like 'good' or 'on time'"),
  evidenceUrls: z.array(z.string()).describe("Public HTTPS URLs where evidence can be checked (e.g. a GitHub repo, a live page)"),
  deadlineIso: z.string().nullable().describe("The deadline as an ISO 8601 UTC timestamp, if stated or clearly inferable; otherwise null"),
  timezone: z.string().nullable().describe("IANA timezone the deal text implies (e.g. 'America/New_York'), if any; otherwise null"),
  ambiguousTerms: z.array(z.string()).describe("Subjective or vague words/phrases found in the deal text, verbatim (e.g. 'good quality', 'promptly')"),
  kind: z
    .enum(["release_published", "page_or_file_live", "onchain_event", "unsupported"])
    .describe(
      "release_published: a GitHub release must be published by the deadline. page_or_file_live: a URL must serve specific content. onchain_event: an address must receive at least N of a token. unsupported: none of these fit.",
    ),
  githubRepo: z.string().nullable().describe("owner/repo, only if kind is release_published"),
  urlToCheck: z.string().nullable().describe("The URL to check, only if kind is page_or_file_live"),
  urlContentCheck: z.string().nullable().describe("What the URL's content must show, stated objectively, only if kind is page_or_file_live"),
  chainId: z.number().nullable().describe("EVM chain id, only if kind is onchain_event"),
  recipientAddress: z.string().nullable().describe("0x recipient address, only if kind is onchain_event"),
  tokenAddress: z.string().nullable().describe("0x ERC20 token contract address, only if kind is onchain_event"),
  minAmountBaseUnits: z.string().nullable().describe("Minimum amount in the token's base units, as a numeric string, only if kind is onchain_event"),
});

export interface ExtractOptions {
  /**
   * A Vercel AI Gateway model id string (the default path), or a real LanguageModel instance —
   * e.g. shroudAnthropicModel({...}) from ./shroud.ts, to route this call through 1Claw's Shroud
   * for prompt-injection/secret-redaction inspection before it reaches the model. See shroud.ts.
   */
  model?: string | LanguageModel;
  /** For retries after a rejected dry-run: prior IMD error text appended to steer re-extraction. */
  priorError?: string;
}

export type ExtractFn = (dealText: string, opts?: ExtractOptions) => Promise<Extraction>;

// Uses tool-calling (generateText + a single forced tool), not Output.object()/generateObject()'s
// native structured-output mode. Confirmed necessary, not just a preference: routed through 1Claw's
// Shroud with LLM Token Billing (Stripe AI Gateway -> Google Vertex AI Partner Models), native
// structured outputs get a hard 400 from Vertex's own org policy
// (constraints/vertexai.allowedPartnerModelFeatures disallows `structured_outputs` for every
// Anthropic partner model on 1Claw's Stripe project) — confirmed across claude-sonnet-4-6 and
// claude-haiku-4-5 alike, so it's a blanket restriction, not a model-specific one. Tool-calling is a
// different request shape (`tools` + `tool_choice`, not `output_config.format`) and is not subject
// to that same policy; verified live against the same agent and models. See
// docs/DAY-ONE-FINDINGS.md for the write-up. This also works unchanged against the default direct
// Gateway path, so there's no need for two code paths.
export const extractDealFields: ExtractFn = async (dealText, opts = {}) => {
  const prompt = [
    `The current date and time is ${new Date().toISOString()} (UTC). Resolve any relative deadline`,
    "(e.g. 'within 7 days', 'by next Friday') against this, not your training cutoff — confirmed by",
    "a real run that silently produced a deadline over a year in the past for 'within the next 7",
    "days' before this line was added; see docs/DAY-ONE-FINDINGS.md.",
    "",
    "Extract structured fields from this escrow deal description. Be literal — do not soften or",
    "interpret subjective language, report it verbatim in ambiguousTerms instead. If a required field",
    "for the matched kind is missing, use kind 'unsupported' rather than guessing.",
    "",
    `Deal text:\n"""\n${dealText}\n"""`,
    opts.priorError ? `\nThe previous attempt was rejected by the oracle with this error — fix the extraction accordingly:\n${opts.priorError}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const { toolCalls } = await generateText({
    model: opts.model ?? DEFAULT_MODEL,
    prompt,
    tools: {
      record_extraction: tool({
        description: "Record the structured fields extracted from the deal text.",
        inputSchema: ExtractionSchema,
      }),
    },
    toolChoice: { type: "tool", toolName: "record_extraction" },
  });

  const call = toolCalls.find((c) => c.toolName === "record_extraction");
  if (!call) throw new Error("model did not call record_extraction");
  return ExtractionSchema.parse(call.input);
};
