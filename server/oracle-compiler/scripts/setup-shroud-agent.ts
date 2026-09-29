// One-time setup: create a dedicated 1Claw vault + Shroud-enabled agent for extractDealFields()'s
// real LLM calls, routed through Shroud + LLM Token Billing (see shroud.ts and this package's
// README) so no Anthropic API key needs to live in this project at all — billing goes to whatever
// Stripe AI Gateway subscription is active on the 1Claw org behind ONE_CLAW_API_KEY.
//
// Not run by CI or any other script — it creates real, persistent org resources (a vault and an
// agent), unlike server/oneclaw-client/scripts/live-smoke.ts, which cleans up after itself. Run it
// once per org:
//
//   ONE_CLAW_API_KEY=$(grep -oP '(?<=^ONE_CLAW_API_KEY=).*' ~/.secrets/verdict.env) \
//     npx tsx scripts/setup-shroud-agent.ts
//
// Prints the new agent's id and api_key (shown once, never returned again) — save both into
// ~/.secrets/verdict.env by hand as ONE_CLAW_EXTRACTION_AGENT_ID / ONE_CLAW_EXTRACTION_AGENT_API_KEY.
import { OneClawClient } from "../../oneclaw-client/src/client.ts";

const apiKey = process.env.ONE_CLAW_API_KEY;
if (!apiKey) throw new Error("set ONE_CLAW_API_KEY");

const human = new OneClawClient({ apiKey });

const vault = await human.createVault("verdict-extraction", "Dedicated vault for verdict's oracle-compiler LLM extraction agent");
console.log("VAULT_ID=" + vault.id);

const created = await human.createAgent("verdict-extraction", {
  description: "extractDealFields() via Shroud + LLM Token Billing (anthropic/claude-sonnet-4-6) — see server/oracle-compiler",
  vaultIds: [vault.id],
});
console.log("AGENT_ID=" + created.agent.id);
console.log("AGENT_API_KEY=" + created.api_key);

// allowed_models + daily_budget_usd bound this agent to exactly the one model this project uses,
// at a cost this project explicitly expects to spend — not "whatever the caller asks for."
const updated = await human.updateAgent(created.agent.id, {
  shroud_enabled: true,
  shroud_config: {
    allowed_providers: ["anthropic"],
    allowed_models: ["claude-sonnet-4-6"],
    daily_budget_usd: 2,
    pii_policy: "redact",
    enable_secret_redaction: true,
  },
});
console.log("SHROUD_ENABLED=" + updated.shroud_enabled);
console.log("SHROUD_CONFIG=" + JSON.stringify(updated.shroud_config));
