import type { OneClawClient } from "./client.ts";
import type { EIP712TypedData } from "./types.ts";

// Wraps 1Claw's Intents API sign() into the same minimal shape viem's LocalAccount already has —
// { address, signTypedData(args) } — so a 1Claw-held key can be dropped into anything in this repo
// that currently takes a raw viem account: resolver's paymentSigner.ts (imdPaymentSigner) and any
// EIP-712 attestation signing that calls `.signTypedData({domain, types, primaryType, message})`.
// The whole point: the ops wallet's private key lives in 1Claw's HSM, never in a local env file or
// this process's memory — this package only ever sees a signature back.
//
// Requires, per 1Claw's docs (docs.1claw.co, confirmed live 2026-09-29 alongside a real gap: see
// docs/DAY-ONE-FINDINGS.md §10):
//   1. A signing key already provisioned for this agent on the target chain
//      (OneClawClient.createSigningKey) — its returned `address` is what you pass in here.
//   2. intents_api_enabled: true and the domain's verifyingContract allowlisted via
//      eip712_domain_allowlist / eip712_default_policy (OneClawClient.updateAgent).
//   3. The org's "Intents API" toggle flipped for this agent at 1claw.co/agents — confirmed live
//      that this specific gate is dashboard-only, no API call can set it (§10).
//
// Not live-verified end to end: server/resolver/scripts/permit2-demo.ts hit exactly gate #3 above
// and fell back to a local viem account — this adapter is code-complete and typechecked, but has
// never actually produced a signature through 1Claw's real sign endpoint. Re-run that demo once the
// toggle is flipped to get the live proof.
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

export function oneClawTypedDataSigner(opts: OneClawTypedDataSignerOptions): TypedDataSigner {
  return {
    address: opts.address,
    async signTypedData(typedData: EIP712TypedData): Promise<`0x${string}`> {
      const result = await opts.client.sign(opts.agentId, {
        intent_type: "typed_data",
        chain: opts.chain,
        typed_data: typedData,
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
