import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RuntimeEvent } from "@pi-claude-code-agent/runtime";
import type { RunResult, SubagentRunChunk, SubagentRunRecord } from "./types.js";

export function defaultRunsDir(): string {
  return resolve(process.cwd(), ".subagent-runs");
}

export function runDir(storageDir: string, runId: string): string {
  return join(storageDir, "runs", runId);
}

export async function ensureRunLayout(storageDir: string, runId: string): Promise<void> {
  const dir = runDir(storageDir, runId);
  await mkdir(join(dir, "artifacts"), { recursive: true });
}

export async function writeRunState(storageDir: string, record: SubagentRunRecord): Promise<void> {
  const file = join(runDir(storageDir, record.runId), "status.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export async function readRunState(storageDir: string, runId: string): Promise<SubagentRunRecord | undefined> {
  try {
    const file = join(runDir(storageDir, runId), "status.json");
    return JSON.parse(await readFile(file, "utf8")) as SubagentRunRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function listRunStates(storageDir: string): Promise<SubagentRunRecord[]> {
  try {
    const root = join(storageDir, "runs");
    const ids = await readdir(root);
    const states = await Promise.all(ids.map((id) => readRunState(storageDir, id)));
    return states.filter((value): value is SubagentRunRecord => Boolean(value));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function appendRunEvent(storageDir: string, runId: string, event: RuntimeEvent): Promise<void> {
  const file = join(runDir(storageDir, runId), "events.jsonl");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
}

export async function readRunEvents(storageDir: string, runId: string, cursor = 0): Promise<SubagentRunChunk> {
  try {
    const file = join(runDir(storageDir, runId), "events.jsonl");
    const raw = await readFile(file, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const items = lines.slice(cursor).map((line) => JSON.parse(line) as RuntimeEvent);
    return { items, nextCursor: lines.length };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { items: [], nextCursor: 0 };
    }
    throw error;
  }
}

export async function writeRunResult(storageDir: string, runId: string, result: RunResult): Promise<void> {
  const file = join(runDir(storageDir, runId), "result.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

export async function readRunResult(storageDir: string, runId: string): Promise<RunResult | undefined> {
  try {
    const file = join(runDir(storageDir, runId), "result.json");
    return JSON.parse(await readFile(file, "utf8")) as RunResult;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
