import { recoverTypedDataAddress } from "viem";
import type { EIP712TypedData, SignResult } from "../../oneclaw-client/src/types.ts";

// Permit2's real, public EIP-712 schema for a single-use "signature transfer" authorization
// (ISignatureTransfer.PermitTransferFrom) — confirmed 2026-09-29 directly from Uniswap's public
// repo, not memory or guessing:
//   - Domain: PermitHash.sol / EIP712.sol (github.com/Uniswap/permit2) — {name: "Permit2", chainId,
//     verifyingContract}, no `version` field.
//   - Types: PermitHash.sol's _PERMIT_TRANSFER_FROM_TYPEHASH, matching @uniswap/permit2-sdk's
//     signatureTransfer.ts exactly: PermitTransferFrom{permitted:TokenPermissions, spender, nonce,
//     deadline}, TokenPermissions{token, amount}.
//   - Canonical deployment: 0x000000000022D473030F116dDEE9F6B43aC78BA3, confirmed from the
//     official @uniswap/permit2-sdk npm package's constants.ts (same address on every chain except
//     zkSync).
//
// This is the generic, correct, publicly-verifiable half of what IMD's "extra: {assetTransferMethod:
// permit2}" payment scheme needs. It is NOT, by itself, IMD's actual integration: IMD's specific
// `spender` (is it their payTo address directly, or an intermediary?), `nonce` source, and whether
// they require a witness (PermitWitnessTransferFrom, binding the permit to a specific quoteHash)
// are still unconfirmed and NOT guessed here — see paymentSigner.ts and
// docs/DAY-ONE-FINDINGS.md for that remaining gap. What this module proves is that the Permit2
// signing half is real and 1Claw can actually produce a valid signature for it, once IMD's specific
// parameters are known.
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

export interface Permit2TransferPermit {
  token: `0x${string}`;
  amount: bigint;
  spender: `0x${string}`;
  nonce: bigint;
  deadline: bigint;
}

export function permit2TypedData(permit: Permit2TransferPermit, chainId: number): EIP712TypedData {
  return {
    domain: { name: "Permit2", chainId, verifyingContract: PERMIT2_ADDRESS },
    types: {
      PermitTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
    primaryType: "PermitTransferFrom",
    message: {
      permitted: { token: permit.token, amount: permit.amount.toString() },
      spender: permit.spender,
      nonce: permit.nonce.toString(),
      deadline: permit.deadline.toString(),
    },
  };
}

// Narrow interface, not the concrete OneClawClient class — same DI pattern used throughout this
// package (vaultSecrets.ts, automation.ts).
export interface IntentsSigner {
  sign(
    agentId: string,
    request: { intent_type: "typed_data"; chain: string; typed_data: EIP712TypedData },
  ): Promise<SignResult>;
}

// Signs a Permit2 PermitTransferFrom via 1Claw's Intents API (POST /v1/agents/:id/sign,
// intent_type: "typed_data") — the actual private key never leaves 1Claw's vault/TEE. `chain` is
// 1Claw's own chain-name string (e.g. "ethereum"), not a numeric chain id, per its Intents docs.
export async function signPermit2Transfer(
  client: IntentsSigner,
  agentId: string,
  chain: string,
  chainId: number,
  permit: Permit2TransferPermit,
): Promise<{ signature: `0x${string}`; typedData: EIP712TypedData }> {
  const typedData = permit2TypedData(permit, chainId);
  const result = await client.sign(agentId, { intent_type: "typed_data", chain, typed_data: typedData });
  return { signature: result.signature, typedData };
}

// Independent, local verification that a signature actually recovers to the claimed signer —
// doesn't trust 1Claw's response at face value, matching this project's "verify against reality"
// discipline. Pure crypto, no network call.
export async function verifyPermit2Signature(
  typedData: EIP712TypedData,
  signature: `0x${string}`,
  expectedSigner: `0x${string}`,
): Promise<boolean> {
  const recovered = await recoverTypedDataAddress({
    domain: typedData.domain as Parameters<typeof recoverTypedDataAddress>[0]["domain"],
    types: typedData.types as Parameters<typeof recoverTypedDataAddress>[0]["types"],
    primaryType: typedData.primaryType,
    message: typedData.message,
    signature,
  });
  return recovered.toLowerCase() === expectedSigner.toLowerCase();
}
