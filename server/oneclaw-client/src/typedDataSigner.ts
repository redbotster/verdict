import type { OneClawClient } from "./client.ts";
import type { EIP712TypedData } from "./types.ts";

// Wraps 1Claw's Intents API sign() into the same minimal shape viem's LocalAccount already has —
// { address, signTypedData(args) } — so a 1Claw-held key can be dropped into anything in this repo
// that currently takes a raw viem account: resolver's paymentSigner.ts (imdPaymentSigner) and any
// EIP-712 attestation signing that calls `.signTypedData({domain, types, primaryType, message})`.
// The whole point: the ops wallet's private key lives in 1Claw's HSM, never in a local env file or
// this process's memory — this package only ever sees a signature back.
//
// Live-verified 2026-09-29 (docs/DAY-ONE-FINDINGS.md §20, correcting §10): a real signature,
// produced through 1Claw's actual sign endpoint, independently recovers via viem's
// recoverTypedDataAddress to this agent's real signing-key address. §10's belief that the Intents
// toggle was dashboard-only turned out to be wrong — it's the same PATCH /v1/agents/:id field as
// always, but flipping it doesn't retroactively update a JWT already minted before the change (the
// same stale-claim shape as shroud_config). The fix is a fresh token, not a dashboard visit or a
// plan upgrade (1Claw's own docs briefly implied Business+ tier was required; that was a copy bug on
// their end, since fixed).
//
// Requires:
//   1. A signing key already provisioned for this agent on the target chain
//      (OneClawClient.createSigningKey) — its returned `address` is what you pass in here.
//   2. intents_api_enabled: true (a fresh agent-token exchange afterward, not just the PATCH).
//   3. The domain's verifyingContract allowlisted via eip712_domain_allowlist — and this has to be
//      `[{ verifying_contract: "0x..." }]` (an array of objects), not `["0x..."]` (an array of plain
//      strings) — the latter silently "succeeds" (1Claw accepts and stores it) but never actually
//      matches anything, so signing keeps 403ing with no hint the shape itself was wrong.
//
// This module also does one piece of real wire-format translation the caller shouldn't have to
// think about: 1Claw's server-side EIP-712 hasher requires `types.EIP712Domain` to be present
// explicitly, unlike viem's signTypedData (which derives it from `domain` and doesn't want it in
// `types` at all) — every EIP712TypedData object in this repo is built for viem's convention and
// omits it, so withDomainType() injects it before the request goes out.
export interface OneClawTypedDataSignerOptions {
  client: OneClawClient;
  agentId: string;
  /** The address 1Claw returned when this agent's signing key was provisioned. */
  address: `0x${string}`;
  /** 1Claw's own chain-name string (e.g. "ethereum", "base"), not a numeric chain id. */
  chain: string;
}

export interface TypedDataSigner {
  address: `0x${string}`;
  signTypedData(args: EIP712TypedData): Promise<`0x${string}`>;
}

// The standard EIP-712 domain fields, in their canonical order — only the ones actually present in
// a given `domain` object are included, matching how every real EIP-712 domain omits whichever of
// these it doesn't use (e.g. Permit2's domain has no `version` or `salt`).
const DOMAIN_FIELD_TYPES: Record<string, string> = {
  name: "string",
  version: "string",
  chainId: "uint256",
  verifyingContract: "address",
  salt: "bytes32",
};

// viem's own signTypedData derives the EIP712Domain type array from the `domain` object itself and
// doesn't require (or even accept) it in `types` — so every EIP712TypedData object built for local
// viem signing throughout this repo (e.g. @verdict/imd-client's paymentSigning.ts) omits it. 1Claw's
// server-side hasher is stricter: confirmed live 2026-09-29, it 400s with "Type 'EIP712Domain' not
// found in types" without this. Adding it here, not at every call site, keeps every existing
// EIP712TypedData producer viem-compatible as-is.
export function withDomainType(typedData: EIP712TypedData): EIP712TypedData {
  if (typedData.types.EIP712Domain) return typedData;
  const fields = Object.keys(typedData.domain)
    .filter((key) => key in DOMAIN_FIELD_TYPES)
    .map((name) => ({ name, type: DOMAIN_FIELD_TYPES[name]! }));
  return { ...typedData, types: { ...typedData.types, EIP712Domain: fields } };
}

export function oneClawTypedDataSigner(opts: OneClawTypedDataSignerOptions): TypedDataSigner {
  return {
    address: opts.address,
    async signTypedData(typedData: EIP712TypedData): Promise<`0x${string}`> {
      const result = await opts.client.sign(opts.agentId, {
        intent_type: "typed_data",
        chain: opts.chain,
        typed_data: withDomainType(typedData),
      });
      return result.signature;
    },
  };
}

// Numeric EIP-155 chain id -> 1Claw's chain-name string, for the chains this project actually
// targets. 1Claw's full, live list is GET /v1/chains — extend this map if you need another one.
const CHAIN_NAMES: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  11155111: "sepolia",
  84532: "base-sepolia",
};

export function oneClawChainName(chainId: number): string {
  const name = CHAIN_NAMES[chainId];
  if (!name) throw new Error(`No known 1Claw chain name for chain id ${chainId} — check GET /v1/chains and add it to CHAIN_NAMES`);
  return name;
}
