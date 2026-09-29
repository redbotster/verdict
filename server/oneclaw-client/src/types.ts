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
