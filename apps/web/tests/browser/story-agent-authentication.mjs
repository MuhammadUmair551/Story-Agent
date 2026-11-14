// Run with the isolated auth.browser-fixture API (4305/control 4306), production web (3105)
// and a dedicated Chromium/Edge debugging profile. Never points at a live account or database.
// node apps/web/tests/browser/story-agent-authentication.mjs http://127.0.0.1:3105 http://127.0.0.1:9337
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const web = new URL(process.argv[2] ?? ""); const debugging = new URL(process.argv[3] ?? "");
for (const url of [web, debugging]) assert.ok(url.protocol === "http:" && url.hostname === "127.0.0.1", "Use isolated loopback servers only.");
assert.equal(web.port, "3105", "Use the dedicated authentication browser fixture.");
const control = "http://127.0.0.1:4306";
const tab = await (await fetch(`${debugging.origin}/json/new?about:blank`, { method: "PUT" })).json();
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0, assertions = 0; const pending = new Map(), exceptions = [], requests = []; const requestPaths = new Map();
let pollingScenario;
let heldSelection;
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data); const callback = pending.get(message.id);
  if (callback) { pending.delete(message.id); if (message.error) callback.reject(new Error(JSON.stringify(message.error))); else callback.resolve(message.result); }
  if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text);
  if (message.method === "Network.requestWillBeSent") {
    const path = new URL(message.params.request.url).pathname;
    if (path.startsWith("/api/")) { const record = { path, method: message.params.request.method }; requests.push(record); requestPaths.set(message.params.requestId, record); }
  }
  if (message.method === "Network.responseReceived") { const record = requestPaths.get(message.params.requestId); if (record) record.status = message.params.response.status; }
  if (message.method === "Network.loadingFinished") { const record = requestPaths.get(message.params.requestId); if (record) record.completed = true; }
  if (message.method === "Fetch.requestPaused") {
    const requestId = message.params.requestId;
    if (heldSelection) { heldSelection.requestId = requestId; heldSelection.resolve(); return; }
    void (async () => {
      if (!pollingScenario) { await send("Fetch.continueRequest", { requestId }); return; }
      const scenario = pollingScenario; scenario.requests++;
      if (scenario.requests === 2) {
        // Span another polling tick to prove slow requests cannot overlap.
        await new Promise(resolve => setTimeout(resolve, 12000));
        await send("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" }); return;
      }
      const payload = scenario.requests === 1 ? scenario.queued : scenario.completed;
      await send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(payload)).toString("base64") });
    })().catch(() => exceptions.push("Isolated polling fixture failed"));
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result?.value; };
const waitFor = async (expression) => { const deadline = Date.now() + 60000; while (Date.now() < deadline) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timed out: ${expression}`); };
const click = async (text) => {
  const selector = `[...document.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`; await waitFor(`${selector} && !${selector}.disabled`);
  const point = await evaluate(`(() => { const button = ${selector}; button.scrollIntoView({block:'center'}); const rect=button.getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}; })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
};
const navigate = async (path, expected = path.split("#")[0]) => {
  const start = requests.length;
  await send("Page.navigate", { url: `${web.origin}${path}` }); await waitFor(`location.pathname === ${JSON.stringify(expected)} && document.readyState === 'complete'`);
  // Server-rendered controls precede hydration. Wait for the real client session bootstrap.
  const deadline = Date.now() + 60000;
  while (!requests.slice(start).some(item => item.path === "/api/auth/session" && item.status === 200)) {
    if (Date.now() > deadline) throw new Error(`Client session bootstrap timed out at ${expected}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
const input = async (selector, value) => {
  await evaluate(`(() => { const element = ${selector}; if (!element) throw new Error('Input missing'); element.focus(); element.select(); })()`);
  await send("Input.insertText", { text: value });
};
const fill = async (label, value) => await input(`[...document.querySelectorAll('label')].find(el => el.firstChild?.textContent.trim() === ${JSON.stringify(label)})?.querySelector('input,textarea')`, value);
const check = (condition, message) => { assertions++; assert.ok(condition, message); };
const state = async () => await (await fetch(`${control}/test/state`)).json();
const api = async (path, method = "GET", body) => await evaluate(`(async () => { const session = await (await fetch('/api/auth/session')).json(); const response = await fetch(${JSON.stringify(`/api${path}`)}, {method:${JSON.stringify(method)},headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},${body === undefined ? "" : `body:JSON.stringify(${JSON.stringify(body)}),`}});return {status:response.status,data:await response.json()}; })()`);
const password = "A browser journey unique password!";
let expiryChecked = false;
const signup = async (email, name) => {
  const expired = !expiryChecked;
  await navigate("/signup"); await waitFor("document.querySelector('.auth-card form button:not(:disabled)')"); await fill("Display name", name); await fill("Email", email); await fill("Password", password);
  if (!expiryChecked) { assert.equal((await (await fetch(`${control}/test/advance-time`)).json()).advanced, true); expiryChecked = true; }
  await click("Create account");
  await waitFor("document.querySelector('[role=status]')?.textContent.includes('Signup processed')"); check(true, "Signup gives an honest generic response without email delivery");
  if (expired) check(true, "An open signup form refreshes its expired anonymous cookie and CSRF state");
  check(await evaluate("![...document.querySelectorAll('.auth-card a')].some(el => /verify-email|forgot-password|reset-password/.test(el.pathname))"), "No removed recovery or verification links");
};
const login = async (email, secret = password) => { await navigate("/login"); await waitFor("document.querySelector('.auth-card form button:not(:disabled)')"); await fill("Email", email); await fill("Password", secret); await click("Sign in"); };

try {
  await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable"); await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await navigate("/", "/login"); check(true, "Anonymous workspace is redirected to login");
  check((await api("/story-agent/runs")).status === 401, "Anonymous API access denied");
  await signup("alice@example.test", "Alice");
  await login("alice@example.test", "Incorrect password for the journey!");
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('invalid')"); check(true, "Invalid credentials remain on the login form");
  await fill("Password", password); await click("Sign in"); await waitFor("location.pathname === '/' && document.querySelector('.story-forge')");
  check(await evaluate("document.querySelector('.auth-session').innerText.includes('Alice')"), "Signed-in identity replaces the placeholder");
  check(await evaluate("!document.cookie.includes('story_session') && localStorage.length === 0 && sessionStorage.length === 0"), "Session is HttpOnly and absent from browser token storage");
  const cookies = (await send("Network.getCookies", { urls: [web.origin] })).cookies;
  check(cookies.some(cookie => cookie.name === "story_session" && cookie.httpOnly && cookie.sameSite === "Lax"), "Actual browser session cookie attributes verified");
  check(await evaluate("(async () => (await fetch('/api/auth/profile', {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({displayName:'Forged'})})).status === 403)()"), "Browser write without a CSRF token is rejected");
  await evaluate("document.querySelector('.forge-project summary').click()"); await fill("Project name", "Alice private project"); await click("Create project");
  await waitFor("[...document.querySelectorAll('button')].some(el => el.textContent.trim() === 'Save rules')");
  await click("Add glossary term"); await fill("Term", "Reader"); await fill("Definition", "A person resuming a chapter"); await fill("Aliases (comma separated)", "Bookworm"); await click("Save rules");
  await waitFor("document.body.innerText.includes('Project rules saved.')");
  await input("document.querySelector('.forge-prompt textarea')", "Readers resume chapters from saved progress."); await click("Shape it");
  await waitFor("document.querySelector('.delivery-initiative') && document.querySelector('.forge-quality')");
  const saved = await state(); const run = saved.runs[0]; const project = saved.projects[0];
  check(Boolean(run.ownerId && project.ownerId === run.ownerId), "Projects and generations receive the server owner");
  check(Boolean(run.plan.initiative.epics[0].features[0].stories[0].tasks.length), "Complete five-level hierarchy generated through authenticated proxy");
  check(run.projectRules.glossary[0].aliases[0] === "Bookworm", "Project glossary snapshot preserved");
  await click("Review backlog"); await waitFor("document.querySelector('.forge-intelligence > details')");
  check((await state()).runs[0].analyses[0].coverage !== undefined, "Evidence review persists coverage through authenticated API");
  await fill("Updated requirement", "Readers resume chapters from saved progress while offline."); await click("Analyze requirement change");
  await waitFor("document.querySelectorAll('.forge-intelligence > details').length === 2");
  check((await state()).runs[0].analyses[1].kind === "impact", "Requirement Impact Analysis retained");
  await click("Propose refinement"); await waitFor("document.querySelector('.forge-proposal')"); await click("Accept proposal");
  await waitFor("document.querySelector('.delivery-initiative h3')?.textContent.includes('clarified')"); check(true, "Refinement proposal and acceptance retained");
  await click("New story");
  check(await evaluate("!document.querySelector('.forge-quality') && !document.querySelector('.forge-results')"), "Starting a new run clears the prior plan, quality and refinement state");
  assert.equal((await (await fetch(`${control}/test/fail-next-generation`)).json()).configured, true);
  await input("document.querySelector('.forge-prompt textarea')", "Deliberate generation failure fixture"); await click("Shape it");
  await waitFor("document.querySelector('.forge-results .forge-kicker')?.textContent === 'Needs repair' && document.querySelector('.forge-generation-feedback')");
  const failedRun = (await state()).runs.find(item => item.status === "failed"); assert.ok(failedRun);
  check(await evaluate(`!document.querySelector('.forge-quality') && !document.querySelector('.delivery-initiative') && document.querySelector('.forge-generation-feedback').innerText.includes(${JSON.stringify(failedRun.runId)})`), "A failed HTTP generation retains its persisted run ID and shows diagnostics without draft quality");
  const failedDetail = (await api(`/story-agent/runs/${failedRun.runId}`)).data.run;
  check(failedDetail.quality.status === "not_evaluated" && failedDetail.diagnostic.category === "missing_required_field" && !failedDetail.plan, "Failed saved generation has accurate quality and field diagnostics");
  await evaluate("[...document.querySelectorAll('.forge-nav__content button')].find(el => el.textContent.includes('Story vault')).click()");
  await waitFor("[...document.querySelectorAll('.forge-history-entry__open')].some(el => el.textContent.includes('Deliberate generation failure fixture'))");
  await evaluate("[...document.querySelectorAll('.forge-history-entry__open')].find(el => el.textContent.includes('Deliberate generation failure fixture')).click()");
  await waitFor("document.querySelector('.forge-results .forge-kicker')?.textContent === 'Needs repair'");
  check(await evaluate("document.querySelector('.forge-generation-feedback') && !document.querySelector('.forge-quality')"), "A persisted failed attempt reopens with diagnostics and no refinement controls");
  assert.equal((await api(`/story-agent/runs/${failedRun.runId}`, "DELETE")).status, 200);
  await navigate("/");
  const selectedDetail = (await api(`/story-agent/runs/${run.runId}`)).data;
  await evaluate("[...document.querySelectorAll('.forge-nav__content button')].find(el => el.textContent.includes('Story vault')).click()");
  await waitFor("document.querySelector('.forge-history-entry__open')");
  const selectionPaused = new Promise(resolve => { heldSelection = { resolve }; });
  const selectionStart = requests.length;
  await send("Fetch.enable", { patterns: [{ urlPattern: `${web.origin}/api/story-agent/runs/${run.runId}`, requestStage: "Request" }] });
  await evaluate("document.querySelector('.forge-history-entry__open').click()"); await selectionPaused;
  await click("New story");
  const staleRequestId = heldSelection.requestId; heldSelection = undefined;
  await send("Fetch.fulfillRequest", { requestId: staleRequestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/json" }], body: Buffer.from(JSON.stringify(selectedDetail)).toString("base64") });
  await send("Fetch.disable");
  const selectionDeadline = Date.now() + 60000;
  while (!requests.slice(selectionStart).some(item => item.path === `/api/story-agent/runs/${run.runId}` && item.status === 200 && item.completed)) {
    assert.ok(Date.now() < selectionDeadline, "The delayed saved-entry response must finish before checking stale state");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  check(await evaluate("!document.querySelector('.forge-results') && !document.querySelector('.forge-quality')"), "A late saved-entry response cannot restore stale quality after New story");
  await navigate("/account"); await fill("Display name", "Alice Updated"); await click("Save profile");
  await waitFor("document.querySelector('[role=status]')?.textContent.includes('Profile saved')");
  await navigate("/"); check(await evaluate("document.querySelector('.auth-session').innerText.includes('Alice Updated')"), "Profile persists after navigation");
  check((await api("/auth/admin/users")).status === 403, "Ordinary account cannot access admin directory");
  await click("Sign out"); await waitFor("location.pathname === '/login'");
  await navigate("/account", "/login"); check(true, "Protected account screen denies a logged-out session");
  await signup("bob@example.test", "Bob"); await login("bob@example.test"); await waitFor("location.pathname === '/' && document.querySelector('.story-forge')");
  check((await api("/story-agent/runs")).data.runs.length === 0, "History isolated between accounts");
  check((await api("/story-agent/projects")).data.projects.length === 0, "Projects isolated between accounts");
  check((await api(`/story-agent/runs/${run.runId}`)).status === 404, "Cross-user IDOR read rejected");
  check((await api(`/story-agent/runs/${run.runId}`, "DELETE")).status === 404, "Cross-user IDOR deletion rejected");
  check((await api("/auth/profile", "PATCH", { displayName: "Bob", role: "admin" })).status === 400, "Frontend role escalation rejected");
  await click("Sign out"); await waitFor("location.pathname === '/login'");
  await login("alice@example.test"); await waitFor("location.pathname === '/' && document.querySelector('.story-forge')");
  await navigate("/account");
  await fill("Current password", "Incorrect sufficiently long current password!");
  const replacement = "Another browser journey unique password!"; await fill("New password", replacement); await click("Change password");
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('Current password is invalid')");
  check((await api("/story-agent/runs")).status === 200, "Wrong current password leaves the session and account intact");
  await fill("Current password", password); await click("Change password"); await waitFor("location.pathname === '/login'");
  check((await api("/story-agent/runs")).status === 401, "Password change signs out the current session");
  for (const path of ["verify-email", "resend-verification", "forgot-password", "reset-password"]) check((await api("/auth/" + path, "POST", {})).status === 404, "Removed email API returns 404: " + path);
  for (const path of ["verify-email", "forgot-password", "reset-password"]) check(await evaluate("(async()=> (await fetch('/" + path + "')).status === 404)()"), "Removed email screen returns 404: " + path);
  await login("alice@example.test"); await waitFor("document.querySelector('[role=alert]')?.textContent.includes('invalid')"); check(true, "Old password rejected after change");
  await fill("Password", replacement); await click("Sign in"); await waitFor("location.pathname === '/' && document.querySelector('.story-forge')");
  check((await api("/story-agent/runs")).data.runs.length === 1, "Account history survives password change");
  // Complete the post-login router refresh and client bootstrap before interacting
  // with the vault; server-rendered controls can precede the new client instance.
  await navigate("/");
  await evaluate("[...document.querySelectorAll('.forge-nav__content button')].find(el => el.textContent.includes('Story vault')).click()");
  await waitFor("document.querySelector('.forge-history-entry__delete')");
  const completed = (await api(`/story-agent/runs/${run.runId}`)).data;
  pollingScenario = { requests: 0, completed, queued: { ...completed, run: { ...completed.run, status: "queued", lockedUntil: new Date(Date.now() + 300000).toISOString() }, draft: null } };
  await send("Fetch.enable", { patterns: [{ urlPattern: `${web.origin}/api/story-agent/runs/${run.runId}`, requestStage: "Request" }] });
  await evaluate("document.querySelector('.forge-history-entry__open').click()");
  await waitFor("document.querySelector('.forge-results .forge-kicker')?.textContent === 'In progress'");
  check(true, "A leased saved run displays its actual processing state");
  await waitFor("document.querySelector('.forge-feedback')?.textContent.includes('Status updates are unavailable')");
  check(pollingScenario.requests === 2, "A slow polling request does not overlap another polling tick");
  check(await evaluate("document.querySelector('.forge-results .forge-kicker')?.textContent === 'In progress'"), "Polling failure preserves the saved run and exposes retry feedback");
  await waitFor("document.querySelector('.forge-results .forge-kicker')?.textContent === 'Ready' && document.querySelector('.delivery-initiative')");
  check(pollingScenario.requests === 3 && await evaluate("!document.querySelector('.forge-feedback')?.textContent.includes('Status updates are unavailable')"), "Polling retries successfully, displays the hierarchy and clears outage feedback");
  await send("Fetch.disable"); pollingScenario = undefined;
  await evaluate("[...document.querySelectorAll('.forge-nav__content button')].find(el => el.textContent.includes('Story vault')).click()");
  await waitFor("document.querySelector('.forge-history-entry__delete')");
  await evaluate("document.querySelector('.forge-history-entry__delete').click()"); await waitFor("document.querySelector('[role=alertdialog]')");
  await click("Cancel"); await waitFor("!document.querySelector('[role=alertdialog]')");
  check((await api("/story-agent/runs")).data.runs.length === 1, "Cancel preserves the history record");
  await evaluate("document.querySelector('.forge-history-entry__delete').click()"); await click("Delete entry");
  await waitFor("!document.querySelector('.forge-history-entry') && !document.querySelector('[role=alertdialog]')");
  check((await api(`/story-agent/runs/${run.runId}`)).status === 404, "Owner deletes an individual record through the vault confirmation");
  check((await api("/story-agent/runs")).data.runs.length === 0, "Deletion persists in the owner's vault");
  for (const width of [1440, 390]) {
    await navigate("/account"); await send("Emulation.setDeviceMetricsOverride", { width, height: 1100, deviceScaleFactor: 1, mobile: width < 700 });
    check(!(await evaluate("document.documentElement.scrollWidth > innerWidth")), `Account layout fits ${width}px`);
    await writeFile(`.repo-cache/phase5-no-mail-account-${width}.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  }
  await click("Sign out all sessions"); await waitFor("location.pathname === '/login'");
  check((await api("/story-agent/runs")).status === 401, "Sign out all sessions invalidates browser access");
  check(exceptions.length === 0, "No browser JavaScript exceptions");
  console.log(`PASS: ${assertions} browser assertions covering immediate signup, login, password change, removed email routes, logout, cookies, ownership, projects, generation, polling outage/recovery, review, impact, refinement and responsive layouts.`);
} catch (error) {
  await writeFile(".repo-cache/phase5-no-mail-browser-failure.json", JSON.stringify({ pathname: await evaluate("location.pathname"), text: await evaluate("document.body.innerText"), exceptions, requests }, null, 2));
  await writeFile(".repo-cache/phase5-no-mail-browser-failure.png", Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  throw error;
} finally { await send("Page.close").catch(() => undefined); socket.close(); }
