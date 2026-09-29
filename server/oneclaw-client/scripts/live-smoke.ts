// Exercises the golden path (vault -> secret -> agent -> policy -> agent fetch) against the
// REAL api.1claw.co, using ONE_CLAW_API_KEY from the environment. Not run in CI and not run
// automatically by any other script in this repo: it creates real resources in the caller's
// real 1Claw org (a vault and an agent), which count against the free tier's limits (3 vaults,
// 2 agents) and are visible in the real dashboard at 1claw.co. Run it deliberately:
//
//   ONE_CLAW_API_KEY=$(grep -oP '(?<=^ONE_CLAW_API_KEY=).*' ~/.secrets/verdict.env) npm run live-smoke
//
// Cleans up after itself (deletes whatever it created, even on a failure partway through)
// unless --keep is passed.

import { OneClawClient, OneClawApiError } from "../src/index.ts";

const apiKey = process.env.ONE_CLAW_API_KEY;
if (!apiKey) {
  console.error("Set ONE_CLAW_API_KEY (see ~/.secrets/verdict.env) before running this script.");
  process.exit(1);
}
const keep = process.argv.includes("--keep");

async function main() {
  const client = new OneClawClient({ apiKey });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  let vaultId: string | undefined;
  let agentId: string | undefined;

  try {
    console.log("1. Creating vault...");
    const vault = await client.createVault(`verdict-smoke-${stamp}`, "Throwaway vault from oneclaw-client's live-smoke script");
    vaultId = vault.id;
    console.log(`   vault.id = ${vault.id}`);

    console.log("2. Storing a test secret at imd/orders/smoke-test...");
    const secretMeta = await client.setSecret(vault.id, "imd/orders/smoke-test", "not-a-real-token-just-proving-the-flow", {
      type: "api_key",
      metadata: { source: "oneclaw-client live-smoke" },
    });
    console.log(`   stored ${secretMeta.path} v${secretMeta.version}`);

    console.log("3. Reading it back...");
    const secret = await client.getSecret(vault.id, "imd/orders/smoke-test");
    if (secret.value !== "not-a-real-token-just-proving-the-flow") {
      throw new Error(`round-trip mismatch: got ${JSON.stringify(secret.value)}`);
    }
    console.log("   round-trip OK");

    console.log("4. Listing secrets in the vault...");
    const list = await client.listSecrets(vault.id);
    console.log(`   ${list.length} secret(s): ${list.map((s) => s.path).join(", ")}`);

    console.log("5. Registering an agent (vaultIds set, scopes left empty — see client.ts's createAgent comment)...");
    const { agent, api_key: agentApiKey } = await client.createAgent(`verdict-resolver-smoke-${stamp}`, {
      description: "Throwaway agent from oneclaw-client's live-smoke script",
      vaultIds: [vault.id],
    });
    agentId = agent.id;
    console.log(`   agent.id = ${agent.id}${agentApiKey ? " (api_key issued, not printed)" : ""}`);

    console.log("6. Granting the agent read access to imd/orders/*...");
    const policy = await client.createPolicy(vault.id, {
      secretPathPattern: "imd/orders/*",
      principalType: "agent",
      principalId: agent.id,
      permissions: ["read"],
    });
    console.log(`   policy.id = ${policy.id}`);

    if (agentApiKey) {
      console.log("7. Fetching the secret AS the agent (proves the policy actually works)...");
      const agentClient = new OneClawClient({ agentId: agent.id, agentApiKey });
      const asAgent = await agentClient.getSecret(vault.id, "imd/orders/smoke-test");
      if (asAgent.value !== "not-a-real-token-just-proving-the-flow") {
        throw new Error("agent-scoped fetch returned an unexpected value");
      }
      console.log("   agent-scoped fetch OK — the golden path is real end to end");
    } else {
      console.log("7. No api_key returned from createAgent — skipping the agent-scoped fetch check.");
    }
  } finally {
    if (keep) {
      console.log(`\nLeaving vault ${vaultId} and agent ${agentId} in place (--keep).`);
    } else {
      console.log("\nCleaning up...");
      if (agentId) await client.deleteAgent(agentId).catch((e) => console.error("  (agent cleanup failed)", e));
      if (vaultId) await client.deleteVault(vaultId).catch((e) => console.error("  (vault cleanup failed)", e));
      console.log("Deleted whatever this run created.");
    }
  }
}

main().catch((err) => {
  if (err instanceof OneClawApiError) {
    console.error(`OneClawApiError ${err.httpStatus}:`, err.body);
  } else {
    console.error(err);
  }
  process.exit(1);
});
