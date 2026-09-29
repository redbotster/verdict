import { OneClawClient } from "../../oneclaw-client/src/client.ts";
import { OneClawApiError } from "../../oneclaw-client/src/types.ts";
import { generateClientToken } from "../../imd-client/src/client.ts";

// Implements the spec's 1Claw integration table row: "Hold IMD paid tokens, GitHub tokens, LLM
// keys | Vaults ... | One vault, paths imd/orders/<deal>, github/publish." A per-deal IMD token
// is worth persisting rather than discarding, per IMD's own docs: "keep it; it reads your orders
// later" — so a resolver that restarts mid-poll, or a human checking on a stuck deal, can still
// use GET /requests/paid-by/:address style lookups against the same identity.
//
// This is a convenience for callers that have a 1Claw vault configured — resolveDeal() itself
// still just takes a plain imdToken string (see resolve.ts's ResolveDealOptions) and has no
// dependency on 1Claw at all, so a caller without vault access can keep passing
// generateClientToken() or their own token directly.

export interface VaultConfig {
  client: OneClawClient;
  vaultId: string;
}

function imdOrderSecretPath(dealId: string): string {
  return `imd/orders/${dealId}`;
}

// Fetches the persisted per-deal IMD token if one exists; otherwise generates a fresh one and
// stores it, so the next call for the same dealId reuses it instead of minting a new identity.
//
// UNCONFIRMED: assumes a missing secret returns 404 (standard REST/RFC 7807 convention, matching
// this client's OneClawApiError.httpStatus) — not live-verified against the real API. If 1Claw
// returns a different status for "not found" (e.g. 400 or 422), this will rethrow instead of
// creating the token on first use; run oneclaw-client's live-smoke script against a fresh path to
// confirm before relying on this in production.
export async function loadOrCreateImdToken(vault: VaultConfig, dealId: string): Promise<string> {
  const path = imdOrderSecretPath(dealId);
  try {
    const secret = await vault.client.getSecret(vault.vaultId, path);
    return secret.value;
  } catch (err) {
    if (!(err instanceof OneClawApiError) || err.httpStatus !== 404) throw err;
  }
  const token = generateClientToken();
  await vault.client.setSecret(vault.vaultId, path, token, {
    type: "api_key",
    metadata: { purpose: "imd-paid-request-token", dealId },
  });
  return token;
}

// The spec's other vault path: github/publish. Plain passthrough lookup — no fallback generation,
// since a GitHub token isn't something this codebase can mint on its own.
export async function loadGithubPublishToken(vault: VaultConfig): Promise<string> {
  const secret = await vault.client.getSecret(vault.vaultId, "github/publish");
  return secret.value;
}
