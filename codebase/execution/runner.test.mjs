import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { executePlan } from "./runner.mjs";

test("workspace pnpm tasks ignore a conflicting global shim", async (context) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-pinned-pnpm-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "corepack", "dist"), { recursive: true });
  await writeFile(path.join(root, "corepack", "dist", "pnpm.js"), "console.log('PINNED_TASK ' + process.argv.slice(2).join(' '));");
  const previous = process.env.COREPACK_ROOT;
  process.env.COREPACK_ROOT = path.join(root, "corepack");
  context.after(() => { if (previous === undefined) delete process.env.COREPACK_ROOT; else process.env.COREPACK_ROOT = previous; });
  const result = await executePlan({
    workspace: { root, architecture: { foundation: { ignoredDirectories: [] } } },
    captureOutput: true,
    plan: [{ id: "fixture:test", project: "fixture", projectRoot: ".", name: "test", command: "pnpm test", inputs: [], outputs: [], cache: false, taskDependencies: [] }]
  });
  assert.equal(result[0].status, "passed", result[0].stderr);
  assert.match(result[0].stdout, /PINNED_TASK test/);
});

test("repository shell tasks retain quoted arguments and compound command behavior", async (context) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-shell-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "task.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const result = await executePlan({
    workspace: { root, architecture: { foundation: { ignoredDirectories: [] } } }, captureOutput: true,
    plan: [{ id: "fixture:test", project: "fixture", projectRoot: ".", name: "test", command: `"${process.execPath}" task.mjs "a b" && "${process.execPath}" task.mjs second`, inputs: [], outputs: [], cache: false, taskDependencies: [] }]
  });
  assert.equal(result[0].status, "passed", result[0].stderr);
  assert.deepEqual(result[0].stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)), [["a b"], ["second"]]);
});

test("executes a cacheable task once and reuses its result", async (context) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-runner-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "packages", "fixture");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "task.mjs"), [
    "import { mkdir, readFile, writeFile } from 'node:fs/promises';",
    "await mkdir('dist', { recursive: true });",
    "const count = Number(await readFile('count.txt', 'utf8').catch(() => '0')) + 1;",
    "await writeFile('count.txt', String(count));",
    "await writeFile('dist/result.txt', 'complete');"
  ].join("\n"), "utf8");

  const workspace = {
    root,
    architecture: { foundation: { ignoredDirectories: [".repo-cache", "dist"] } }
  };
  const plan = [{
    id: "fixture:build",
    project: "fixture",
    projectRoot: "packages/fixture",
    name: "build",
    command: `"${process.execPath}" task.mjs`,
    inputs: ["task.mjs"],
    outputs: ["dist"],
    cache: true,
    taskDependencies: []
  }];

  const first = await executePlan({ workspace, plan, captureOutput: true });
  const second = await executePlan({ workspace, plan, captureOutput: true });
  assert.equal(first[0].status, "passed", first[0].stderr);
  assert.equal(second[0].status, "cached");
  assert.equal(await readFile(path.join(projectRoot, "count.txt"), "utf8"), "1");
});

test("runs independent tasks concurrently and skips failed dependents", async (context) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-parallel-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "packages", "fixture"), { recursive: true });
  const base = (id, taskDependencies = []) => ({
    id, project: "fixture", projectRoot: "packages/fixture", name: id, command: id,
    inputs: [], outputs: [], environment: [], cache: false, taskDependencies
  });
  const plan = [base("one"), base("two"), base("dependent", ["one"])];
  let active = 0;
  let maximumActive = 0;
  const commandRunner = async ({ command }) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return { exitCode: command === "one" ? 1 : 0, signal: null, stdout: "", stderr: "", durationMs: 0 };
  };
  const results = await executePlan({ workspace: { root, architecture: { foundation: { ignoredDirectories: [] } } }, plan, concurrency: 2, commandRunner });
  assert.equal(maximumActive, 2);
  assert.ok(results[0].durationMs > 0, "task duration includes orchestration rather than being replaced by tool duration");
  assert.deepEqual(results.map(({ task, status }) => [task, status]), [["one", "failed"], ["two", "passed"], ["dependent", "skipped"]]);
});

test("returns a structured failure when a command cannot start", async (context) => {
  const root = await mkdtemp(path.join(process.cwd(), ".test-tmp-command-error-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "packages", "fixture"), { recursive: true });
  const plan = [{
    id: "fixture:build", project: "fixture", projectRoot: "packages/fixture", name: "build",
    command: "missing", inputs: [], outputs: [], environment: [], cache: false, taskDependencies: []
  }];
  const [result] = await executePlan({
    workspace: { root, architecture: { foundation: { ignoredDirectories: [] } } },
    plan,
    commandRunner: async () => { throw new Error("spawn failed"); }
  });
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 1);
  assert.equal(result.error.message, "spawn failed");
});
