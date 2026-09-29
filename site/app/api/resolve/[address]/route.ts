// The endpoint a 1Claw Automation calls at a deal's deadline (see
// server/resolver/src/automation.ts's scheduleResolutionAutomation, which builds the wait_until +
// http workflow that hits this route). Runs resolveDeal() server-side with a real signer and a real
// payment signature — the actual settlement path, not a demo.
//
// Looks the deal up in Supabase by address (lib/deals.ts) rather than requiring the automation's
// callback body to carry oracleInput/expectedQuestionHash/payoutEstimateBaseUnits — those are set
// once when the deal is registered, not duplicated into every automation payload. The callback body
// only needs to identify which deal fired; scheduleResolutionAutomation() already sends { dealId },
// which isn't otherwise used here but is left in the accepted shape for logging/future use.
//
// Live-verified end to end (auth, validation, real deployed URL, a real 1Claw Automation reaching
// this route) — see docs/DAY-ONE-FINDINGS.md §18. Not yet exercised with a real signer configured;
// EVM_PRIVATE_KEY is deliberately unset on the current deployment, ideally to be replaced with
// server/oneclaw-client's oneClawTypedDataSigner (now live-verified for payment signing, see §20 —
// though the on-chain relay calls below still need real transaction submission, a separate,
// not-yet-built Intents API integration).
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveDeal, imdPaymentSigner } from "@verdict/resolver";
import { generateClientToken } from "@verdict/imd-client";
import { getDealMetadata } from "@/lib/deals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ResolveWebhookBody {
  dealId?: string;
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
  void body; // only dealId today, kept for logging/future use — nothing to validate yet

  const deal = await getDealMetadata(address);
  if (!deal) {
    return Response.json({ error: `no deal registered for ${address}` }, { status: 404 });
  }
  if (!deal.oracleInput || !deal.expectedQuestionHash || !deal.payoutEstimateBaseUnits) {
    return Response.json({ error: `deal ${address} is missing oracleInput/expectedQuestionHash/payoutEstimateBaseUnits — it can be displayed but not resolved` }, { status: 400 });
  }

  const privateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) {
    return Response.json({ error: "EVM_PRIVATE_KEY is not configured" }, { status: 500 });
  }
  const account = privateKeyToAccount(privateKey);

  // site and server/resolver each install their own copy of viem (both 2.56.9 — no `file:`-based
  // symlinking or workspace hoisting between them, see .github/workflows/ci.yml's per-package `npm
  // install` steps). TypeScript treats the two installs as nominally distinct types even though
  // they're structurally identical at runtime, so a plain assignment fails to typecheck across this
  // package boundary. Same root cause class as base-mainnet-demo.ts's chain-typing cast; resolved the
  // same way, against resolveDeal's own declared parameter types rather than a re-imported viem type.
  const publicClient = createPublicClient({ transport: http(deal.rpcUrl) }) as unknown as Parameters<typeof resolveDeal>[1]["publicClient"];
  const walletClient = createWalletClient({ account, transport: http(deal.rpcUrl) }) as unknown as Parameters<typeof resolveDeal>[1]["walletClient"];

  try {
    const result = await resolveDeal(
      {
        escrow: { address: address as `0x${string}`, chainId: deal.chainId },
        oracleInput: deal.oracleInput,
        expectedQuestionHash: deal.expectedQuestionHash,
        payoutEstimateBaseUnits: BigInt(deal.payoutEstimateBaseUnits),
      },
      {
        imdToken: generateClientToken(),
        paymentSigner: imdPaymentSigner(account),
        approvalThresholdBaseUnits: deal.approvalThresholdBaseUnits ? BigInt(deal.approvalThresholdBaseUnits) : 0n,
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
