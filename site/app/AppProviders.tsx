"use client";

import dynamic from "next/dynamic";

// ssr:false must be called from a Client Component in this Next.js version (confirmed while
// building app/wallet/ — see its WalletPageClient.tsx). Wrapping the whole app here means every
// page loses server-rendering while this provider is mounted — an accepted, real tradeoff
// (docs/designs/multi-tenant-1claw-wallets.md) for site-wide access to the signed-in wallet
// session, not an accident.
const AppProvidersInner = dynamic(() => import("./AppProvidersInner"), { ssr: false });

export default function AppProviders({ children }: { children: React.ReactNode }) {
  return <AppProvidersInner>{children}</AppProvidersInner>;
}
