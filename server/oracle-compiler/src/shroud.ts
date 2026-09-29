import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

// Routes extraction through 1Claw's Shroud (docs.1claw.co/docs/agents/shroud/overview, read
// 2026-09-29) instead of directly at a provider. Worth it specifically for extractDealFields:
// its input is plain-English text submitted by a payer or payee — untrusted, adversarial input by
// the spec's own threat model — fed straight into an LLM prompt. Shroud's request pipeline runs
// prompt-injection scoring, secret redaction, and PII detection on that text before it ever reaches
// the model, which a direct Vercel AI Gateway call does not.
//
// Confirmed real and current (not guessed): the /v1/messages Anthropic-compatible path, and the
// exact required headers (X-Shroud-Agent-Key, X-Shroud-Provider), are Shroud's own documented
// contract. @ai-sdk/anthropic's createAnthropic({baseURL, headers}) is verified against its
// installed type definitions (node_modules/@ai-sdk/anthropic), not memory.
//
// NOT live-run: doing so needs either a stored provider key at providers/anthropic/api-key in a
// vault the agent can read, a funded 1Claw "LLM Token Billing" org setting, or the x402/card-funded
// router-key rail — none configured in this pass (same "no real LLM credentials available" gap as
// the default Vercel Gateway path; see oracle-compiler's own README). test/shroud.test.ts proves the
// request actually reaches the right URL with the right headers, using a fake fetch — not a live
// call.
export interface ShroudModelOptions {
  agentId: string;
  agentApiKey: string;
  /** Anthropic model id, e.g. "claude-haiku-4-5" (Shroud's own name, not the Gateway's "anthropic/…" form). */
  model: string;
  /**
   * Only needed if the agent has no vault-resolved provider key at providers/anthropic/api-key.
   * Sent as X-Shroud-Api-Key; omit to let Shroud resolve it from the vault instead.
   */
  providerApiKey?: string;
  /** Override for testing; defaults to the real Shroud endpoint. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export function shroudAnthropicModel(opts: ShroudModelOptions): LanguageModel {
  const provider = createAnthropic({
    baseURL: `${opts.baseUrl ?? "https://shroud.1claw.co"}/v1`,
    // The SDK requires one of apiKey/authToken to be set or it throws before ever sending a
    // request; Shroud ignores this value in favor of X-Shroud-Agent-Key (see its docs: "Shroud
    // strips sensitive headers... before forwarding"), so any non-empty placeholder is fine here.
    apiKey: "unused-shroud-routes-via-agent-key",
    headers: {
      "X-Shroud-Agent-Key": `${opts.agentId}:${opts.agentApiKey}`,
      "X-Shroud-Provider": "anthropic",
      ...(opts.providerApiKey ? { "X-Shroud-Api-Key": opts.providerApiKey } : {}),
    },
    fetch: opts.fetch,
  });
  return provider(opts.model);
}
