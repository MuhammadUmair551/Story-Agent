export type AuthEmail = Readonly<{ to: string; subject: string; text: string; id: string }>;
export type EmailSender = (message: AuthEmail) => Promise<void>;
export const createEmailSender = ({ apiKey, from, fetcher = fetch }: Readonly<{ apiKey: string; from: string; fetcher?: typeof fetch }>): EmailSender => async (message) => {
  const response = await fetcher("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": message.id },
    body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text }), signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error("Authentication email delivery failed.");
};
