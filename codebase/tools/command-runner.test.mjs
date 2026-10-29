import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runToolCommand } from "./command-runner.mjs";
import { resolvePnpmInvocation } from "./package-manager.mjs";

test("pnpm tools use Corepack rather than a conflicting PATH shim and preserve literal arguments", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo corepack "));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "dist"));
  await writeFile(path.join(root, "dist", "pnpm.js"), "console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));");
  await writeFile(path.join(root, "pnpm.cmd"), "@echo WRONG_PNPM_12\r\n@exit /b 86\r\n");
  const env = { ...process.env, COREPACK_ROOT: root, PATH: root };
  const args = ["audit", "a b", 'literal"quote', "&echo injected", "$HOME", "%PATH%"];
  const result = await runToolCommand({ command: "pnpm", args, cwd: root, env });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { cwd: root, args });
  assert.doesNotMatch(result.stderr, /DEP0190/);
  const invocation = await resolvePnpmInvocation(args, { env });
  assert.equal(invocation.command, process.execPath);
});

test("native tools execute without a shell and propagate nonzero exits", async () => {
  const result = await runToolCommand({ command: process.execPath, args: ["-e", "console.error('controlled failure');process.exit(7)"], cwd: process.cwd() });
  assert.equal(result.exitCode, 7);
  assert.match(result.stderr, /controlled failure/);
});

test("missing Corepack fails clearly instead of running a global pnpm", async () => {
  await assert.rejects(resolvePnpmInvocation(["--version"], {
    env: {}, nodePath: path.join(os.tmpdir(), "missing-repo-node", "node")
  }), /Corepack is required/);
});
