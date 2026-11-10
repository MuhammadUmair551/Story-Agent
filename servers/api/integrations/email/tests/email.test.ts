import test from "node:test";
import assert from "node:assert/strict";
import { createEmailSender } from "../index.js";

void test("email adapter uses a fixed endpoint, idempotency, bounded delivery and sanitized errors", async () => {
  const message = { id: "mail-id", to: "reader@example.test", subject: "Verify", text: "A single-use link" };
  let request: Request | undefined;
  const send = createEmailSender({ apiKey: "fixture-only", from: "sender@example.test", fetcher: (input, init) => { request = new Request(input, init); return Promise.resolve(Response.json({ id: "delivered" })); } });
  await send(message); assert.ok(request);
  assert.equal(request.url, "https://api.resend.com/emails"); assert.equal(request.method, "POST");
  assert.equal(request.headers.get("Idempotency-Key"), message.id); assert.ok(request.signal);
  assert.deepEqual(await request.json(), { from: "sender@example.test", to: [message.to], subject: message.subject, text: message.text });
  const failing = createEmailSender({ apiKey: "fixture-only", from: "sender@example.test", fetcher: () => Promise.resolve(new Response("private upstream detail", { status: 429 })) });
  await assert.rejects(failing(message), { message: "Authentication email delivery failed." });
});
