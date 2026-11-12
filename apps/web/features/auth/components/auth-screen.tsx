"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Button, Input, Label } from "@workspace/ui";
import { accountRequest, readAccountSession, navigateAccount } from "../auth.client";
export type AuthScreenMode = "login" | "signup";
const titles = { login: "Welcome back", signup: "Create your account" };
export const AuthScreen = ({ mode }: Readonly<{ mode: AuthScreenMode }>): React.JSX.Element => {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [name, setName] = useState("");
  const [busy, setBusy] = useState(false); const [ready, setReady] = useState(false); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void readAccountSession().then(() => { if (active) setReady(true); }).catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Account service is unavailable."); });
    return () => { active = false; };
  }, []);
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); if (!ready || busy) return; setBusy(true); setError(""); setMessage("");
    try {
      const body = mode === "login" ? { email, password } : { email, password, displayName: name };
      const result = await accountRequest(`/${mode}`, body);
      setPassword("");
      if (mode === "login") navigateAccount("/");
      else setMessage(typeof result.message === "string" ? result.message : "Signup processed. Sign in with your email and password.");
    } catch (cause: unknown) { setError(cause instanceof Error ? cause.message : "Account request failed."); } finally { setBusy(false); }
  };
  return <main className="auth-page"><section className="auth-card"><Link className="auth-brand" href="/">talecraft</Link><p className="forge-kicker">Your private story workspace</p><h1>{titles[mode]}</h1><p>{mode === "signup" ? "Choose a unique password of at least 15 characters. You can sign in immediately after signup." : "Access your projects, delivery maps, and saved analysis."}</p><p>Your email is an unverified sign-in identifier. Save your password securely: email recovery is unavailable.</p>
    <form onSubmit={(event) => { void submit(event); }}>
      {mode === "signup" ? <Label>Display name<Input autoComplete="name" value={name} maxLength={80} required onChange={(event) => setName(event.target.value)} /></Label> : null}
      <Label>Email<Input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></Label>
      <Label>Password<Input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "login" ? 1 : 15} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /></Label>
      <Button disabled={!ready || busy} type="submit">{busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}</Button>
    </form>{error ? <p role="alert">{error}</p> : null}{message ? <p role="status">{message}</p> : null}{!ready && !error ? <p role="status">Connecting securely…</p> : null}
    <nav aria-label="Account navigation"><Link href="/login">Sign in</Link><Link href="/signup">Create account</Link></nav>
  </section></main>;
};
