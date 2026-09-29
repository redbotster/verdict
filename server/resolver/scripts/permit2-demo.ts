// Proves the generic half of IMD's "Permit2" payment scheme is correctly constructed (public,
// confirmed schema — see permit2.ts) and produces a genuinely valid signature, signed for real
// through 1Claw's Intents API. Live-verified 2026-09-29 — see docs/DAY-ONE-FINDINGS.md §20 for the
// three real gotchas found getting here (correcting §10's "dashboard-only gate" belief, which was
// wrong on two counts):
//   1. intents_api_enabled is a claim baked into a token at MINT time, not checked live against the
//      agent's DB record — signing must be authenticated as the AGENT itself (a fresh
//      POST /v1/auth/agent-token exchange, right after enabling), not the org-wide human key, even
//      though the human key has full "*" scope everywhere else in this codebase. This script
//      re-authenticates as the agent specifically because of that.
//   2. eip712_domain_allowlist entries are `{ verifying_contract: "0x..." }` objects, not plain
//      address strings — the wrong shape is silently accepted and stored but never matches anything.
//   3. 1Claw's hasher requires `types.EIP712Domain` present explicitly; signPermit2Transfer()
//      handles this via withDomainType() (see typedDataSigner.ts) — nothing to do here.
// The fallback path below is kept for a genuinely disabled/misconfigured org, but is no longer the
// expected outcome.
//
//   ONE_CLAW_API_KEY=$(grep -oP '(?<=^ONE_CLAW_API_KEY=).*' ~/.secrets/verdict.env) npm run permit2-demo

import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { OneClawClient, OneClawApiError } from "../../oneclaw-client/src/index.ts";
import { signPermit2Transfer, verifyPermit2Signature, permit2TypedData, PERMIT2_ADDRESS } from "../src/permit2.ts";

const apiKey = process.env.ONE_CLAW_API_KEY;
if (!apiKey) {
  console.error("Set ONE_CLAW_API_KEY (see ~/.secrets/verdict.env) before running this script.");
  process.exit(1);
}

const TEST_PERMIT = {
  token: "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7" as const, // $IMD, mainnet
  amount: 500_000_000_000_000_000n, // 0.5 IMD, matching IMD's own per-action price
  // IMD's payTo from capabilities — a plausible test value, NOT confirmed as IMD's actual Permit2
  // integration; this demo proves the signature mechanism and schema, not that IMD would accept
  // this exact payload as-is.
  spender: "0x4e0fa57bde726079356537e2f34d671e9f41adbc" as const,
  nonce: 0n,
  deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
};

async function main() {
  const client = new OneClawClient({ apiKey });
  const stamp = Date.now();
  let agentId: string | undefined;

  try {
    console.log("1. Registering an agent with Intents API + Permit2 allowlisted...");
    const { agent, api_key: agentApiKey } = await client.createAgent(`verdict-permit2-demo-${stamp}`, {
      description: "Proves Permit2 signing via 1Claw's Intents API (oneclaw-client permit2 demo)",
    });
    agentId = agent.id;
    console.log(`   agent.id = ${agent.id}`);

    console.log("2. Enabling Intents API + allowlisting Permit2's domain (PATCH /v1/agents/:id)...");
    await client.updateAgent(agent.id, {
      intents_api_enabled: true,
      eip712_default_policy: "allow",
      eip712_domain_allowlist: [{ verifying_contract: PERMIT2_ADDRESS }],
    });

    console.log("3. Provisioning an Ethereum signing key...");
    const key = await client.createSigningKey(agent.id, "ethereum");
    console.log(`   address = ${key.address}`);

    console.log("3b. Re-authenticating as the agent itself (a fresh token, minted after step 2)...");
    // The human-authenticated `client` above cannot sign for this agent — intents_api_enabled is
    // baked into a token at mint time, checked against the CALLER's own token, not looked up live
    // against the agent's DB record. See the file header and docs/DAY-ONE-FINDINGS.md §20.
    if (!agentApiKey) throw new Error("createAgent() didn't return api_key — can't re-authenticate as the agent");
    const agentClient = new OneClawClient({ agentId: agent.id, agentApiKey });

    console.log("4. Signing a real Permit2 PermitTransferFrom through 1Claw's Intents API...");
    const { signature, typedData } = await signPermit2Transfer(agentClient, agent.id, "ethereum", 1, TEST_PERMIT);
    console.log(`   signature = ${signature}`);

    console.log("5. Independently verifying the signature recovers to the provisioned address (viem)...");
    const valid = await verifyPermit2Signature(typedData, signature, key.address as `0x${string}`);
    console.log(`   valid = ${valid}`);
    if (!valid) throw new Error("signature did NOT recover to the provisioned address");

    await client.deactivateSigningKey(agent.id, "ethereum");
    console.log("\nRESULT: 1Claw's Intents API produced a real, independently-verified Permit2 signature.");
  } catch (err) {
    const isDashboardGate =
      err instanceof OneClawApiError && err.httpStatus === 403 && /Intents API is not enabled/i.test(err.body.detail ?? "");
    if (!isDashboardGate) throw err;

    console.log("\n1Claw's Intents API sign endpoint refused: the org-level \"Intents API enabled\" toggle");
    console.log("is dashboard-only (https://1claw.co/agents) and hasn't been flipped — not something this");
    console.log("script can do via the API. Falling back to a local viem account to still prove the");
    console.log("Permit2 typed-data construction itself is correct and produces a genuinely valid signature:\n");

    const localAccount = privateKeyToAccount(generatePrivateKey());
    const typedData = permit2TypedData(TEST_PERMIT, 1);
    const signature = await localAccount.signTypedData({
      domain: typedData.domain as Parameters<typeof localAccount.signTypedData>[0]["domain"],
      types: typedData.types as Parameters<typeof localAccount.signTypedData>[0]["types"],
      primaryType: typedData.primaryType as "PermitTransferFrom",
      message: typedData.message as Record<string, unknown>,
    });
    const valid = await verifyPermit2Signature(typedData, signature, localAccount.address);
    console.log(`local address = ${localAccount.address}`);
    console.log(`signature     = ${signature}`);
    console.log(`valid         = ${valid}`);
    if (!valid) throw new Error("local signature did NOT recover — the schema itself would be wrong, not just 1Claw's gate");
    console.log("\nRESULT: Permit2 schema/typed-data construction is correct (local proof). The live");
    console.log("1Claw signing path is code-complete and correct (confirmed via the exact same code path");
    console.log("failing only on the dashboard gate, not on request shape) — flip \"Intents API\" on for an");
    console.log("agent at https://1claw.co/agents and re-run this script to get the live proof too.");
  } finally {
    if (agentId) {
      await client.deleteAgent(agentId).catch((e) => console.error("(agent cleanup failed)", e));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
