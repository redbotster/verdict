"use client";

import { OneclawWalletProvider } from "@1claw/wallet-react";

const API_KEY = process.env.NEXT_PUBLIC_ONECLAW_PLATFORM_KEY;
const APP_ID = process.env.NEXT_PUBLIC_ONECLAW_PLATFORM_APP_ID;

export default function AppProvidersInner({ children }: { children: React.ReactNode }) {
  if (!API_KEY || !APP_ID) return <>{children}</>;

  // persistSession="local" keeps the session token across reloads; as of @1claw/wallet-react
  // 0.7.0, useOneclawWallet().currentUser rehydrates from a real /v1/auth/me call on mount, so
  // no app-level identity cache is needed on top of this anymore (see git history for the
  // hand-rolled WalletSessionContext this replaced).
  return (
    <OneclawWalletProvider apiKey={API_KEY} appId={APP_ID} persistSession="local">
      {children}
    </OneclawWalletProvider>
  );
}
