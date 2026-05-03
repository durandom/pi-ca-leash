import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const autoDir = resolve(repoRoot, ".pi-ca-leash", "smoke", "auto");
const latestReportPath = resolve(autoDir, "latest.md");

async function latest() {
  if (!existsSync(latestReportPath)) {
    console.error(`No smoke report found at ${latestReportPath}`);
    process.exit(1);
  }
  const content = await readFile(latestReportPath, "utf8");
  process.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
}

async function clean() {
  if (!existsSync(autoDir)) {
    console.log(`Nothing to clean: ${autoDir}`);
    return;
  }

  const entries = await readdir(autoDir, { withFileTypes: true });
  const removable = entries.filter((entry) => entry.name !== ".gitkeep");
  for (const entry of removable) {
    await rm(resolve(autoDir, entry.name), { recursive: true, force: true });
  }
  console.log(`Cleaned ${removable.length} smoke artifact entr${removable.length === 1 ? "y" : "ies"} from ${autoDir}`);
}

const command = process.argv[2];
if (command === "latest") {
  await latest();
} else if (command === "clean") {
  await clean();
} else {
  console.error("Usage: node ./scripts/smoke-artifacts.mjs <latest|clean>");
  process.exit(1);
}
