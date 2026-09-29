import { test } from "node:test";
import assert from "node:assert/strict";
import { loadOrCreateImdToken, loadGithubPublishToken, type VaultClient } from "../src/vaultSecrets.ts";
import { OneClawApiError } from "../../oneclaw-client/src/types.ts";
import type { Secret, SecretMetadata } from "../../oneclaw-client/src/types.ts";

function fakeSecret(overrides: Partial<Secret> = {}): Secret {
  return {
    id: "secret-1",
    path: "imd/orders/deal-1",
    type: "api_key",
    version: 1,
    created_at: new Date().toISOString(),
    value: "existing-token",
    ...overrides,
  };
}

function notFound(path: string): OneClawApiError {
  return new OneClawApiError(404, { type: "about:blank", title: "Not Found", status: 404, detail: `Secret ${path} not found` });
}

test("loadOrCreateImdToken: reuses a persisted token instead of minting a new one", async () => {
  let getCalls = 0;
  const setCalls: unknown[] = [];
  const fakeClient: VaultClient = {
    getSecret: async (vaultId, path) => {
      getCalls++;
      assert.equal(vaultId, "vault-1");
      assert.equal(path, "imd/orders/deal-1");
      return fakeSecret();
    },
    setSecret: async (...args) => {
      setCalls.push(args);
      throw new Error("should not be called when a secret already exists");
    },
  };

  const token = await loadOrCreateImdToken({ client: fakeClient, vaultId: "vault-1" }, "deal-1");
  assert.equal(token, "existing-token");
  assert.equal(getCalls, 1);
  assert.equal(setCalls.length, 0);
});

test("loadOrCreateImdToken: mints and persists a fresh token on a 404", async () => {
  let storedValue: string | undefined;
  const fakeClient: VaultClient = {
    getSecret: async (_vaultId, path) => {
      throw notFound(path);
    },
    setSecret: async (vaultId, path, value, opts) => {
      assert.equal(vaultId, "vault-1");
      assert.equal(path, "imd/orders/deal-2");
      assert.equal(opts.type, "api_key");
      storedValue = value;
      return { id: "secret-2", path, type: "api_key", version: 1, created_at: new Date().toISOString() } satisfies SecretMetadata;
    },
  };

  const token = await loadOrCreateImdToken({ client: fakeClient, vaultId: "vault-1" }, "deal-2");
  assert.ok(token.length > 0);
  assert.equal(storedValue, token);
});

test("loadOrCreateImdToken: a non-404 error propagates instead of being swallowed", async () => {
  const fakeClient: VaultClient = {
    getSecret: async () => {
      throw new OneClawApiError(500, { type: "about:blank", title: "Internal Server Error", status: 500 });
    },
    setSecret: async () => {
      throw new Error("should not be called");
    },
  };

  await assert.rejects(
    () => loadOrCreateImdToken({ client: fakeClient, vaultId: "vault-1" }, "deal-3"),
    OneClawApiError,
  );
});

test("loadOrCreateImdToken: a non-OneClawApiError also propagates", async () => {
  const fakeClient: VaultClient = {
    getSecret: async () => {
      throw new TypeError("network blew up");
    },
    setSecret: async () => {
      throw new Error("should not be called");
    },
  };

  await assert.rejects(
    () => loadOrCreateImdToken({ client: fakeClient, vaultId: "vault-1" }, "deal-4"),
    TypeError,
  );
});

test("loadGithubPublishToken: reads github/publish with no fallback generation", async () => {
  const fakeClient: VaultClient = {
    getSecret: async (vaultId, path) => {
      assert.equal(vaultId, "vault-1");
      assert.equal(path, "github/publish");
      return fakeSecret({ path: "github/publish", value: "ghp_fake" });
    },
    setSecret: async () => {
      throw new Error("should never write github/publish");
    },
  };

  const token = await loadGithubPublishToken({ client: fakeClient, vaultId: "vault-1" });
  assert.equal(token, "ghp_fake");
});

test("loadGithubPublishToken: a missing secret propagates rather than being silently generated", async () => {
  const fakeClient: VaultClient = {
    getSecret: async (_vaultId, path) => {
      throw notFound(path);
    },
    setSecret: async () => {
      throw new Error("should never write github/publish");
    },
  };

  await assert.rejects(
    () => loadGithubPublishToken({ client: fakeClient, vaultId: "vault-1" }),
    OneClawApiError,
  );
});
