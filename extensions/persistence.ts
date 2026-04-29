import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AttentionLedger, AttentionLedgerEntry } from "./support.js";
import { createAttentionLedger } from "./support.js";

export async function readAttentionLedger(path: string): Promise<AttentionLedger> {
  try {
    const raw = await readFile(path, "utf8");
    return normalizeAttentionLedger(JSON.parse(raw));
  } catch {
    return createAttentionLedger();
  }
}

export async function writeAttentionLedger(path: string, ledger: AttentionLedger): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${serializeAttentionLedger(ledger)}\n`, "utf8");
  await rename(tempPath, path);
}

export function serializeAttentionLedger(ledger: AttentionLedger): string {
  return JSON.stringify(normalizeAttentionLedger(ledger), null, 2);
}

function normalizeAttentionLedger(value: unknown): AttentionLedger {
  const result = createAttentionLedger();
  if (!isRecord(value) || !isRecord(value.runs)) {
    return result;
  }

  for (const [runId, entry] of Object.entries(value.runs)) {
    const normalized = normalizeAttentionLedgerEntry(entry);
    if (normalized) {
      result.runs[runId] = normalized;
    }
  }

  return result;
}

function normalizeAttentionLedgerEntry(value: unknown): AttentionLedgerEntry | undefined {
  if (!isRecord(value) || typeof value.note !== "string" || value.note.trim().length === 0) {
    return undefined;
  }

  const entry: AttentionLedgerEntry = {
    note: value.note,
  };

  if (typeof value.lastNotifiedNote === "string") {
    entry.lastNotifiedNote = value.lastNotifiedNote;
  }
  if (typeof value.acknowledgedNote === "string") {
    entry.acknowledgedNote = value.acknowledgedNote;
  }
  if (typeof value.snoozedUntil === "number" && Number.isFinite(value.snoozedUntil) && value.snoozedUntil > 0) {
    entry.snoozedUntil = value.snoozedUntil;
  }

  return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
