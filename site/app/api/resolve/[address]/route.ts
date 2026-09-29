// The endpoint a 1Claw Automation calls at a deal's deadline (see
// server/resolver/src/automation.ts's scheduleResolutionAutomation, which builds the wait_until +
// http workflow that hits this route). Runs resolveDeal() server-side with a real signer and a real
// payment signature — the actual settlement path, not a demo.
//
// This project has no database yet (site/lib/deals.ts is an explicit placeholder), so this route is
// deliberately stateless: everything resolveDeal() needs travels in the callback body itself, set
// once when the automation was scheduled. There's nothing to look up here.
//
// Never deployed or exercised against a real automation callback — see site/README.md for what's
// been checked (a local dev server against a real Anvil-deployed escrow) versus what a real
// production deployment still needs (a real signer via env, and ideally a 1Claw-backed one instead
// of a raw private key — see server/oneclaw-client/src/typedDataSigner.ts).
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveDeal, imdPaymentSigner } from "@verdict/resolver";
import { generateClientToken } from "@verdict/imd-client";
import type { OracleRequestInput } from "@verdict/oracle-compiler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResolveWebhookBody {
  dealId: string;
  chainId: number;
  rpcUrl: string;
  oracleInput: OracleRequestInput;
  expectedQuestionHash: `0x${string}`;
  payoutEstimateBaseUnits: string; // serialized bigint — JSON has no bigint
  approvalThresholdBaseUnits?: string;
}

export async function POST(request: Request, { params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;

  const configuredSecret = process.env.RESOLVER_WEBHOOK_SECRET;
  if (!configuredSecret) {
    return Response.json({ error: "RESOLVER_WEBHOOK_SECRET is not configured — refusing to run unauthenticated" }, { status: 500 });
  }
  if (request.headers.get("x-resolver-secret") !== configuredSecret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: ResolveWebhookBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.oracleInput || !body.expectedQuestionHash || !body.payoutEstimateBaseUnits || !body.rpcUrl) {
    return Response.json({ error: "missing required fields: oracleInput, expectedQuestionHash, payoutEstimateBaseUnits, rpcUrl" }, { status: 400 });
  }

  const privateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) {
    // Swap this for server/oneclaw-client's oneClawTypedDataSigner + a viem-account-shaped wrapper
    // once 1Claw's Intents API dashboard toggle is flipped for the resolver's agent — that keeps the
    // key in 1Claw's HSM instead of this process's environment. See docs/DAY-ONE-FINDINGS.md §10.
    return Response.json({ error: "EVM_PRIVATE_KEY is not configured" }, { status: 500 });
  }
  const account = privateKeyToAccount(privateKey);

  // site and server/resolver each install their own copy of viem (both 2.56.9 — no `file:`-based
  // symlinking or workspace hoisting between them, see .github/workflows/ci.yml's per-package `npm
  // install` steps). TypeScript treats the two installs as nominally distinct types even though
  // they're structurally identical at runtime, so a plain assignment fails to typecheck across this
  // package boundary. Same root cause class as base-mainnet-demo.ts's chain-typing cast; resolved the
  // same way, against resolveDeal's own declared parameter types rather than a re-imported viem type.
  const publicClient = createPublicClient({ transport: http(body.rpcUrl) }) as unknown as Parameters<typeof resolveDeal>[1]["publicClient"];
  const walletClient = createWalletClient({ account, transport: http(body.rpcUrl) }) as unknown as Parameters<typeof resolveDeal>[1]["walletClient"];

  try {
    const result = await resolveDeal(
      {
        escrow: { address: address as `0x${string}`, chainId: body.chainId },
        oracleInput: body.oracleInput,
        expectedQuestionHash: body.expectedQuestionHash,
        payoutEstimateBaseUnits: BigInt(body.payoutEstimateBaseUnits),
      },
      {
        imdToken: generateClientToken(),
        paymentSigner: imdPaymentSigner(account),
        approvalThresholdBaseUnits: body.approvalThresholdBaseUnits ? BigInt(body.approvalThresholdBaseUnits) : 0n,
        // No real ApprovalGate wired in yet — resolveDeal() throws ApprovalNotWiredError above the
        // threshold rather than silently approving. See server/resolver/src/approval.ts.
        publicClient,
        walletClient,
      },
    );
    return Response.json({ ok: true, result: serializeResult(result) });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}

function serializeResult(result: Awaited<ReturnType<typeof resolveDeal>>) {
  return JSON.parse(JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
}
