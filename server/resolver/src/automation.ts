import type { Automation, AutomationRun, CreateAutomationInput } from "../../oneclaw-client/src/types.ts";
import { waitUntilStep, httpStep } from "../../oneclaw-client/src/client.ts";

// Implements the spec's 1Claw integration table row: "Fire at the deadline | Automations | One
// cron or webhook trigger per deal, created when the deployment goes live, calling the resolver."
//
// Design, confirmed live 2026-09-29 (see docs/DAY-ONE-FINDINGS.md): a "manual" trigger_type
// automation whose workflow is wait_until(deadline) -> http(resolverWebhookUrl). Creating it does
// nothing by itself; triggerAutomation() starts one run, which immediately parks on the
// wait_until step ("no wall clock is spent parked", per 1Claw's docs) until the deadline, then
// calls the resolver's own HTTP endpoint. All the actual IMD/chain logic stays in resolveDeal()
// (this package) — the automation's only job is "call the resolver at the right time," matching
// the spec's own framing exactly.
//
// Narrow interface, not the concrete OneClawClient class — same DI pattern as vaultSecrets.ts.
export interface AutomationClient {
  createAutomation(input: CreateAutomationInput): Promise<Automation>;
  triggerAutomation(id: string, opts?: { input?: unknown; idempotencyKey?: string }): Promise<AutomationRun>;
  cancelAutomationRun(automationId: string, runId: string): Promise<void>;
}

export interface ScheduleResolutionOptions {
  client: AutomationClient;
  /** The 1Claw agent that owns this automation — typically the resolver's own agent. */
  agentId: string;
  dealId: string;
  /** ISO 8601 — when the automation's wait_until step should wake and call the resolver. */
  deadlineIso: string;
  /** Where the automation's http step calls at the deadline — must run resolveDeal() server-side. */
  resolverWebhookUrl: string;
  /** Extra fields merged into the callback body alongside { dealId }. */
  extraPayload?: Record<string, unknown>;
}

export interface ScheduledResolution {
  automationId: string;
  runId: string;
}

export async function scheduleResolutionAutomation(opts: ScheduleResolutionOptions): Promise<ScheduledResolution> {
  const automation = await opts.client.createAutomation({
    name: `resolve-${opts.dealId}`,
    agent_id: opts.agentId,
    trigger_type: "manual",
    workflow_spec: {
      steps: [
        waitUntilStep(opts.deadlineIso, { name: "wait-for-deadline" }),
        httpStep(opts.resolverWebhookUrl, {
          name: "call-resolver",
          body: { dealId: opts.dealId, ...opts.extraPayload },
        }),
      ],
    },
  });

  // Idempotency key ties to the deal, not a random UUID — a retried schedule call for the same
  // deal reuses the run already parked on wait_until instead of starting a second one.
  const run = await opts.client.triggerAutomation(automation.id, { idempotencyKey: `resolve-${opts.dealId}` });
  return { automationId: automation.id, runId: run.id };
}

// Lets a deal that settles early (e.g. a dispute resolved off-chain, or a manual override) stop
// its scheduled automation from firing later. Confirmed live 2026-09-29: a run parked on
// wait_until reports coarse status "running" (not a distinct "waiting" state, despite that word
// appearing in 1Claw's own prose about parking) and IS cancellable in that state — cancelling
// moves it straight to "cancelled". A run that already fired and finished can't be cancelled, but
// by then it's done its one job anyway.
export async function cancelScheduledResolution(client: AutomationClient, scheduled: ScheduledResolution): Promise<void> {
  await client.cancelAutomationRun(scheduled.automationId, scheduled.runId);
}
