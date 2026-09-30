"use client";

import { OneclawWalletProvider, OneclawEmbeddedWallet } from "@1claw/wallet-react";

// Client-safe key by design — 1Claw's plt_ platform key is a publishable identifier,
// distinct from the org-level 1ck_ key (never exposed client-side, see .env.example).
const API_KEY = process.env.NEXT_PUBLIC_ONECLAW_PLATFORM_KEY;
const APP_ID = process.env.NEXT_PUBLIC_ONECLAW_PLATFORM_APP_ID;

export default function WalletWidget() {
  if (!API_KEY || !APP_ID) {
    return (
      <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
        Set <code className="font-mono">NEXT_PUBLIC_ONECLAW_PLATFORM_KEY</code> and{" "}
        <code className="font-mono">NEXT_PUBLIC_ONECLAW_PLATFORM_APP_ID</code> to enable the embedded wallet. See{" "}
        <code className="font-mono">docs/designs/multi-tenant-1claw-wallets.md</code>.
      </div>
    );
  }

  return (
    <OneclawWalletProvider apiKey={API_KEY} appId={APP_ID}>
      <OneclawEmbeddedWallet
        appId={APP_ID}
        chains={["ethereum"]}
        features={{ send: true, swap: true, receive: true, buy: true }}
        socialProviders={["google"]}
        theme="auto"
        onError={(err) => console.error("wallet error", err)}
      />
    </OneclawWalletProvider>
  );
}
