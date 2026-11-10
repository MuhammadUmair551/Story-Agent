import { AccountProfile, AccountSession } from "@/features/auth";
import { requireAccount } from "@/features/auth/auth.server";
export default async function AccountPage(): Promise<React.JSX.Element> { const user = await requireAccount(); return <AccountSession user={user}><AccountProfile user={user} /></AccountSession>; }
