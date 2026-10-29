import { access, realpath } from "node:fs/promises";
import path from "node:path";

// Corepack reads packageManager from the target cwd. Never resolve a bare pnpm
// shim: lifecycle PATHs can contain a different globally installed pnpm.
export const resolvePnpmInvocation = async (args, {
  env = process.env, nodePath = process.execPath, platform = process.platform
} = {}) => {
  const candidates = [
    ...(env.COREPACK_ROOT ? [path.join(env.COREPACK_ROOT, "dist", "pnpm.js")] : []),
    path.join(path.dirname(nodePath), "node_modules", "corepack", "dist", "pnpm.js"),
    path.resolve(path.dirname(nodePath), "../lib/node_modules/corepack/dist/pnpm.js")
  ];
  const searchPath = env.PATH ?? env.Path ?? "";
  for (const directory of searchPath.split(platform === "win32" ? ";" : ":").filter(Boolean)) {
    candidates.push(path.join(directory, "node_modules", "corepack", "dist", "pnpm.js"));
    try {
      const executable = await realpath(path.join(directory, "corepack"));
      candidates.push(path.join(path.dirname(executable), "pnpm.js"));
    } catch { /* Continue to the next Corepack location. */ }
  }
  for (const entry of [...new Set(candidates)]) {
    try { await access(entry); }
    catch { continue; }
    return { command: nodePath, args: [entry, ...args] };
  }
  throw new Error("Corepack is required to run repository-pinned pnpm. Install Corepack alongside Node.js.");
};
