import type { RuntimeEvent, RuntimeMessageBlock } from "@pi-claude-code-agent/runtime";

export interface PeerHistoryPage {
  startCursor: number;
  endCursor: number;
  total: number;
  previousCursor?: number;
  nextCursor?: number;
  text: string;
}

export function formatPeerHistoryPage(
  events: RuntimeEvent[],
  options: { cursor?: number; limit?: number } = {},
): PeerHistoryPage {
  const entries = events
    .map(formatTranscriptEvent)
    .filter((value): value is string => Boolean(value));
  const total = entries.length;
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 20)));
  const startCursor = options.cursor == null
    ? Math.max(0, total - limit)
    : Math.max(0, Math.min(total, Math.trunc(options.cursor)));
  const endCursor = Math.min(total, startCursor + limit);
  const page = entries.slice(startCursor, endCursor);

  return {
    startCursor,
    endCursor,
    total,
    previousCursor: startCursor > 0 ? Math.max(0, startCursor - limit) : undefined,
    nextCursor: endCursor < total ? endCursor : undefined,
    text: page.join("\n\n") || "<no visible transcript items in this range>",
  };
}

function formatTranscriptEvent(event: RuntimeEvent): string | undefined {
  switch (event.type) {
    case "message": {
      const text = event.message.blocks
        .map(blockToVisibleText)
        .filter((value): value is string => Boolean(value && value.trim()))
        .join("\n\n")
        .trim();
      if (!text) {
        return undefined;
      }
      return [`[${event.sequence} ${formatIsoTime(event.timestamp)}] ${event.role}`, text].join("\n");
    }
    case "tool": {
      const payload = event.phase === "requested" ? event.input : event.output;
      const body = formatPayload(payload);
      return [`[${event.sequence} ${formatIsoTime(event.timestamp)}] tool ${event.phase} ${event.toolName}`, body].filter(Boolean).join("\n");
    }
    case "error":
      return [`[${event.sequence} ${formatIsoTime(event.timestamp)}] error`, event.message].join("\n");
    default:
      return undefined;
  }
}

function blockToVisibleText(block: RuntimeMessageBlock): string | undefined {
  if (block.type === "thinking") {
    return undefined;
  }
  return typeof block.text === "string" ? block.text : undefined;
}

function formatPayload(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "string") {
    return truncate(value, 600);
  }
  try {
    return truncate(JSON.stringify(value, null, 2), 600);
  } catch {
    return truncate(String(value), 600);
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatIsoTime(timestamp: string): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}
