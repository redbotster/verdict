import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleResolutionAutomation, cancelScheduledResolution, type AutomationClient } from "../src/automation.ts";
import type { Automation, AutomationRun, CreateAutomationInput } from "../../oneclaw-client/src/types.ts";

function fakeClient(overrides: Partial<AutomationClient> = {}): AutomationClient & { calls: { createAutomation?: CreateAutomationInput } } {
  const calls: { createAutomation?: CreateAutomationInput } = {};
  return {
    calls,
    createAutomation: async (input) => {
      calls.createAutomation = input;
      return { id: "automation-1", name: input.name, agent_id: input.agent_id, trigger_type: input.trigger_type } satisfies Automation;
    },
    triggerAutomation: async (id, opts) => {
      return { id: "run-1", automation_id: id, status: "running" } satisfies AutomationRun;
    },
    cancelAutomationRun: async () => {},
    ...overrides,
  };
}

test("scheduleResolutionAutomation: builds a manual automation with wait_until then http steps", async () => {
  const client = fakeClient();
  const result = await scheduleResolutionAutomation({
    client,
    agentId: "agent-1",
    dealId: "deal-42",
    deadlineIso: "2026-12-01T00:00:00.000Z",
    resolverWebhookUrl: "https://example.com/api/resolve",
  });

  assert.equal(result.automationId, "automation-1");
  assert.equal(result.runId, "run-1");

  const input = client.calls.createAutomation!;
  assert.equal(input.trigger_type, "manual");
  assert.equal(input.agent_id, "agent-1");
  assert.equal(input.name, "resolve-deal-42");
  assert.equal(input.workflow_spec.steps.length, 2);
  assert.equal(input.workflow_spec.steps[0]?.type, "wait_until");
  assert.equal(input.workflow_spec.steps[0]?.until, "2026-12-01T00:00:00.000Z");
  assert.equal(input.workflow_spec.steps[1]?.type, "http");
  assert.equal(input.workflow_spec.steps[1]?.url, "https://example.com/api/resolve");
  assert.deepEqual(input.workflow_spec.steps[1]?.body, { dealId: "deal-42" });
});

test("scheduleResolutionAutomation: merges extraPayload into the callback body", async () => {
  const client = fakeClient();
  await scheduleResolutionAutomation({
    client,
    agentId: "agent-1",
    dealId: "deal-7",
    deadlineIso: "2026-12-01T00:00:00.000Z",
    resolverWebhookUrl: "https://example.com/api/resolve",
    extraPayload: { escrowAddress: "0xdead" },
  });
  const input = client.calls.createAutomation!;
  assert.deepEqual(input.workflow_spec.steps[1]?.body, { dealId: "deal-7", escrowAddress: "0xdead" });
});

test("scheduleResolutionAutomation: passes headers through to the http step", async () => {
  const client = fakeClient();
  await scheduleResolutionAutomation({
    client,
    agentId: "agent-1",
    dealId: "deal-8",
    deadlineIso: "2026-12-01T00:00:00.000Z",
    resolverWebhookUrl: "https://example.com/api/resolve",
    headers: { "X-Resolver-Secret": "shh" },
  });
  const input = client.calls.createAutomation!;
  assert.deepEqual(input.workflow_spec.steps[1]?.headers, { "X-Resolver-Secret": "shh" });
});

test("scheduleResolutionAutomation: triggers with a deal-scoped idempotency key", async () => {
  let capturedKey: string | undefined;
  const client = fakeClient({
    triggerAutomation: async (id, opts) => {
      capturedKey = opts?.idempotencyKey;
      return { id: "run-1", automation_id: id, status: "running" };
    },
  });
  await scheduleResolutionAutomation({
    client,
    agentId: "agent-1",
    dealId: "deal-99",
    deadlineIso: "2026-12-01T00:00:00.000Z",
    resolverWebhookUrl: "https://example.com/api/resolve",
  });
  assert.equal(capturedKey, "resolve-deal-99");
});

test("cancelScheduledResolution: cancels the exact automation/run pair", async () => {
  let cancelled: [string, string] | undefined;
  const client = fakeClient({
    cancelAutomationRun: async (automationId, runId) => {
      cancelled = [automationId, runId];
    },
  });
  await cancelScheduledResolution(client, { automationId: "automation-5", runId: "run-5" });
  assert.deepEqual(cancelled, ["automation-5", "run-5"]);
});
