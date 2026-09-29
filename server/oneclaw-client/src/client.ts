import type {
  AccessToken,
  Agent,
  Automation,
  AutomationRun,
  CreateAgentResult,
  CreateAutomationInput,
  EIP712TypedData,
  Policy,
  PolicyPermission,
  PrincipalType,
  Secret,
  SecretMetadata,
  SecretType,
  SignResult,
  SigningKey,
  SignedTransaction,
  SubmittedTransaction,
  TransactionInput,
  Vault,
  WorkflowStep,
  OneClawErrorBody,
} from "./types.ts";
import { OneClawApiError } from "./types.ts";

const BASE_URL = "https://api.1claw.co";

async function parseJsonOrThrow<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const body = await res.json();
  if (!res.ok) throw new OneClawApiError(res.status, body as OneClawErrorBody);
  return body as T;
}

// A secret path is slash-separated (e.g. "imd/orders/deal-1") and lives as a single
// multi-segment route parameter — encode each segment individually so embedded slashes
// stay path separators instead of being escaped into %2F.
function encodeSecretPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export interface OneClawClientOptions {
  // Human personal API key (1ck_...) — full org-level access: vaults, agents, policies.
  apiKey?: string;
  // Agent credentials (ocv_...) — scoped to whatever policies grant this agent.
  agentId?: string;
  agentApiKey?: string;
}

export class OneClawClient {
  private readonly opts: OneClawClientOptions;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(opts: OneClawClientOptions) {
    if (!opts.apiKey && !(opts.agentId && opts.agentApiKey)) {
      throw new Error("OneClawClient needs either { apiKey } (human, 1ck_) or { agentId, agentApiKey } (agent, ocv_)");
    }
    this.opts = opts;
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt - 15_000 > now) {
      return this.cachedToken.value;
    }
    const { url, body } = this.opts.apiKey
      ? { url: `${BASE_URL}/v1/auth/api-key-token`, body: { api_key: this.opts.apiKey } }
      : { url: `${BASE_URL}/v1/auth/agent-token`, body: { agent_id: this.opts.agentId, api_key: this.opts.agentApiKey } };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const token = await parseJsonOrThrow<AccessToken>(res);
    this.cachedToken = { value: token.access_token, expiresAt: now + token.expires_in * 1000 };
    return token.access_token;
  }

  private async headers(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.getToken()}`,
      "Content-Type": "application/json",
    };
  }

  // --- Vaults (human) ---

  async createVault(name: string, description?: string): Promise<Vault> {
    const res = await fetch(`${BASE_URL}/v1/vaults`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({ name, description }),
    });
    return parseJsonOrThrow<Vault>(res);
  }

  async listVaults(): Promise<Vault[]> {
    const res = await fetch(`${BASE_URL}/v1/vaults`, { headers: await this.headers() });
    const body = await parseJsonOrThrow<{ vaults: Vault[] } | Vault[]>(res);
    return Array.isArray(body) ? body : body.vaults;
  }

  async getVault(vaultId: string): Promise<Vault> {
    const res = await fetch(`${BASE_URL}/v1/vaults/${encodeURIComponent(vaultId)}`, {
      headers: await this.headers(),
    });
    return parseJsonOrThrow<Vault>(res);
  }

  async deleteVault(vaultId: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/v1/vaults/${encodeURIComponent(vaultId)}`, {
      method: "DELETE",
      headers: await this.headers(),
    });
    await parseJsonOrThrow<void>(res);
  }

  // --- Secrets ---

  async setSecret(
    vaultId: string,
    path: string,
    value: string,
    opts: { type: SecretType; metadata?: Record<string, unknown> },
  ): Promise<SecretMetadata> {
    const res = await fetch(
      `${BASE_URL}/v1/vaults/${encodeURIComponent(vaultId)}/secrets/${encodeSecretPath(path)}`,
      {
        method: "PUT",
        headers: await this.headers(),
        body: JSON.stringify({ type: opts.type, value, metadata: opts.metadata }),
      },
    );
    return parseJsonOrThrow<SecretMetadata>(res);
  }

  // Returns the decrypted value. Callers: use it immediately, never log or persist it
  // outside a vault (the whole point of this package is to keep it out of prompts/logs).
  async getSecret(vaultId: string, path: string): Promise<Secret> {
    const res = await fetch(
      `${BASE_URL}/v1/vaults/${encodeURIComponent(vaultId)}/secrets/${encodeSecretPath(path)}`,
      { headers: await this.headers() },
    );
    return parseJsonOrThrow<Secret>(res);
  }

  async listSecrets(vaultId: string): Promise<SecretMetadata[]> {
    const res = await fetch(`${BASE_URL}/v1/vaults/${encodeURIComponent(vaultId)}/secrets`, {
      headers: await this.headers(),
    });
    const body = await parseJsonOrThrow<{ secrets: SecretMetadata[] }>(res);
    return body.secrets;
  }

  async deleteSecret(vaultId: string, path: string): Promise<void> {
    const res = await fetch(
      `${BASE_URL}/v1/vaults/${encodeURIComponent(vaultId)}/secrets/${encodeSecretPath(path)}`,
      { method: "DELETE", headers: await this.headers() },
    );
    await parseJsonOrThrow<void>(res);
  }

  // --- Agents (human) ---

  // api_key is returned once, at creation — persist it immediately (e.g. into a vault
  // secret under the human's own account) or it's gone.
  //
  // Two things confirmed live (2026-09-29) that the Human API reference page for this
  // endpoint does not document:
  // 1. `vaultIds` — an agent can only ever fetch secrets from vaults listed here, no matter
  //    what policies grant it. Omitting it (as the docs' own example does) leaves the agent
  //    bound to no vault at all: every fetch 403s with "Agent token is not bound to this vault".
  // 2. Passing `scopes` explicitly (again, as the docs' own example does —
  //    `scopes: ["vaults:read"]`) fixes the JWT's scopes to exactly that list. Per one line
  //    elsewhere in the docs ("JWT scopes are derived from those policies when agents.scopes
  //    is empty"), leaving `scopes` unset is what makes a policy grant actually take effect —
  //    with it set, a real policy grant still 403s with "Agent token scopes do not cover this
  //    secret path". So: pass `vaultIds`, and leave `scopes` unset unless you specifically want
  //    to bypass policy-derived scopes.
  async createAgent(
    name: string,
    opts: { description?: string; scopes?: string[]; vaultIds?: string[] } = {},
  ): Promise<CreateAgentResult> {
    const res = await fetch(`${BASE_URL}/v1/agents`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({ name, description: opts.description, scopes: opts.scopes, vault_ids: opts.vaultIds }),
    });
    return parseJsonOrThrow<CreateAgentResult>(res);
  }

  async getAgent(agentId: string): Promise<Agent> {
    const res = await fetch(`${BASE_URL}/v1/agents/${encodeURIComponent(agentId)}`, {
      headers: await this.headers(),
    });
    return parseJsonOrThrow<Agent>(res);
  }

  // Partial update — e.g. { intents_api_enabled, eip712_domain_allowlist, eip712_default_policy,
  // shroud_config }. Not fully enumerated in types.ts since the set of patchable fields is large
  // and growing; callers pass exactly the fields they mean to change.
  async updateAgent(agentId: string, patch: Record<string, unknown>): Promise<Agent> {
    const res = await fetch(`${BASE_URL}/v1/agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      headers: await this.headers(),
      body: JSON.stringify(patch),
    });
    return parseJsonOrThrow<Agent>(res);
  }

  async deleteAgent(agentId: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/v1/agents/${encodeURIComponent(agentId)}`, {
      method: "DELETE",
      headers: await this.headers(),
    });
    await parseJsonOrThrow<void>(res);
  }

  // --- Policies (grants) ---

  async createPolicy(
    vaultId: string,
    opts: {
      secretPathPattern: string;
      principalType: PrincipalType;
      principalId: string;
      permissions: PolicyPermission[];
    },
  ): Promise<Policy> {
    const res = await fetch(`${BASE_URL}/v1/vaults/${encodeURIComponent(vaultId)}/policies`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({
        secret_path_pattern: opts.secretPathPattern,
        principal_type: opts.principalType,
        principal_id: opts.principalId,
        permissions: opts.permissions,
      }),
    });
    return parseJsonOrThrow<Policy>(res);
  }

  async listPolicies(vaultId: string): Promise<Policy[]> {
    const res = await fetch(`${BASE_URL}/v1/vaults/${encodeURIComponent(vaultId)}/policies`, {
      headers: await this.headers(),
    });
    const body = await parseJsonOrThrow<{ policies: Policy[] } | Policy[]>(res);
    return Array.isArray(body) ? body : body.policies;
  }

  // --- Automations ---

  async createAutomation(input: CreateAutomationInput): Promise<Automation> {
    const res = await fetch(`${BASE_URL}/v1/automations`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify(input),
    });
    return parseJsonOrThrow<Automation>(res);
  }

  async getAutomation(id: string): Promise<Automation> {
    const res = await fetch(`${BASE_URL}/v1/automations/${encodeURIComponent(id)}`, {
      headers: await this.headers(),
    });
    return parseJsonOrThrow<Automation>(res);
  }

  async deleteAutomation(id: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/v1/automations/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: await this.headers(),
    });
    await parseJsonOrThrow<void>(res);
  }

  // idempotencyKey lets a caller retry a trigger request safely — the same key returns the
  // already-started run with 200 instead of starting a second one.
  async triggerAutomation(id: string, opts: { input?: unknown; idempotencyKey?: string } = {}): Promise<AutomationRun> {
    const headers = await this.headers();
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    const res = await fetch(`${BASE_URL}/v1/automations/${encodeURIComponent(id)}/trigger`, {
      method: "POST",
      headers,
      body: JSON.stringify({ input: opts.input }),
    });
    return parseJsonOrThrow<AutomationRun>(res);
  }

  async getAutomationRun(automationId: string, runId: string): Promise<AutomationRun> {
    const res = await fetch(
      `${BASE_URL}/v1/automations/${encodeURIComponent(automationId)}/runs/${encodeURIComponent(runId)}`,
      { headers: await this.headers() },
    );
    return parseJsonOrThrow<AutomationRun>(res);
  }

  async listAutomationRuns(automationId: string): Promise<AutomationRun[]> {
    const res = await fetch(`${BASE_URL}/v1/automations/${encodeURIComponent(automationId)}/runs`, {
      headers: await this.headers(),
    });
    const body = await parseJsonOrThrow<{ runs: AutomationRun[] } | AutomationRun[]>(res);
    return Array.isArray(body) ? body : body.runs;
  }

  // Human-only per docs — an agent-authenticated client gets 403. Only "running" or
  // "awaiting_approval" runs are cancellable.
  async cancelAutomationRun(automationId: string, runId: string): Promise<void> {
    const res = await fetch(
      `${BASE_URL}/v1/automations/${encodeURIComponent(automationId)}/runs/${encodeURIComponent(runId)}/cancel`,
      { method: "POST", headers: await this.headers() },
    );
    await parseJsonOrThrow<void>(res);
  }

  // --- Intents API (signing) ---

  async createSigningKey(agentId: string, chain: string): Promise<SigningKey> {
    const res = await fetch(`${BASE_URL}/v1/agents/${encodeURIComponent(agentId)}/signing-keys`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify({ chain }),
    });
    return parseJsonOrThrow<SigningKey>(res);
  }

  async listSigningKeys(agentId: string): Promise<SigningKey[]> {
    const res = await fetch(`${BASE_URL}/v1/agents/${encodeURIComponent(agentId)}/signing-keys`, {
      headers: await this.headers(),
    });
    const body = await parseJsonOrThrow<{ keys: SigningKey[] } | SigningKey[]>(res);
    return Array.isArray(body) ? body : body.keys;
  }

  async deactivateSigningKey(agentId: string, chain: string): Promise<void> {
    const res = await fetch(
      `${BASE_URL}/v1/agents/${encodeURIComponent(agentId)}/signing-keys/${encodeURIComponent(chain)}`,
      { method: "DELETE", headers: await this.headers() },
    );
    await parseJsonOrThrow<void>(res);
  }

  // Unified sign endpoint — personal_sign, typed_data, eip712_digest, or transaction. The agent's
  // eip712_domain_allowlist (or eip712_default_policy: "allow") must cover a typed_data domain's
  // verifyingContract, and raw_signing_enabled must be set for eip712_digest (human-set only).
  async sign(
    agentId: string,
    request:
      | { intent_type: "personal_sign"; chain: string; message: string }
      | { intent_type: "typed_data"; chain: string; typed_data: EIP712TypedData }
      | { intent_type: "eip712_digest"; chain: string; hash: `0x${string}` },
  ): Promise<SignResult> {
    const res = await fetch(`${BASE_URL}/v1/agents/${encodeURIComponent(agentId)}/sign`, {
      method: "POST",
      headers: await this.headers(),
      // EIP712TypedData messages routinely carry BigInt for uint256 fields (viem's own convention
      // for signTypedData, e.g. @verdict/imd-client's permit2PaymentTypedData) — plain JSON.stringify
      // throws on those, so every uint256 gets its decimal string instead, same as this API's own
      // request/response bodies already represent large numbers.
      body: JSON.stringify(request, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
    });
    return parseJsonOrThrow<SignResult>(res);
  }

  // Signs AND broadcasts via 1Claw's own dedicated RPC for the target chain — the vault decrypts
  // the key inside the HSM boundary, builds, signs, and sends. `data` carries raw ABI-encoded
  // calldata for a contract call (viem's encodeFunctionData); omit it for a plain native transfer.
  async submitTransaction(agentId: string, input: TransactionInput): Promise<SubmittedTransaction> {
    const res = await fetch(`${BASE_URL}/v1/agents/${encodeURIComponent(agentId)}/transactions`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify(input),
    });
    return parseJsonOrThrow<SubmittedTransaction>(res);
  }

  // Sign-only (BYORPC): same request shape as submitTransaction, but never broadcasts — returns the
  // raw signed tx hex for the caller to broadcast itself. No gas is spent signing; only broadcasting
  // costs anything, which is exactly why this is the free way to prove signing works for real.
  async signTransaction(agentId: string, input: TransactionInput): Promise<SignedTransaction> {
    const res = await fetch(`${BASE_URL}/v1/agents/${encodeURIComponent(agentId)}/transactions/sign`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify(input),
    });
    return parseJsonOrThrow<SignedTransaction>(res);
  }
}

// --- Workflow step builders (Automations) ---

export function waitUntilStep(until: string, opts: { name?: string } = {}): WorkflowStep {
  return { type: "wait_until", until, ...opts };
}

export function httpStep(
  url: string,
  opts: { name?: string; method?: string; headers?: Record<string, string>; body?: unknown } = {},
): WorkflowStep {
  return { type: "http", url, method: opts.method ?? "POST", headers: opts.headers, body: opts.body, name: opts.name };
}
