import { spawn } from "node:child_process";
import { resolvePnpmInvocation } from "./package-manager.mjs";

export const runToolCommand = async ({ command, args, cwd, env = process.env, captureOutput = true }) => {
  const invocation = command === "pnpm" ? await resolvePnpmInvocation(args, { env }) : { command, args };
  return await new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env,
      shell: false,
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit"
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({
      exitCode: exitCode ?? 1,
      signal,
      stdout,
      stderr,
      durationMs: Date.now() - started
    }));
  });
};
