// Run against an isolated preview seeded with the local "Reading brief one" fixture.
// Usage: node apps/web/tests/browser/story-agent-vault.mjs <preview-url> <CDP-url>
import assert from "node:assert/strict";

const preview = new URL(process.argv[2] ?? "");
const debugging = new URL(process.argv[3] ?? "");
for (const url of [preview, debugging]) assert.ok(url.protocol === "http:" && url.hostname === "127.0.0.1", "Use isolated loopback test servers only.");
const tab = await (await fetch(`${debugging.origin}/json/new?about:blank`, { method: "PUT" })).json();
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let sequence = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
socket.onmessage = ({ data }) => {
  const message = JSON.parse(data); const callback = pending.get(message.id);
  if (!callback) return;
  pending.delete(message.id);
  if (message.error) callback.reject(new Error(JSON.stringify(message.error))); else callback.resolve(message.result);
};
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
};
const waitFor = async (expression) => {
  const deadline = Date.now() + Number(process.env.STORY_AGENT_BROWSER_TIMEOUT_MS ?? 120_000);
  while (Date.now() < deadline) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`Timed out waiting for ${expression}`);
};

try {
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Page.bringToFront");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: preview.href });
  // History count proves hydration/effects have finished before the first click.
  await waitFor("document.readyState === 'complete' && [...document.querySelectorAll('.forge-nav__content button')].some(el => /Story vault\\s+[1-9]/.test(el.textContent))");
  await evaluate("[...document.querySelectorAll('.forge-nav__content button')].find(el => el.textContent.includes('Story vault')).click()");
  await waitFor("[...document.querySelectorAll('.forge-history-entry__open')].some(el => el.textContent.includes('Reading brief one'))");
  await evaluate("document.querySelector('.forge-history-entry__open b').textContent = 'Reading brief one — ' + 'A reader resumes a chapter across devices and preserves progress. '.repeat(6)");
  let assertions = 0;
  for (const width of [1440, 390]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: width < 700 });
    await new Promise((resolve) => setTimeout(resolve, 400)); // Responsive navigation transition.
    const geometry = await evaluate(`(() => {
      const row = [...document.querySelectorAll('.forge-history-entry')].find(el => el.textContent.includes('Reading brief one'));
      const open = row.querySelector('.forge-history-entry__open'), remove = row.querySelector('.forge-history-entry__delete');
      return { row: row.getBoundingClientRect().width, open: open.getBoundingClientRect().width, remove: remove.getBoundingClientRect().width, shrink: getComputedStyle(remove).flexShrink, name: remove.getAttribute('aria-label'), overflow: document.documentElement.scrollWidth > innerWidth };
    })()`);
    assert.ok(geometry.open > geometry.row * 0.7, `Open action collapsed at ${width}px: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.remove >= 32 && geometry.remove <= 44, `Delete control unbounded at ${width}px`);
    assert.equal(geometry.shrink, "0"); assert.equal(geometry.overflow, false);
    assert.equal(geometry.name, "Delete history entry: Reading brief one"); assertions += 5;
    console.log(`PASS: vault geometry at ${width}px (open=${geometry.open}, delete=${geometry.remove}).`);
    await evaluate("document.querySelector('.forge-history-entry__delete').focus()");
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await waitFor("document.querySelector('[role=alertdialog]')");
    assert.ok(await evaluate("document.querySelector('[role=alertdialog]').textContent.includes('Reading brief one')")); assertions += 1;
    await evaluate("[...document.querySelectorAll('[role=alertdialog] button')].find(el => el.textContent.trim() === 'Cancel').click()");
    await waitFor("!document.querySelector('[role=alertdialog]')");
  }
  // Keyboard activation of the independent open action still restores the entry.
  await evaluate("document.querySelector('.forge-history-entry__open').focus()");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", unmodifiedText: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await waitFor("document.querySelector('.forge-results')");
  assert.equal(await evaluate("Boolean(document.querySelector('[role=alertdialog]'))"), false); assertions += 1;
  console.log(`PASS: ${assertions} vault layout/accessibility assertions at 1440px and 390px; keyboard delete confirmation/cancel and independent open action.`);
} finally {
  await Promise.race([send("Page.close").catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 1_000))]);
  socket.close();
}
