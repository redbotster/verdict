"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { EmbeddedWalletUser } from "@1claw/wallet-react";

// wallet-react has no `currentUser`/`getCurrentUser()` — EmbeddedWalletUser only ever surfaces
// via the widget's one-time onLogin callback (flagged to the 1Claw team; see
// docs/designs/multi-tenant-1claw-wallets.md). This caches it ourselves so pages other than
// /wallet (where the widget actually lives) can know who's signed in for the rest of the
// client-side session. Known limitation: a hard browser refresh loses this cache even though
// wallet-react's own persistSession="local" keeps the underlying JWT alive — there's no SDK
// hook to re-hydrate identity from that surviving session, only from a fresh onLogin/onLogout.
const STORAGE_KEY = "verdict:oneclaw-user";

const WalletSessionContext = createContext<{
  user: EmbeddedWalletUser | null;
  setUser: (user: EmbeddedWalletUser | null) => void;
} | null>(null);

export function WalletSessionProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<EmbeddedWalletUser | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setUserState(JSON.parse(raw));
    } catch {
      // private browsing / blocked storage — fine, just no cached identity
    }
  }, []);

  function setUser(next: EmbeddedWalletUser | null) {
    setUserState(next);
    try {
      if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // same as above — the in-memory state still works for this page load
    }
  }

  return <WalletSessionContext.Provider value={{ user, setUser }}>{children}</WalletSessionContext.Provider>;
}

export function useWalletSession() {
  const ctx = useContext(WalletSessionContext);
  if (!ctx) throw new Error("useWalletSession must be used within WalletSessionProvider");
  return ctx;
}
