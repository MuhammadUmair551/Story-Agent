// Loopback-only browser fixture: real authentication, isolated memory persistence and fake providers.
import { createServer } from "node:http";
import { authFixture } from "./auth.fixture.js";

if (process.env.NODE_ENV !== "test") throw new Error("Browser fixtures require NODE_ENV=test.");
const fixture = await authFixture(false, ["http://127.0.0.1:3105"], 4305);
const control = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1:4306");
    response.setHeader("Content-Type", "application/json"); response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    if (url.pathname === "/test/advance-time") {
      fixture.advance(31 * 60_000); response.end(JSON.stringify({ advanced: true })); return;
    }
    if (url.pathname === "/test/fail-next-generation") {
      fixture.failNextGeneration(); response.end(JSON.stringify({ configured: true })); return;
    }
    if (url.pathname === "/test/state") {
      response.end(JSON.stringify({ runs: await fixture.memory.db.getCollection("story_agent_runs").find({}), projects: await fixture.memory.db.getCollection("story_agent_projects").find({}) })); return;
    }
    response.writeHead(404).end();
  })().catch(() => { response.writeHead(500).end(JSON.stringify({ error: "Fixture request failed." })); });
});
control.listen(4306, "127.0.0.1", () => { console.log("Isolated authentication browser API ready on 4305; fixture control on 4306."); });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { control.close(); void fixture.close(); });
