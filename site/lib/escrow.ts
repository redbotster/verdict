import { createPublicClient, http, type Address } from "viem";
import { loadMilestoneEscrowAbi } from "./artifact";

const ERC20_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export const ESCROW_STATE_LABELS = ["Funded", "Released", "Refunded"] as const;

export interface EscrowOnChainState {
  payer: Address;
  payee: Address;
  token: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  amount: bigint;
  deadline: bigint;
  grace: bigint;
  challengeWindow: bigint;
  feeBps: number;
  feeRecipient: Address;
  questionHash: `0x${string}`;
  oracleSigner: Address;
  state: (typeof ESCROW_STATE_LABELS)[number];
  trueAt: bigint;
  escrowBalance: bigint;
  owedToPayer: bigint;
  owedToPayee: bigint;
  owedToFeeRecipient: bigint;
}

export async function readEscrowOnChainState(rpcUrl: string, escrowAddress: Address): Promise<EscrowOnChainState> {
  const abi = loadMilestoneEscrowAbi();
  const client = createPublicClient({ transport: http(rpcUrl) });

  const [payer, payee, token, amount, deadline, grace, challengeWindow, feeBps, feeRecipient, questionHash, oracleSigner, stateIndex, trueAt] = await Promise.all([
    client.readContract({ address: escrowAddress, abi, functionName: "payer" }) as Promise<Address>,
    client.readContract({ address: escrowAddress, abi, functionName: "payee" }) as Promise<Address>,
    client.readContract({ address: escrowAddress, abi, functionName: "token" }) as Promise<Address>,
    client.readContract({ address: escrowAddress, abi, functionName: "amount" }) as Promise<bigint>,
    client.readContract({ address: escrowAddress, abi, functionName: "deadline" }) as Promise<bigint>,
    client.readContract({ address: escrowAddress, abi, functionName: "grace" }) as Promise<bigint>,
    client.readContract({ address: escrowAddress, abi, functionName: "challengeWindow" }) as Promise<bigint>,
    client.readContract({ address: escrowAddress, abi, functionName: "feeBps" }) as Promise<number>,
    client.readContract({ address: escrowAddress, abi, functionName: "feeRecipient" }) as Promise<Address>,
    client.readContract({ address: escrowAddress, abi, functionName: "questionHash" }) as Promise<`0x${string}`>,
    client.readContract({ address: escrowAddress, abi, functionName: "oracleSigner" }) as Promise<Address>,
    client.readContract({ address: escrowAddress, abi, functionName: "state" }) as Promise<0 | 1 | 2>,
    client.readContract({ address: escrowAddress, abi, functionName: "trueAt" }) as Promise<bigint>,
  ]);

  const [tokenSymbol, tokenDecimals, escrowBalance, owedToPayer, owedToPayee, owedToFeeRecipient] = await Promise.all([
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }),
    client.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [escrowAddress] }),
    client.readContract({ address: escrowAddress, abi, functionName: "owed", args: [payer] }) as Promise<bigint>,
    client.readContract({ address: escrowAddress, abi, functionName: "owed", args: [payee] }) as Promise<bigint>,
    client.readContract({ address: escrowAddress, abi, functionName: "owed", args: [feeRecipient] }) as Promise<bigint>,
  ]);

  return {
    payer,
    payee,
    token,
    tokenSymbol,
    tokenDecimals,
    amount,
    deadline,
    grace,
    challengeWindow,
    feeBps,
    feeRecipient,
    questionHash,
    oracleSigner,
    state: ESCROW_STATE_LABELS[stateIndex],
    trueAt,
    escrowBalance,
    owedToPayer,
    owedToPayee,
    owedToFeeRecipient,
  };
}
