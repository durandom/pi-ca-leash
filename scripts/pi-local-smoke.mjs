import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const args = process.argv.slice(2);
const env = { ...process.env };

if (args[0] === "--codex") {
  env.PI_CLAUDE_RUNTIME_DRIVER = "codex-cli";
  args.shift();
}

const child = spawn("pi", ["--no-extensions", "-e", repoRoot, ...args], {
  cwd: repoRoot,
  stdio: "inherit",
  env,
});

child.on("error", (error) => {
  console.error(`Failed to start pi: ${error.message}`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
