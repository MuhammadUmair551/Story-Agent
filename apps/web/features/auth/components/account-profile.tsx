"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { Button, Input, Label } from "@workspace/ui";
import type { AccountUser } from "@workspace/types";
import { z } from "zod";
import { accountRequest, accountSchema, navigateAccount } from "../auth.client";
export const AccountProfile = ({ user }: Readonly<{ user: AccountUser }>): React.JSX.Element => {
  const [name, setName] = useState(user.displayName); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState(""); const [users, setUsers] = useState<AccountUser[]>([]); const [more, setMore] = useState(true);
  const [currentPassword, setCurrentPassword] = useState(""); const [newPassword, setNewPassword] = useState("");
  const act = async (work: () => Promise<void>): Promise<void> => { setBusy(true); setError(""); setMessage(""); try { await work(); } catch (cause: unknown) { setError(cause instanceof Error ? cause.message : "Account request failed."); } finally { setBusy(false); } };
  const save = (event: FormEvent): void => { event.preventDefault(); void act(async () => { await accountRequest("/profile", { displayName: name }, "PATCH"); setMessage("Profile saved."); }); };
  const changePassword = (event: FormEvent): void => { event.preventDefault(); void act(async () => { await accountRequest("/change-password", { currentPassword, newPassword }); setCurrentPassword(""); setNewPassword(""); navigateAccount("/login"); }); };
  return <main className="auth-page"><section className="auth-card"><Link className="auth-brand" href="/">talecraft</Link><h1>Your account</h1><p>{user.email} · {user.role}</p><p>Your email is an unverified sign-in identifier. Email recovery is unavailable.</p>
    <form onSubmit={save}><Label>Display name<Input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></Label><Button disabled={busy}>Save profile</Button></form>
    <h2>Change password</h2><p>Enter your current password. Changing it signs out every session.</p><form onSubmit={changePassword}><Label>Current password<Input type="password" autoComplete="current-password" required maxLength={128} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></Label><Label>New password<Input type="password" autoComplete="new-password" required minLength={15} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></Label><Button disabled={busy}>Change password</Button></form>
    <Button variant="outline" disabled={busy} onClick={() => { void act(async () => { await accountRequest("/logout-all"); navigateAccount("/login"); }); }}>Sign out all sessions</Button>
    <Button disabled={busy} onClick={() => { void act(async () => { await accountRequest("/logout"); navigateAccount("/login"); }); }}>Sign out</Button>
    {user.role === "admin" ? <section><h2>Admin account directory</h2><Button disabled={busy || !more} variant="outline" onClick={() => { void act(async () => { const result = z.object({ users: z.array(accountSchema), hasMore: z.boolean() }).parse(await accountRequest(`/admin/users?skip=${String(users.length)}`, undefined, "GET")); setUsers((current) => [...current, ...result.users]); setMore(result.hasMore); }); }}>{users.length ? "Load more accounts" : "View accounts"}</Button><ul>{users.map((item) => <li key={item.userId}>{item.displayName} · {item.email} · {item.role}</li>)}</ul>{!more ? <p>All accounts loaded.</p> : null}</section> : null}
    {error ? <p role="alert">{error}</p> : null}{message ? <p role="status">{message}</p> : null}<Link href="/">Return to Story Agent</Link>
  </section></main>;
};
