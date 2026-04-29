import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuntimeEvent, RuntimeSessionId, RuntimeStatus, TranscriptChunk } from "./types.js";

export function defaultStorageDir(): string {
  return join(process.cwd(), ".claude-runtime");
}

export function sessionDir(storageDir: string, sessionId: RuntimeSessionId): string {
  return join(storageDir, "sessions", sessionId);
}

export function statePath(storageDir: string, sessionId: RuntimeSessionId): string {
  return join(sessionDir(storageDir, sessionId), "state.json");
}

export function eventsPath(storageDir: string, sessionId: RuntimeSessionId): string {
  return join(sessionDir(storageDir, sessionId), "events.jsonl");
}

export function transcriptPath(storageDir: string, sessionId: RuntimeSessionId): string {
  return join(sessionDir(storageDir, sessionId), "transcript.jsonl");
}

export async function ensureSessionLayout(storageDir: string, sessionId: RuntimeSessionId): Promise<void> {
  await mkdir(join(sessionDir(storageDir, sessionId), "artifacts"), { recursive: true });
}

export async function writeState(storageDir: string, status: RuntimeStatus): Promise<void> {
  const path = statePath(storageDir, status.sessionId);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

export async function readState(storageDir: string, sessionId: RuntimeSessionId): Promise<RuntimeStatus | undefined> {
  try {
    const raw = await readFile(statePath(storageDir, sessionId), "utf8");
    return JSON.parse(raw) as RuntimeStatus;
  } catch {
    return undefined;
  }
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const line = `${JSON.stringify(value)}\n`;
  await appendFile(path, line, "utf8");
}

async function readFileSafe(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export async function appendEvent(storageDir: string, event: RuntimeEvent): Promise<void> {
  await appendJsonLine(eventsPath(storageDir, event.sessionId), event);
  if (["message", "tool", "result", "error"].includes(event.type)) {
    await appendJsonLine(transcriptPath(storageDir, event.sessionId), event);
  }
}

export async function readJsonLines<T>(path: string): Promise<T[]> {
  const raw = await readFileSafe(path);
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export async function readEvents(
  storageDir: string,
  sessionId: RuntimeSessionId,
  cursor = 0,
): Promise<TranscriptChunk> {
  const items = await readJsonLines<RuntimeEvent>(eventsPath(storageDir, sessionId));
  return {
    items: items.slice(cursor),
    nextCursor: items.length,
  };
}

export async function readTranscript(
  storageDir: string,
  sessionId: RuntimeSessionId,
  cursor = 0,
): Promise<TranscriptChunk> {
  const items = await readJsonLines<RuntimeEvent>(transcriptPath(storageDir, sessionId));
  return {
    items: items.slice(cursor),
    nextCursor: items.length,
  };
}

export async function tailTranscript(
  storageDir: string,
  sessionId: RuntimeSessionId,
  limit = 20,
): Promise<RuntimeEvent[]> {
  const items = await readJsonLines<RuntimeEvent>(transcriptPath(storageDir, sessionId));
  return items.slice(-limit);
}

export async function listStates(storageDir: string): Promise<RuntimeStatus[]> {
  const base = join(storageDir, "sessions");
  try {
    const entries = await readdir(base, { withFileTypes: true });
    const states = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => readState(storageDir, entry.name)),
    );
    return states.filter((state): state is RuntimeStatus => Boolean(state));
  } catch {
    return [];
  }
}
