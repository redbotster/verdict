import { formatUnits } from "viem";
import { getDealMetadata, isAddress } from "@/lib/deals";
import { readEscrowOnChainState, type EscrowOnChainState } from "@/lib/escrow";

export const dynamic = "force-dynamic"; // deal state changes on-chain; never serve a stale cached page

type PageProps = { params: Promise<{ address: string }> };

function formatAmount(raw: bigint, decimals: number, symbol: string): string {
  return `${formatUnits(raw, decimals)} ${symbol}`;
}

function formatTimestamp(seconds: bigint): string {
  if (seconds === 0n) return "—";
  return new Date(Number(seconds) * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function StatusBadge({ state }: { state: EscrowOnChainState["state"] }) {
  const styles: Record<EscrowOnChainState["state"], string> = {
    Funded: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-300",
    Released: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-300",
    Refunded: "bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-300",
  };
  return <span className={`inline-block rounded-full px-3 py-1 text-sm font-medium ${styles[state]}`}>{state}</span>;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-zinc-100 py-2 text-sm last:border-0 dark:border-zinc-800">
      <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="text-right font-medium text-zinc-900 dark:text-zinc-100">{value}</span>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{title}</h2>
      {children}
    </div>
  );
}

export default async function DealPage({ params }: PageProps) {
  const { address } = await params;

  if (!isAddress(address)) {
    return <ErrorState message={`"${address}" isn't a valid Ethereum address.`} />;
  }

  const metadata = await getDealMetadata(address);
  if (!metadata) {
    return <ErrorState message={`No deal metadata found for ${address}. Run \`npm run deploy-demo\` from site/ for a local demo deal, or register a real one in Supabase.`} />;
  }

  let state: EscrowOnChainState;
  try {
    state = await readEscrowOnChainState(metadata.rpcUrl, address);
  } catch (err) {
    return (
      <ErrorState
        message={`Couldn't read on-chain state from ${metadata.rpcUrl}. If this is the local demo deal, its Anvil chain has probably been killed since it was deployed — run \`npm run deploy-demo\` again.`}
        detail={err instanceof Error ? err.message : String(err)}
      />
    );
  }

  const challengeEndsAt = state.trueAt > 0n ? state.trueAt + state.challengeWindow : null;
  const reclaimableAt = state.deadline + state.grace;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-16">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{metadata.title}</h1>
          <p className="mt-1 font-mono text-xs text-zinc-500 dark:text-zinc-400">{address}</p>
        </div>
        <StatusBadge state={state.state} />
      </div>

      <Card title="Question">
        <p className="text-sm leading-relaxed text-zinc-800 dark:text-zinc-200">{metadata.question}</p>
        <Row label="Panel / quorum" value={`${metadata.panelSize} / ${metadata.quorum}`} />
        <Row label="Question hash" value={<span className="font-mono text-xs">{shortAddress(state.questionHash)}</span>} />
        <div className="mt-2">
          <p className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">Sources</p>
          <ul className="list-inside list-disc text-sm text-zinc-700 dark:text-zinc-300">
            {metadata.sources.map((s) => (
              <li key={s}>
                <a href={s} className="underline decoration-zinc-300 hover:decoration-zinc-600" target="_blank" rel="noreferrer">
                  {s}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </Card>

      <Card title="Deal terms">
        <Row label="Payer" value={<span className="font-mono text-xs">{shortAddress(state.payer)}</span>} />
        <Row label="Payee" value={<span className="font-mono text-xs">{shortAddress(state.payee)}</span>} />
        <Row label="Amount" value={formatAmount(state.amount, state.tokenDecimals, state.tokenSymbol)} />
        <Row label="Fee" value={`${(state.feeBps / 100).toFixed(2)}% to ${shortAddress(state.feeRecipient)}`} />
        <Row label="Deadline" value={formatTimestamp(state.deadline)} />
        <Row label="Grace period ends" value={formatTimestamp(reclaimableAt)} />
        <Row label="Oracle signer" value={<span className="font-mono text-xs">{shortAddress(state.oracleSigner)}</span>} />
      </Card>

      <Card title="Status">
        <Row label="Escrow balance" value={formatAmount(state.escrowBalance, state.tokenDecimals, state.tokenSymbol)} />
        {state.trueAt > 0n && (
          <>
            <Row label="True answer received at" value={formatTimestamp(state.trueAt)} />
            <Row label="Challenge window ends" value={challengeEndsAt ? formatTimestamp(challengeEndsAt) : "—"} />
          </>
        )}
        {state.owedToPayer > 0n && <Row label="Owed to payer, unwithdrawn" value={formatAmount(state.owedToPayer, state.tokenDecimals, state.tokenSymbol)} />}
        {state.owedToPayee > 0n && <Row label="Owed to payee, unwithdrawn" value={formatAmount(state.owedToPayee, state.tokenDecimals, state.tokenSymbol)} />}
        {state.owedToFeeRecipient > 0n && <Row label="Owed to fee recipient, unwithdrawn" value={formatAmount(state.owedToFeeRecipient, state.tokenDecimals, state.tokenSymbol)} />}
      </Card>

      <p className="text-center text-xs text-zinc-400 dark:text-zinc-600">
        Read-only. Submitting an attestation, releasing, or withdrawing happens through the resolver agent or directly on-chain — not from this page.
      </p>
    </div>
  );
}

function ErrorState({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-6 py-24 text-center">
      <p className="text-lg font-medium text-zinc-900 dark:text-zinc-50">Can&apos;t show this deal</p>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{message}</p>
      {detail && <p className="mt-2 rounded bg-zinc-100 p-3 text-left font-mono text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">{detail}</p>}
    </div>
  );
}
