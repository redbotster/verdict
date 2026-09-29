import type {
  AccessToken,
  Agent,
  CreateAgentResult,
  Policy,
  PolicyPermission,
  PrincipalType,
  Secret,
  SecretMetadata,
  SecretType,
  Vault,
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
}
