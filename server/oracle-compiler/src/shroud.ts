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
// Live-verified 2026-09-29 against a real 1Claw org with LLM Token Billing already active (Stripe
// AI Gateway) — no provider key anywhere in this project, billed straight to the 1Claw org. See
// docs/DAY-ONE-FINDINGS.md §17 and scripts/real-extraction-smoke.ts. test/shroud.test.ts covers the
// URL/header plumbing with a fake fetch; that script is the real, paid, live proof.
//
// Real gotcha found in the process: routed through LLM Token Billing, Shroud's real backend is
// Google Vertex AI's Anthropic partner models, and this org's Vertex project has a policy
// (constraints/vertexai.allowedPartnerModelFeatures) that hard-400s native structured-output mode
// for every Anthropic model — not model-specific, confirmed across claude-sonnet-4-6 and
// claude-haiku-4-5. That's why extract.ts uses tool-calling instead of Output.object()/
// generateObject() — a different request shape, not subject to that same policy, and verified to
// work through this exact path. Worth flagging to 1Claw if you have a support channel with them.
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
