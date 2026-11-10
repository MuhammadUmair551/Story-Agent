export type AccountRole = "user" | "admin";
export type AccountUser = Readonly<{ userId: string; email: string; displayName: string; role: AccountRole }>;
export type AccountSession = Readonly<{ user: AccountUser | null; csrfToken: string }>;
