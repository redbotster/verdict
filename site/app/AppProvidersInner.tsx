"use client";

import { OneclawWalletProvider } from "@1claw/wallet-react";
import { WalletSessionProvider } from "./WalletSessionContext";

const API_KEY = process.env.NEXT_PUBLIC_ONECLAW_PLATFORM_KEY;
const APP_ID = process.env.NEXT_PUBLIC_ONECLAW_PLATFORM_APP_ID;

export default function AppProvidersInner({ children }: { children: React.ReactNode }) {
  if (!API_KEY || !APP_ID) return <>{children}</>;

  return (
    // persistSession="local" keeps the signed-in session across page reloads, not just
    // client-side navigations — see WalletSessionContext.tsx for what this does and doesn't
    // cover for *identity* (the session token itself survives; our own cached user doesn't).
    <OneclawWalletProvider apiKey={API_KEY} appId={APP_ID} persistSession="local">
      <WalletSessionProvider>{children}</WalletSessionProvider>
    </OneclawWalletProvider>
  );
}
