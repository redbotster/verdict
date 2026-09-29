// Real, live proof that a 1Claw Automation actually reaches a deployed resolver webhook: schedules
// a manual automation (wait_until -> http, via scheduleResolutionAutomation), waits for it to park
// and then fire for real, and prints the run's final status. Confirmed 2026-09-29 against
// https://site-lime-nine-69.vercel.app (a real Vercel deployment, no signer configured there on
// purpose) — the run failed at "EVM_PRIVATE_KEY is not configured", which is the *correct* outcome:
// it proves the automation reached the real URL, passed the X-Resolver-Secret header auth check,
// and reached real application code, stopping cleanly at the one thing deliberately left unconfigured
// rather than attempting a real payment. See docs/DAY-ONE-FINDINGS.md §18.
//
// Not run by CI — creates a real (auto-deleted) automation against a real 1Claw org and a real
// deployed URL. Run it yourself:
//
//   ONE_CLAW_API_KEY=$(grep -oP '(?<=^ONE_CLAW_API_KEY=).*' ~/.secrets/verdict.env) \
//   RESOLVER_WEBHOOK_SECRET=$(grep -oP '(?<=^RESOLVER_WEBHOOK_SECRET=).*' ~/.secrets/verdict.env) \
//   RESOLVER_WEBHOOK_URL=https://<your-deployment>/api/resolve/0x1234567890123456789012345678901234567890 \
//   AGENT_ID=<any existing 1Claw agent id> \
//     npx tsx scripts/real-automation-smoke.ts
import { OneClawClient } from "../../oneclaw-client/src/client.ts";
import { scheduleResolutionAutomation } from "../src/automation.ts";

const client = new OneClawClient({ apiKey: process.env.ONE_CLAW_API_KEY! });
const agentId = process.env.AGENT_ID;
const webhookUrl = process.env.RESOLVER_WEBHOOK_URL;
const webhookSecret = process.env.RESOLVER_WEBHOOK_SECRET;
if (!agentId || !webhookUrl || !webhookSecret) {
  throw new Error("set AGENT_ID, RESOLVER_WEBHOOK_URL, and RESOLVER_WEBHOOK_SECRET");
}

const deadline = new Date(Date.now() + 20_000).toISOString(); // 20s out — fires fast for this smoke test
const dealId = "automation-smoke-" + Date.now();

const scheduled = await scheduleResolutionAutomation({
  client,
  agentId,
  dealId,
  deadlineIso: deadline,
  resolverWebhookUrl: webhookUrl,
  headers: { "X-Resolver-Secret": webhookSecret },
  extraPayload: {
    chainId: 8453,
    rpcUrl: "https://mainnet.base.org",
    oracleInput: { question: "test?" },
    expectedQuestionHash: "0xabc",
    payoutEstimateBaseUnits: "1000000",
  },
});
console.log("scheduled:", JSON.stringify(scheduled));

for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const run = await client.getAutomationRun(scheduled.automationId, scheduled.runId);
  console.log(`poll ${i}: ${run.status}`);
  if (run.status !== "running") {
    console.log("final run:", JSON.stringify(run, null, 2));
    break;
  }
}

await client.deleteAutomation(scheduled.automationId);
console.log("cleaned up automation", scheduled.automationId);
