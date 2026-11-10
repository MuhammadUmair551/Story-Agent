"use client";
import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import Link from "next/link";
import type { AccountUser } from "@workspace/types";
import { Button } from "@workspace/ui";
import { accountRequest, readAccountSession, navigateAccount } from "../auth.client";
const Context = createContext<AccountUser | null>(null);
export const AccountSession = ({ user, children }: Readonly<{ user: AccountUser; children: ReactNode }>): React.JSX.Element => {
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const verify = (): void => { void readAccountSession(true).then((session) => { if (session.user?.userId !== user.userId) navigateAccount("/login"); else setUnavailable(false); }).catch(() => { setUnavailable(true); }); };
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("story-account") : undefined;
    if (channel) channel.onmessage = verify;
    window.addEventListener("focus", verify);
    window.addEventListener("pageshow", verify);
    verify();
    return () => { window.removeEventListener("focus", verify); window.removeEventListener("pageshow", verify); channel?.close(); };
  }, [user.userId]);
  if (unavailable) return <main className="auth-page"><section className="auth-card" role="alert"><p>Your session could not be checked. Please refresh to continue.</p><Button onClick={() => { window.location.reload(); }}>Refresh</Button></section></main>;
  return <Context.Provider value={user}>{children}</Context.Provider>;
};
export const SessionControls = (): React.JSX.Element | null => {
  const user = useContext(Context);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  if (!user) return null;
  return <div className="auth-session"><Link href="/account">{user.displayName}</Link><Button variant="ghost" disabled={busy} onClick={() => { setBusy(true); setError(""); void accountRequest("/logout").then(() => { navigateAccount("/login"); }).catch(() => { setBusy(false); setError("Sign out failed. Please try again."); }); }}>{busy ? "Signing out…" : "Sign out"}</Button>{error ? <p role="alert">{error}</p> : null}</div>;
};
