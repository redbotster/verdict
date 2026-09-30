import WalletPageClient from "./WalletPageClient";

export const metadata = { title: "Wallet — Verdict" };

export default function WalletPage() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-16">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Your wallet</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Sign in to get a real, HSM-backed embedded wallet via 1Claw — no seed phrase. Fund it with the built-in swap or
          buy flow, then use it to fund and settle deals directly, instead of a shared ops wallet. See{" "}
          <code className="font-mono">docs/designs/multi-tenant-1claw-wallets.md</code>.
        </p>
      </div>
      <WalletPageClient />
    </div>
  );
}
