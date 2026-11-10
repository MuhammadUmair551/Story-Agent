import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { StoryForge } from "../../features/story-agent";
import { AccountSession } from "../../features/auth";

test("composes the authenticated account session and same-origin API into the full-page story forge", () => {
  const markup = renderToStaticMarkup(<AccountSession user={{ userId: "account", email: "reader@example.test", displayName: "Signed-in reader", role: "user" }}><StoryForge apiBaseUrl="/api" /></AccountSession>);
  assert.match(markup, /What will your/);
  assert.match(markup, /next chapter/);
  assert.match(markup, /Signed-in reader/);
  assert.match(markup, /Sign out/);
});
