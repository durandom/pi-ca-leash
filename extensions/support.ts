import type { BridgeTransportStatus } from "@pi-claude-code-agent/intercom-bridge";
import type { SubagentRunRecord } from "@pi-claude-code-agent/subagents-backend";

export interface DashboardState {
  lastEvent: string;
  lastEventAt: number;
  lastRefreshedAt: number;
}

export interface AttentionLedgerEntry {
  note: string;
  lastNotifiedNote?: string;
  acknowledgedNote?: string;
  snoozedUntil?: number;
}

export interface AttentionLedger {
  runs: Record<string, AttentionLedgerEntry>;
}

export interface AttentionView {
  run: SubagentRunRecord;
  status: "active" | "acked" | "snoozed";
  snoozedUntil?: number;
}

export interface AttentionReconciliation {
  ledger: AttentionLedger;
  notify: SubagentRunRecord[];
  active: AttentionView[];
}

export function createDashboardState(lastEvent: string, now = Date.now()): DashboardState {
  return {
    lastEvent,
    lastEventAt: now,
    lastRefreshedAt: now,
  };
}

export function recordDashboardEvent(state: DashboardState, lastEvent: string, now = Date.now()): void {
  state.lastEvent = lastEvent;
  state.lastEventAt = now;
  state.lastRefreshedAt = now;
}

export function recordDashboardRefresh(state: DashboardState, now = Date.now()): void {
  state.lastRefreshedAt = now;
}

export function detectConnectivityTransition(previous: boolean | undefined, next: boolean): "connected" | "disconnected" | undefined {
  if (previous === undefined || previous === next) {
    return undefined;
  }
  return next ? "connected" : "disconnected";
}

export function shouldRebindTransport(status: BridgeTransportStatus | undefined): boolean {
  if (!status) {
    return false;
  }
  return status.boundPeers > status.connectedPeers;
}

export function createAttentionLedger(): AttentionLedger {
  return { runs: {} };
}

export function reconcileAttentionLedger(
  ledger: AttentionLedger,
  runs: SubagentRunRecord[],
  now = Date.now(),
): AttentionReconciliation {
  const nextRuns: AttentionLedger["runs"] = {};
  const notify: SubagentRunRecord[] = [];
  const active: AttentionView[] = [];

  for (const run of runs.filter((item) => hasAttentionNote(item.note))) {
    const note = run.note ?? "Needs attention";
    const previous = ledger.runs[run.runId];
    const entry: AttentionLedgerEntry = previous?.note === note
      ? { ...previous, note }
      : { note };

    if (entry.snoozedUntil && entry.snoozedUntil <= now) {
      delete entry.snoozedUntil;
      delete entry.lastNotifiedNote;
    }

    const view = buildAttentionView(run, entry, now);

    if (view.status === "active" && entry.lastNotifiedNote !== note) {
      entry.lastNotifiedNote = note;
      notify.push(run);
    }

    nextRuns[run.runId] = entry;
    active.push(view);
  }

  active.sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt));

  return {
    ledger: { runs: nextRuns },
    notify,
    active,
  };
}

export function acknowledgeAttention(ledger: AttentionLedger, runId: string): AttentionLedger {
  const entry = ledger.runs[runId];
  if (!entry) {
    return ledger;
  }
  return {
    runs: {
      ...ledger.runs,
      [runId]: {
        ...entry,
        acknowledgedNote: entry.note,
        snoozedUntil: undefined,
      },
    },
  };
}

export function snoozeAttention(ledger: AttentionLedger, runId: string, snoozedUntil: number): AttentionLedger {
  const entry = ledger.runs[runId];
  if (!entry) {
    return ledger;
  }
  return {
    runs: {
      ...ledger.runs,
      [runId]: {
        ...entry,
        snoozedUntil,
      },
    },
  };
}

export function listAttentionViews(
  ledger: AttentionLedger,
  runs: SubagentRunRecord[],
  now = Date.now(),
): AttentionView[] {
  return runs
    .filter((run) => hasAttentionNote(run.note))
    .map((run) => {
      const note = run.note ?? "Needs attention";
      const previous = ledger.runs[run.runId];
      const entry = previous?.note === note ? { ...previous, note } : { note };
      return buildAttentionView(run, entry, now);
    })
    .sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt));
}

export function describeAttentionState(view: AttentionView, now = Date.now()): string {
  if (view.status === "acked") {
    return "acked";
  }
  if (view.status === "snoozed" && view.snoozedUntil) {
    const remainingMs = Math.max(0, view.snoozedUntil - now);
    const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    return `snoozed ${remainingMinutes}m`;
  }
  return "active";
}

export function hasAttentionNote(note: string | undefined): boolean {
  return Boolean(note && note.toLowerCase().includes("needs attention"));
}

function buildAttentionView(run: SubagentRunRecord, entry: AttentionLedgerEntry, now: number): AttentionView {
  const acknowledged = entry.acknowledgedNote === entry.note;
  const snoozed = !acknowledged && (entry.snoozedUntil ?? 0) > now;
  return {
    run,
    status: acknowledged ? "acked" : snoozed ? "snoozed" : "active",
    snoozedUntil: entry.snoozedUntil,
  };
}
