import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const promptTemplatePath = resolve(repoRoot, "scripts", "prompts", "auto-smoke.md");
const timeoutMs = 5 * 60 * 1000;
const requiredTools = [
  "peer_start",
  "peer_list",
  "peer_ask",
  "peer_history",
  "peer_stop",
  "subagent_run",
  "subagent_list",
  "subagent_status",
  "team_spawn",
  "team_list",
  "team_task",
  "team_message",
  "team_stop",
];

const cliArgs = process.argv.slice(2);
const env = { ...process.env };
let requestedDriver = "default";
if (cliArgs[0] === "--codex") {
  requestedDriver = "codex-cli";
  env.PI_CLAUDE_RUNTIME_DRIVER = "codex-cli";
  cliArgs.shift();
}
if (cliArgs.length > 0) {
  console.error(`Unknown arguments: ${cliArgs.join(" ")}`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const shortId = Math.random().toString(36).slice(2, 8);
const runId = `smoke-${stamp}-${shortId}`;
const peerName = `smoke-peer-${shortId}`;
const teamName = `smoke-team-${shortId}`;
const outputDir = resolve(repoRoot, ".pi-ca-leash", "smoke", "auto", `${stamp}-${shortId}`);
const promptOutputPath = resolve(outputDir, "prompt.md");
const jsonlPath = resolve(outputDir, "events.jsonl");
const stderrPath = resolve(outputDir, "stderr.log");
const reportPath = resolve(outputDir, "report.md");
const latestReportPath = resolve(repoRoot, ".pi-ca-leash", "smoke", "auto", "latest.md");

await mkdir(outputDir, { recursive: true });

const promptTemplate = await readFile(promptTemplatePath, "utf8");
const prompt = promptTemplate
  .replaceAll("__RUN_ID__", runId)
  .replaceAll("__PEER_NAME__", peerName)
  .replaceAll("__TEAM_NAME__", teamName);
await writeFile(promptOutputPath, prompt);

const piArgs = [
  "--mode",
  "json",
  "--no-session",
  "--no-context-files",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-builtin-tools",
  "--no-extensions",
  "-e",
  repoRoot,
  prompt,
];

const commandSummary = `pi ${piArgs
  .slice(0, -1)
  .map((arg) => (arg.includes(" ") ? JSON.stringify(arg) : arg))
  .join(" ")} <prompt from ${promptOutputPath}>`;

const status = (message) => {
  console.log(`[smoke] ${message}`);
};

status(`run id: ${runId}`);
status(`requested driver: ${requestedDriver}`);
status(`prompt: ${promptOutputPath}`);
status(`events: ${jsonlPath}`);
status(`stderr: ${stderrPath}`);
status(`report: ${reportPath}`);
status(`starting pi`);

const startedAt = Date.now();
const child = spawn("pi", piArgs, {
  cwd: repoRoot,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

let stdoutBuffer = "";
let stdoutRaw = "";
let stderrRaw = "";
let timedOut = false;
let spawnError;
let exitCode = null;
let exitSignal = null;
let sessionHeader = null;
let latestAssistantText = "";
let finalAssistantText = "";
let explicitFinalLine = "";
let terminatedAfterFinal = false;
let finalKillTimer;
const parseErrors = [];
const toolStarts = [];
const toolEnds = [];

const extractText = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
};

const summarizeArgs = (args) => {
  if (!args || typeof args !== "object") return "";
  const summary = [];
  for (const key of ["name", "task", "message", "title", "runId", "driver", "model", "async"]) {
    if (key in args) summary.push(`${key}=${JSON.stringify(args[key])}`);
  }
  return summary.join(", ");
};

const handleEventLine = (line) => {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch (error) {
    parseErrors.push(`${error instanceof Error ? error.message : String(error)} :: ${line}`);
    return;
  }

  if (event.type === "session") {
    sessionHeader = event;
    status(`session started: ${event.id}`);
    return;
  }

  if (event.type === "message_end" && event.message?.role === "assistant") {
    const text = extractText(event.message.content);
    if (text.trim()) {
      latestAssistantText = text;
      const line = text.trim().split(/\r?\n/).at(-1) ?? "";
      if (line === "SMOKE_OK" || line === "SMOKE_FAIL") {
        finalAssistantText = text;
        explicitFinalLine = line;
        if (!finalKillTimer) {
          status(`final assistant report observed: ${line}; closing pi`);
          finalKillTimer = setTimeout(() => {
            terminatedAfterFinal = true;
            child.kill("SIGTERM");
          }, 250);
        }
      }
    }
  }

  if (event.type === "tool_execution_start") {
    const summary = summarizeArgs(event.args);
    toolStarts.push({
      toolName: event.toolName,
      summary,
    });
    status(`tool start: ${event.toolName}${summary ? ` (${summary})` : ""}`);
  }

  if (event.type === "tool_execution_end") {
    const summary = summarizeArgs(event.args);
    const resultSummary = typeof event.result === "object" && event.result !== null
      ? JSON.stringify(event.result).slice(0, 400)
      : String(event.result ?? "");
    toolEnds.push({
      toolName: event.toolName,
      isError: Boolean(event.isError),
      summary,
      resultSummary,
    });
    status(`tool end: ${event.toolName} ${event.isError ? "ERROR" : "ok"}`);
  }
};

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  stdoutRaw += text;
  stdoutBuffer += text;

  while (true) {
    const newlineIndex = stdoutBuffer.indexOf("\n");
    if (newlineIndex === -1) break;
    const line = stdoutBuffer.slice(0, newlineIndex);
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    handleEventLine(line);
  }
});

child.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  stderrRaw += text;
  const trimmed = text.trim();
  if (trimmed) {
    status(`pi stderr: ${trimmed}`);
  }
});

child.on("error", (error) => {
  spawnError = error;
});

const timeout = setTimeout(() => {
  timedOut = true;
  status(`timeout after ${timeoutMs}ms; sending SIGTERM`);
  child.kill("SIGTERM");
}, timeoutMs);

await new Promise((resolve) => {
  child.on("close", (code, signal) => {
    exitCode = code;
    exitSignal = signal;
    resolve();
  });
});

clearTimeout(timeout);
if (finalKillTimer) {
  clearTimeout(finalKillTimer);
}

if (stdoutBuffer.trim()) {
  handleEventLine(stdoutBuffer);
}

await writeFile(jsonlPath, stdoutRaw);
await writeFile(stderrPath, stderrRaw);

const observedTools = [...new Set(toolStarts.map((entry) => entry.toolName))];
const missingTools = requiredTools.filter((toolName) => !observedTools.includes(toolName));
const toolErrors = toolEnds.filter((entry) => entry.isError);
const reportAssistantText = finalAssistantText || latestAssistantText;
const finalLine = explicitFinalLine || (reportAssistantText.trim().split(/\r?\n/).at(-1) ?? "");
const durationMs = Date.now() - startedAt;
const cleanExit = exitCode === 0 && exitSignal === null;
const expectedHarnessExit = terminatedAfterFinal && exitCode === null && exitSignal === "SIGTERM";
const passed = !spawnError
  && !timedOut
  && (cleanExit || expectedHarnessExit)
  && parseErrors.length === 0
  && toolErrors.length === 0
  && missingTools.length === 0
  && finalLine === "SMOKE_OK";

const markdown = [
  "# Automated runtime smoke report",
  "",
  `- Run id: \`${runId}\``,
  `- Requested driver: \`${requestedDriver}\``,
  `- Started: \`${new Date(startedAt).toISOString()}\``,
  `- Duration: \`${durationMs} ms\``,
  `- Exit code: \`${exitCode === null ? "null" : exitCode}\``,
  `- Exit signal: \`${exitSignal ?? "none"}\``,
  `- Timed out: \`${timedOut}\``,
  `- Session id: \`${sessionHeader?.id ?? "unknown"}\``,
  `- Peer name: \`${peerName}\``,
  `- Teammate name: \`${teamName}\``,
  `- Result: **${passed ? "PASS" : "FAIL"}**`,
  "",
  "## Invocation",
  "",
  "```bash",
  commandSummary,
  "```",
  "",
  "## Artifacts",
  "",
  `- Prompt: \`${promptOutputPath}\``,
  `- Events: \`${jsonlPath}\``,
  `- Stderr: \`${stderrPath}\``,
  "",
  "## Required tool coverage",
  "",
  ...requiredTools.map((toolName) => `- ${observedTools.includes(toolName) ? "PASS" : "FAIL"} \`${toolName}\``),
  "",
  "## Tool executions",
  "",
  "| Tool | Status | Summary |",
  "| --- | --- | --- |",
  ...toolEnds.map((entry) => `| \`${entry.toolName}\` | ${entry.isError ? "ERROR" : "ok"} | ${entry.summary.replaceAll("|", "\\|") || "-"} |`),
  "",
  "## Diagnostics",
  "",
  spawnError ? `- Spawn error: ${spawnError.message}` : "- Spawn error: none",
  parseErrors.length > 0 ? `- JSON parse errors: ${parseErrors.length}` : "- JSON parse errors: none",
  toolErrors.length > 0 ? `- Tool errors: ${toolErrors.length}` : "- Tool errors: none",
  missingTools.length > 0 ? `- Missing required tools: ${missingTools.join(", ")}` : "- Missing required tools: none",
  explicitFinalLine ? `- Explicit final marker: ${explicitFinalLine}` : "- Explicit final marker: none",
  terminatedAfterFinal ? "- Terminated after final marker: yes" : "- Terminated after final marker: no",
  stderrRaw.trim() ? `- Stderr present: yes` : "- Stderr present: no",
  "",
  "## Final assistant report",
  "",
  "```md",
  reportAssistantText.trim() || "(empty)",
  "```",
  "",
  passed ? "SMOKE_OK" : "SMOKE_FAIL",
  "",
].join("\n");

await writeFile(reportPath, markdown);
await copyFile(reportPath, latestReportPath);

status(`finished: ${passed ? "PASS" : "FAIL"}`);
status(`latest report: ${latestReportPath}`);
console.log(markdown);
process.exit(passed ? 0 : 1);
