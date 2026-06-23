#!/usr/bin/env node
/**
 * Minimal live reproducer for claude-pty sessions that remain in `starting`
 * until waitForCompletion reports a silent peer.
 *
 * Examples:
 *   node scripts/repro-claude-pty-silent.mjs
 *   REPRO_WORKFLOW_ENV=1 REPRO_MODEL=claude-opus-4-7 node scripts/repro-claude-pty-silent.mjs
 *   REPRO_CLAUDE_VERSION=2.1.167 node scripts/repro-claude-pty-silent.mjs
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = new URL("..", import.meta.url).pathname;

function buildWorkspace() {
  const result = spawnSync("npm", ["run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`npm run build failed with ${result.status}`);
  }
}

async function makeClaudeVersionWrapper(version) {
  if (!version) return null;
  const dir = await mkdtemp(join(tmpdir(), "pi-ca-leash-claude-wrapper-"));
  const wrapper = join(dir, `claude-${version}`);
  await writeFile(
    wrapper,
    [
      "#!/usr/bin/env bash",
      `exec npm exec --yes --package @anthropic-ai/claude-code@${version} -- claude "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { dir, wrapper };
}

function workflowEnv() {
  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://spellkave-telem.tailc66a3b.ts.net:4318",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_LOG_USER_PROMPTS: "1",
    OTEL_LOG_TOOL_DETAILS: "1",
    OTEL_LOG_TOOL_CONTENT: "1",
    OTEL_METRIC_EXPORT_INTERVAL: "2000",
    OTEL_BSP_SCHEDULE_DELAY: "2000",
    OTEL_BSP_EXPORT_TIMEOUT: "10000",
    PI_OTEL_ENABLED: "true",
    CASTRA_LANE: "fullsend",
    CASTRA_PERSONA: "groom",
    CASTRA_WORK_ID: "local-claude-pty-repro",
  };
}

function parseBool(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

async function main() {
  buildWorkspace();

  const wrapper = await makeClaudeVersionWrapper(process.env.REPRO_CLAUDE_VERSION);
  if (wrapper) {
    process.env.CLAUDE_CLI_EXECUTABLE = wrapper.wrapper;
  }
  if (parseBool(process.env.REPRO_WORKFLOW_ENV)) {
    Object.assign(process.env, workflowEnv());
  }

  const { PiCaLeashManagedPeerApi } = await import(
    "../packages/intercom-bridge/dist/index.js"
  );
  const api = new PiCaLeashManagedPeerApi({ cwd: repoRoot });
  const name = `repro-claude-pty-${Date.now()}`;
  const model = process.env.REPRO_MODEL || "claude-sonnet-4-6";
  const staleThresholdMs = Number(process.env.REPRO_STALE_MS || "60000");
  const hardCeilingMs = Number(process.env.REPRO_HARD_MS || "120000");
  let peer;

  try {
    console.log(
      JSON.stringify({
        phase: "launch",
        name,
        model,
        staleThresholdMs,
        hardCeilingMs,
        claudeExecutable: process.env.CLAUDE_CLI_EXECUTABLE || "claude",
        workflowEnv: parseBool(process.env.REPRO_WORKFLOW_ENV),
      }),
    );
    peer = await api.launchPeer({
      name,
      prompt:
        'Respond with exactly this JSON and nothing else: {"ok":true,"driver":"claude-pty"}',
      cwd: repoRoot,
      driver: "claude-pty",
      model,
      securityMode: "yolo",
      waitForIdle: false,
      kind: "managed",
      metadata: { owner: "pi-ca-leash-repro", role: "direct-claude-pty" },
    });
    console.log(JSON.stringify({ phase: "launched", peerName: peer.name, sessionId: peer.sessionId }));

    const status = await api.waitForCompletion(peer.sessionId, {
      staleThresholdMs,
      hardCeilingMs,
      silentOnFailure: true,
    });
    console.log(JSON.stringify({ phase: "status", status }, null, 2));
  } catch (err) {
    console.log(
      JSON.stringify(
        {
          phase: "error",
          name: err?.name,
          message: err?.message,
          stack: String(err?.stack || err).split("\n").slice(0, 10),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } finally {
    if (peer?.sessionId) {
      const events = await api.events(peer.sessionId).catch((err) => ({
        error: String(err?.message || err),
        items: [],
      }));
      console.log(
        JSON.stringify(
          {
            phase: "events",
            count: events.items?.length ?? 0,
            tail: (events.items ?? []).slice(-10),
          },
          null,
          2,
        ),
      );
    }
    if (peer?.name) {
      await api.stop(peer.name).catch((err) =>
        console.log(JSON.stringify({ phase: "stop-error", message: String(err?.message || err) })),
      );
    }
    if (wrapper) await rm(wrapper.dir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
