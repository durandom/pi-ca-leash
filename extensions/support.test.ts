import test from "node:test";
import assert from "node:assert/strict";
import type { SubagentRunRecord } from "@pi-claude-code-agent/subagents-backend";
import {
  acknowledgeAttention,
  createAttentionLedger,
  createDashboardState,
  describeAttentionState,
  detectConnectivityTransition,
  recordDashboardEvent,
  recordDashboardRefresh,
  reconcileAttentionLedger,
  shouldRebindTransport,
  snoozeAttention,
} from "./support.ts";

function makeRun(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: overrides.runId ?? "run-12345678",
    runner: "claude-code-agent",
    agentName: overrides.agentName ?? "worker",
    sessionId: overrides.sessionId,
    cwd: overrides.cwd ?? process.cwd(),
    model: overrides.model,
    state: overrides.state ?? "running",
    context: overrides.context ?? "fresh",
    createdAt: overrides.createdAt ?? "2026-04-29T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-04-29T10:00:00.000Z",
    lastActivityAt: overrides.lastActivityAt ?? "2026-04-29T10:00:00.000Z",
    task: overrides.task ?? "Investigate",
    result: overrides.result,
    note: overrides.note,
    raw: overrides.raw,
  };
}

test("dashboard refresh does not overwrite last event timestamp", () => {
  const state = createDashboardState("startup", 100);
  recordDashboardRefresh(state, 250);
  assert.deepEqual(state, {
    lastEvent: "startup",
    lastEventAt: 100,
    lastRefreshedAt: 250,
  });

  recordDashboardEvent(state, "intercom connected", 400);
  assert.deepEqual(state, {
    lastEvent: "intercom connected",
    lastEventAt: 400,
    lastRefreshedAt: 400,
  });
});

test("connectivity transitions only fire on real flips", () => {
  assert.equal(detectConnectivityTransition(undefined, false), undefined);
  assert.equal(detectConnectivityTransition(undefined, true), undefined);
  assert.equal(detectConnectivityTransition(false, false), undefined);
  assert.equal(detectConnectivityTransition(true, true), undefined);
  assert.equal(detectConnectivityTransition(false, true), "connected");
  assert.equal(detectConnectivityTransition(true, false), "disconnected");
});

test("transport rebind only needed when peers are missing broker connections", () => {
  assert.equal(shouldRebindTransport(undefined), false);
  assert.equal(shouldRebindTransport({ kind: "pi-intercom", boundPeers: 0, connectedPeers: 0 }), false);
  assert.equal(shouldRebindTransport({ kind: "pi-intercom", boundPeers: 2, connectedPeers: 2 }), false);
  assert.equal(shouldRebindTransport({ kind: "pi-intercom", boundPeers: 2, connectedPeers: 1 }), true);
});

test("attention ledger notifies once, supports ack, and resets on note change", () => {
  const run = makeRun({ note: "Needs attention: idle for 6000ms" });
  const first = reconcileAttentionLedger(createAttentionLedger(), [run], 1_000);
  assert.equal(first.notify.length, 1);
  assert.equal(first.active.length, 1);
  assert.equal(describeAttentionState(first.active[0]!, 1_000), "active");

  const acknowledged = acknowledgeAttention(first.ledger, run.runId);
  const second = reconcileAttentionLedger(acknowledged, [run], 2_000);
  assert.equal(second.notify.length, 0);
  assert.equal(describeAttentionState(second.active[0]!, 2_000), "acked");

  const changed = reconcileAttentionLedger(acknowledged, [{ ...run, note: "Needs attention: idle for 12000ms" }], 3_000);
  assert.equal(changed.notify.length, 1);
  assert.equal(describeAttentionState(changed.active[0]!, 3_000), "active");
});

test("attention snooze suppresses alerts until expiry and clears when attention ends", () => {
  const run = makeRun({ note: "Needs attention: idle for 6000ms" });
  const first = reconcileAttentionLedger(createAttentionLedger(), [run], 1_000);
  const snoozed = snoozeAttention(first.ledger, run.runId, 10_000);

  const hidden = reconcileAttentionLedger(snoozed, [run], 5_000);
  assert.equal(hidden.notify.length, 0);
  assert.equal(describeAttentionState(hidden.active[0]!, 5_000), "snoozed 1m");

  const resumed = reconcileAttentionLedger(hidden.ledger, [run], 11_000);
  assert.equal(resumed.notify.length, 1);
  assert.equal(describeAttentionState(resumed.active[0]!, 11_000), "active");

  const cleared = reconcileAttentionLedger(resumed.ledger, [{ ...run, note: undefined }], 12_000);
  assert.equal(cleared.active.length, 0);
  assert.deepEqual(cleared.ledger.runs, {});
});
