"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Button, Input, Label } from "@workspace/ui";
import { accountRequest, readAccountSession, navigateAccount } from "../auth.client";
export type AuthScreenMode = "login" | "signup" | "verify-email" | "forgot-password" | "reset-password";
const titles = { login: "Welcome back", signup: "Create your account", "verify-email": "Verify your email", "forgot-password": "Reset your password", "reset-password": "Choose a new password" };
export const AuthScreen = ({ mode }: Readonly<{ mode: AuthScreenMode }>): React.JSX.Element => {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [name, setName] = useState("");
  const [token, setToken] = useState(""); const [busy, setBusy] = useState(false); const [ready, setReady] = useState(false); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true; const value = new URLSearchParams(window.location.hash.slice(1)).get("token");
    void readAccountSession().then(() => { if (active) { if (value) { setToken(value); window.history.replaceState(null, "", window.location.pathname); } setReady(true); } }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Account service is unavailable."); });
    return () => { active = false; };
  }, []);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); if (!ready || busy) return; setBusy(true); setError(""); setMessage("");
    try {
      const body = mode === "login" ? { email, password } : mode === "signup" ? { email, password, displayName: name } : mode === "reset-password" ? { token, password } : mode === "verify-email" && token ? { token } : { email };
      const result = await accountRequest(mode === "verify-email" && !token ? "/resend-verification" : `/${mode}`, body);
      setPassword("");
      if (mode === "login") navigateAccount("/");
      else { setMessage(typeof result.message === "string" ? result.message : "Check your email for next steps."); if (mode === "verify-email" || mode === "reset-password") setToken(""); }
    } catch (cause: unknown) { setError(cause instanceof Error ? cause.message : "Account request failed."); } finally { setBusy(false); }
  };
  const emailVisible = mode !== "reset-password" && !(mode === "verify-email" && token);
  return <main className="auth-page"><section className="auth-card"><Link className="auth-brand" href="/">talecraft</Link><p className="forge-kicker">Your private story workspace</p><h1>{titles[mode]}</h1><p>{mode === "signup" ? "Verify your email and choose a unique password of at least 15 characters." : mode === "verify-email" ? "Confirm your email link, or request another verification message." : "Access your projects, delivery maps, and saved analysis."}</p>
    <form onSubmit={(event) => { void submit(event); }}>
      {mode === "signup" ? <Label>Display name<Input autoComplete="name" value={name} maxLength={80} required onChange={(event) => setName(event.target.value)} /></Label> : null}
      {emailVisible ? <Label>Email<Input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></Label> : null}
      {mode === "login" || mode === "signup" || mode === "reset-password" ? <Label>Password<Input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "login" ? 1 : 15} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /></Label> : null}
      {mode === "reset-password" && !token && !message ? <p role="alert">Open a valid reset link from your email before choosing a new password.</p> : null}
      <Button disabled={!ready || busy || (mode === "reset-password" && !token)} type="submit">{busy ? "Please wait…" : mode === "verify-email" ? token ? "Verify email" : "Send verification email" : mode === "forgot-password" ? "Send reset email" : mode === "reset-password" ? "Save new password" : mode === "signup" ? "Create account" : "Sign in"}</Button>
    </form>{error ? <p role="alert">{error}</p> : null}{message ? <p role="status">{message}</p> : null}{!ready && !error ? <p role="status">Connecting securely…</p> : null}
    <nav aria-label="Account navigation"><Link href="/login">Sign in</Link><Link href="/signup">Create account</Link><Link href="/forgot-password">Forgot password?</Link><Link href="/verify-email">Verify email</Link></nav>
  </section></main>;
};
