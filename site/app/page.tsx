import Link from "next/link";
import { DEALS } from "@/lib/deals";

export const dynamic = "force-dynamic";

export default function Home() {
  const deals = Object.entries(DEALS);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-24">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Verdict</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">Oracle-settled milestone escrows on IMD + 1Claw.</p>
      </div>

      {deals.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          No deals to show. Real deals don&apos;t exist yet — deployment is blocked on IMD&apos;s unconfirmed
          payment-signing schema (see <code className="font-mono">docs/DAY-ONE-FINDINGS.md</code>). Run{" "}
          <code className="font-mono">npm run deploy-demo</code> from <code className="font-mono">site/</code> to deploy
          and view a real local demo deal.
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {deals.map(([address, deal]) => (
            <li key={address}>
              <Link
                href={`/deals/${address}`}
                className="block rounded-xl border border-zinc-200 bg-white p-4 shadow-sm transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
              >
                <p className="font-medium text-zinc-900 dark:text-zinc-50">{deal.title}</p>
                <p className="mt-1 font-mono text-xs text-zinc-500 dark:text-zinc-400">{address}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
