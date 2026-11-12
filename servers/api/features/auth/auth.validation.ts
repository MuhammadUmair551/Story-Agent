import { z } from "zod";
import type { ValidatedApiEnvironment } from "../../types/index.js";
export const emailSchema = z.string().trim().max(254).transform((value) => value.normalize("NFKC").toLowerCase()).pipe(z.email());
export const passwordSchema = z.string().transform((value) => value.normalize("NFC")).pipe(z.string().min(15, "Use at least 15 characters.").max(128).refine((value) => !["passwordpassword", "123456789012345", "qwertyuiopasdfgh", "letmeinletmeinletmein"].includes(value.toLowerCase()), "Choose a less predictable password."));
export const signupSchema = z.object({ email: emailSchema, password: passwordSchema, displayName: z.string().trim().min(1).max(80) }).strict();
export const loginSchema = z.object({ email: emailSchema, password: z.string().transform((value) => value.normalize("NFC")).pipe(z.string().min(1).max(128)) }).strict();
export const changePasswordSchema = z.object({ currentPassword: loginSchema.shape.password, newPassword: passwordSchema }).strict();
export const profileInputSchema = z.object({ displayName: z.string().trim().min(1).max(80) }).strict();
export const readAuthConfiguration = (environment: ValidatedApiEnvironment) => {
  const parsed = z.object({ publicOrigin: z.url() }).parse({ publicOrigin: environment.AUTH_PUBLIC_ORIGIN });
  const url = new URL(parsed.publicOrigin);
  if (url.origin !== parsed.publicOrigin || !environment.WEB_ORIGIN.split(",").includes(url.origin) || (url.protocol !== "https:" && !(environment.NODE_ENV !== "production" && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))) throw new Error("Authentication public origin must be an allowed secure web origin.");
  return { ...parsed, secure: environment.NODE_ENV === "production" };
};
