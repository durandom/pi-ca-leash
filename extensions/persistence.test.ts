import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttentionLedger } from "./support.ts";
import { readAttentionLedger, serializeAttentionLedger, writeAttentionLedger } from "./persistence.ts";

test("attention ledger persistence round-trips ack and snooze state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ca-leash-attention-"));
  const file = join(dir, "attention-ledger.json");
  const ledger = {
    runs: {
      run1: {
        note: "Needs attention: idle for 6000ms",
        lastNotifiedNote: "Needs attention: idle for 6000ms",
        acknowledgedNote: "Needs attention: idle for 6000ms",
        snoozedUntil: 12_345,
      },
    },
  };

  await writeAttentionLedger(file, ledger);
  const restored = await readAttentionLedger(file);
  assert.deepEqual(restored, ledger);
});

test("missing or invalid attention ledger falls back to empty state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ca-leash-attention-"));
  const file = join(dir, "attention-ledger.json");

  assert.deepEqual(await readAttentionLedger(file), createAttentionLedger());

  await writeFile(file, "{ definitely-not-json\n", "utf8");
  assert.deepEqual(await readAttentionLedger(file), createAttentionLedger());
});

test("attention ledger persistence sanitizes malformed entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ca-leash-attention-"));
  const file = join(dir, "attention-ledger.json");

  await writeFile(file, JSON.stringify({
    runs: {
      keep: {
        note: "Needs attention: idle for 9000ms",
        lastNotifiedNote: "Needs attention: idle for 9000ms",
        acknowledgedNote: 42,
        snoozedUntil: "later",
      },
      drop1: null,
      drop2: { acknowledgedNote: "missing note" },
    },
  }), "utf8");

  const restored = await readAttentionLedger(file);
  assert.deepEqual(restored, {
    runs: {
      keep: {
        note: "Needs attention: idle for 9000ms",
        lastNotifiedNote: "Needs attention: idle for 9000ms",
      },
    },
  });

  const serialized = serializeAttentionLedger(restored);
  assert.equal(JSON.parse(serialized).runs.keep.note, "Needs attention: idle for 9000ms");
  assert.match(await readFile(file, "utf8"), /drop1/);
});
