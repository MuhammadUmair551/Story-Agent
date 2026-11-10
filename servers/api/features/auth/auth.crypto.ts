import { randomBytes, scrypt, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from "node:crypto";

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
export const encryptMail = (text: string, key: string): string => {
  const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64"), nonce);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64url")).join(".");
};
export const decryptMail = (text: string, key: string): string => {
  const [nonce, tag, data] = text.split(".");
  if (!nonce || !tag || !data) throw new Error("Invalid encrypted email.");
  const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "base64"), Buffer.from(nonce, "base64url"));
  cipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([cipher.update(Buffer.from(data, "base64url")), cipher.final()]).toString("utf8");
};
