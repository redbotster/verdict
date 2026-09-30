"use client";

import dynamic from "next/dynamic";

// ssr:false must be called from a Client Component in this Next.js version — moving this
// out to the server page.tsx silently breaks the client-only code-splitting it depends on.
const WalletWidget = dynamic(() => import("./WalletWidget"), { ssr: false });

export default function WalletPageClient() {
  return <WalletWidget />;
}
