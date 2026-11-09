// Start the isolated evidence.browser-fixture API on 4214 and a web build targeting it on 3114.
// Run: node apps/web/tests/browser/story-agent-evidence.mjs http://127.0.0.1:3114 http://127.0.0.1:9334
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const preview = new URL(process.argv[2] ?? ""); const debugging = new URL(process.argv[3] ?? "");
for (const url of [preview, debugging]) assert.ok(url.protocol === "http:" && url.hostname === "127.0.0.1", "Use isolated loopback test servers only.");
const api = "http://127.0.0.1:4214";
const tab = await (await fetch(`${debugging.origin}/json/new?about:blank`, { method: "PUT" })).json();
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0, assertions = 0; const pending = new Map(), exceptions = [];
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data); const callback = pending.get(message.id);
  if (callback) { pending.delete(message.id); if (message.error) callback.reject(new Error(JSON.stringify(message.error))); else callback.resolve(message.result); }
  if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result?.value; };
const waitFor = async (expression) => { const deadline = Date.now() + 90000; while (Date.now() < deadline) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timed out: ${expression}`); };
const click = async (text, scope = "document") => { const expression = `[...${scope}.querySelectorAll('button')].find(el => el.textContent.trim() === ${JSON.stringify(text)})`; await waitFor(`${expression} && !${expression}.matches(':disabled')`); await evaluate(`${expression}.click()`); };
const report = "document.querySelector('.forge-intelligence > details')";
const firstCard = `${report}.querySelector('article')`;
const openReport = async () => {
  const count = (await state()).analyses?.length ?? 0;
  await waitFor(`document.querySelectorAll('.forge-intelligence > details').length === ${String(count)}`);
  await waitFor("[...document.querySelectorAll('.forge-quality > button')].find(el => el.textContent==='Reload saved entry')?.matches(':enabled')");
  await evaluate(`${report}.open=true`);
};
const state = async () => (await (await fetch(`${api}/test/state`)).json()).source;
const updateProvider = async (unavailable, partial = false) => { const response = await fetch(`${api}/test/provider`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unavailable, partial }) }); assert.equal(response.status, 200); };
const waitState = async (predicate) => { const deadline = Date.now() + 30000; while (Date.now() < deadline) { const value = await state(); if (predicate(value)) return value; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("API state did not settle"); };
const check = (condition, message) => { assertions++; assert.ok(condition, message); };
const choose = async (label, value) => {
  await evaluate(`${report}.querySelector('[aria-label="${label}"]').click()`);
  await waitFor("document.querySelector('[role=option]')");
  await evaluate(`[...document.querySelectorAll('[role=option]')].find(el => el.textContent.trim() === ${JSON.stringify(value)}).click()`);
};
const fillReason = async (value) => {
  await evaluate(`(() => { const input=${firstCard}.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true})); })()`);
};
const latestStatus = () => state().then((value) => value.analyses.at(-1).findings[0].review.status);

try {
  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: preview.href });
  await waitFor("[...document.querySelectorAll('.forge-nav__content button')].some(el => /Story vault\\s+[1-9]/.test(el.textContent))");
  await evaluate("[...document.querySelectorAll('.forge-nav__content button')].find(el => el.textContent.includes('Story vault')).click()");
  await waitFor("[...document.querySelectorAll('.forge-history-entry__open')].some(el => el.textContent.includes('Phase 4 evidence source'))");
  await evaluate("[...document.querySelectorAll('.forge-history-entry__open')].find(el => el.textContent.includes('Phase 4 evidence source')).click()");
  await click("Choose saved comparison entries");
  await waitFor("document.querySelectorAll('.forge-comparisons [role=checkbox]').length === 100");
  check(await evaluate("!document.querySelector('.forge-comparisons').textContent.includes('Unrelated project')"), "Comparison page excludes other projects");
  await click("Load more comparison entries");
  await waitFor("document.querySelectorAll('.forge-comparisons [role=checkbox]').length === 105");
  check(await evaluate("document.querySelector('.forge-comparisons').textContent.includes('Historical reading comparison 104')"), "Older-than-100 entry is reachable");
  await evaluate("[...document.querySelectorAll('.forge-comparisons [role=checkbox]')].find(el => el.getAttribute('aria-label').includes('(comparison-104)')).click()");
  await waitFor("document.querySelector('.forge-comparisons legend').textContent.includes('1 / 25')");
  await click("Review backlog"); await waitState((value) => value.analyses?.length === 1); await openReport();
  let saved = await state();
  check(saved.analyses[0].compared.length === 1 && saved.analyses[0].compared[0].runId === "comparison-104", "Exact explicitly selected comparison scope is retained");
  check(await evaluate(`${report}.querySelectorAll('article').length === 5`), "Findings cover all five hierarchy levels");
  check(await evaluate(`${report}.querySelectorAll('.forge-evidence mark').length === 10`), "Exact quoted fields are highlighted side by side");
  check(saved.analyses[0].findings.every((item) => item.counterparts[0].breadcrumb.length), "Counterpart breadcrumbs are persisted");
  await choose("Finding level", "task"); check(await evaluate(`${report}.querySelectorAll('article').length === 1`), "Level filter works");
  await choose("Finding level", "all"); await choose("Finding type", "contradiction"); check(await evaluate(`${report}.querySelectorAll('article').length === 2`), "Type filter works");
  await choose("Finding type", "all");
  check(await evaluate(`[...${firstCard}.querySelectorAll('button')].find(el => el.textContent==='Dismiss with reason').disabled`), "Dismiss requires a reason");
  await evaluate(`[...${firstCard}.querySelectorAll('button')].find(el => el.textContent==='Confirm finding').focus()`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await waitState((value) => value.analyses[0].findings[0].review.status === "confirmed");
  check((await state()).refinementVersion === 1, "Confirm does not change refinement version");
  await fillReason("Intentional separate ownership"); await click("Dismiss with reason", firstCard);
  await waitState((value) => value.analyses[0].findings[0].review.status === "dismissed");
  await choose("Finding status", "dismissed"); check(await evaluate(`${report}.querySelectorAll('article').length === 1`), "Status filter works");
  check(await evaluate(`[...${firstCard}.querySelectorAll('button')].find(el => el.textContent==='Prepare proposed update').disabled`), "Dismissed finding cannot prepare an update");
  await click("Reload saved entry"); await openReport();
  check(await latestStatus() === "dismissed", "Dismissal persists after reload");
  await click("Review backlog"); await waitState((value) => value.analyses.length === 2); await openReport();
  check(await latestStatus() === "dismissed", "Unchanged evidence retains a dismissal on reanalysis");
  await click("Reopen finding", firstCard); await waitState((value) => value.analyses.at(-1).findings[0].review.status === "open");
  check(await latestStatus() === "open", "Reopen persists");
  await click("Prepare proposed update", firstCard); await waitFor("document.querySelector('.forge-proposal')");
  const version = (await state()).refinementVersion;
  await click("Confirm finding", firstCard); await waitState((value) => value.analyses.at(-1).findings[0].review.status === "confirmed");
  check((await state()).refinementVersion === version, "Reviewing a pending proposal does not invalidate its content version");
  await click("Accept proposal"); await waitFor("document.querySelector('.delivery-initiative h3')?.textContent === 'Reader continuity clarified'");
  saved = await state();
  check(saved.plan.initiative.title === "Reader continuity", "Original saved hierarchy remains unchanged");
  check(saved.refinements.at(-1).status === "accepted", "Existing explicit refinement acceptance still works");
  await click("Review backlog"); await waitState((value) => value.analyses.length === 3); await openReport();
  check(await latestStatus() === "open", "Changed evidence reopens prior finding decisions");
  await fetch(`${api}/test/change-comparison`, { method: "POST" }); await click("Reload saved entry"); await openReport();
  check(await evaluate(`${report}.textContent.includes('evidence changed')`), "Changed counterpart makes the report stale");
  check(await evaluate(`[...${report}.querySelectorAll('fieldset')].every(el => el.disabled)`), "Stale finding review controls are disabled");
  check(await evaluate(`[...${report}.querySelectorAll('article button')].filter(el => el.textContent==='Prepare proposed update').every(el => el.disabled)`), "Stale updates are disabled");
  const reportCount = (await state()).analyses.length;
  await updateProvider(true); await click("Review backlog");
  await waitFor("document.querySelector('.forge-intelligence > p[role=status]').textContent.includes('No validated semantic review')");
  check((await state()).analyses.length === reportCount, "Provider failure saves no false clean report");
  await updateProvider(false, true); await click("Review backlog"); await waitState((value) => value.analyses.length === reportCount + 1); await openReport();
  check(await evaluate(`${report}.textContent.includes('Selected-scope coverage: partial')`), "Incomplete coverage is explicitly visible");
  check((await state()).analyses.at(-1).coverage.excluded.length === 1, "Excluded artifact is recorded");
  for (const width of [1440, 390]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 1100, deviceScaleFactor: 1, mobile: width < 700 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    check(await evaluate("document.documentElement.scrollWidth <= innerWidth"), `No horizontal overflow at ${width}px`);
    const columns = await evaluate(`getComputedStyle(${firstCard}.querySelector('.forge-evidence')).gridTemplateColumns.split(' ').length`);
    check(columns === (width < 700 ? 1 : 2), `Evidence columns adapt at ${width}px`);
    await evaluate(`${report}.scrollIntoView()`);
    const capture = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(`.repo-cache/phase4-browser-${String(width)}.png`, Buffer.from(capture.data, "base64"));
  }
  check(exceptions.length === 0, `No browser JavaScript exceptions: ${exceptions.join(', ')}`);
  console.log(`PASS: ${assertions} real-browser assertions: pagination, isolation, exact evidence, filters, confirm/dismiss/reopen, history, refinement, stale evidence, provider failure, partial coverage and responsive layout.`);
} finally {
  await Promise.race([send("Page.close").catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 1000))]); socket.close();
}
