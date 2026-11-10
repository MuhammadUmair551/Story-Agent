import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";

export const randomToken = (): string => randomBytes(32).toString("base64url");
export const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");
export const equalSecret = (left: string, right: string): boolean => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const derive = (password: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password.normalize("NFC"), salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, key) => { if (error) reject(error); else resolve(key); });
});
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16).toString("hex");
  return `scrypt-v1$${salt}$${(await derive(password, salt)).toString("hex")}`;
};
export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const [version, salt, expected] = stored.split("$");
  if (version !== "scrypt-v1" || !salt || !expected || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(expected)) return false;
  return equalSecret((await derive(password, salt)).toString("hex"), expected);
};
