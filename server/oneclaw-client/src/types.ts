// Shapes confirmed against https://docs.1claw.co (read 2026-09-29) — see this package's README
// for exactly which endpoints and fields are live-verified vs. taken from docs prose only.

export interface AccessToken {
  access_token: string;
  token_type: "Bearer";
  expires_in: number; // seconds; docs example shows 900
}

export interface Vault {
  id: string;
  name: string;
  description?: string;
  created_by: string;
  created_at: string;
}

export type SecretType =
  | "api_key"
  | "password"
  | "certificate"
  | "generic"
  | (string & {});

export interface SecretMetadata {
  id: string;
  path: string;
  type: SecretType;
  version: number;
  metadata?: Record<string, unknown>;
  created_at: string;
  expires_at?: string | null;
}

export interface Secret extends SecretMetadata {
  value: string;
}

export interface Agent {
  id: string;
  name: string;
  description?: string;
  scopes?: string[];
  // Undocumented on the "Register an agent" Human API reference page (confirmed live
  // 2026-09-29) — an agent can only fetch secrets from vaults listed here. Only surfaced via
  // the Agents-overview page's aside about child agents inheriting their parent's vault_ids.
  vault_ids?: string[];
  is_active?: boolean;
  created_at?: string;
}

export interface CreateAgentResult {
  agent: Agent;
  // Shown once, at creation time only — never returned again. Callers must persist it
  // themselves (e.g. into a vault secret) if they need it later.
  api_key?: string;
}

export type PrincipalType = "agent" | "user";
export type PolicyPermission = "read" | "write" | "rotate";

export interface Policy {
  id: string;
  vault_id: string;
  secret_path_pattern: string;
  principal_type: PrincipalType;
  principal_id: string;
  permissions: PolicyPermission[];
  created_at?: string;
}

// --- Automations (docs.1claw.co/docs/automations/overview, read 2026-09-29) ---

export type AutomationTriggerType = "cron" | "webhook" | "event" | "manual";

// Step vocabulary is large and evolving (GET /v1/automations/step-types is the live source of
// truth) — kept loose here rather than a full discriminated union. Two well-known builders below
// (waitUntilStep, httpStep) cover this package's actual use case.
export interface WorkflowStep {
  type: string;
  name?: string;
  on_error?: "fail" | "continue" | "retry" | { action: "retry"; max_attempts: number; backoff_secs: number };
  skip_if?: string;
  run_if?: string;
  [key: string]: unknown;
}

export interface WorkflowSpec {
  steps: WorkflowStep[];
  budget?: { max_tokens?: number; max_cost_cents?: number; max_steps?: number };
}

export interface CreateAutomationInput {
  name: string;
  agent_id: string;
  trigger_type: AutomationTriggerType;
  workflow_spec: WorkflowSpec;
  cron_expr?: string;
  timezone?: string;
  event_filter?: { event_type: string };
}

export interface Automation {
  id: string;
  name: string;
  agent_id: string;
  trigger_type: AutomationTriggerType;
  // Present only on trigger_type "webhook", and only in the create response (one-time).
  webhook_url?: string;
  webhook_token?: string;
  created_at?: string;
}

export type AutomationRunStatus = "running" | "success" | "failed" | "timed_out" | "cancelled" | "awaiting_approval";

export interface AutomationRun {
  id: string;
  automation_id: string;
  status: AutomationRunStatus;
  output?: unknown;
  error?: string;
  created_at?: string;
}

// --- Intents API (docs.1claw.co/docs/agents/intents/signing, read 2026-09-29) ---

export interface SigningKey {
  public_key: string;
  address: string;
  chain: string;
  key_version?: number;
}

export type SignIntentType = "personal_sign" | "typed_data" | "eip712_digest" | "transaction";

export interface EIP712TypedData {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface SignResult {
  signature: `0x${string}`;
  from: `0x${string}`;
  message_hash?: `0x${string}`;
  typed_data_hash?: `0x${string}`;
}

// RFC 7807-style error body, per docs.1claw.co/docs/vaults/human-api/overview.
export interface OneClawErrorBody {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  [k: string]: unknown;
}

export class OneClawApiError extends Error {
  httpStatus: number;
  body: OneClawErrorBody;

  constructor(httpStatus: number, body: OneClawErrorBody) {
    super(`1Claw ${httpStatus}: ${body.title ?? body.detail ?? "request failed"}${body.detail && body.title ? ` — ${body.detail}` : ""}`);
    this.name = "OneClawApiError";
    this.httpStatus = httpStatus;
    this.body = body;
  }
}
