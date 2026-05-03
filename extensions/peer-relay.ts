export interface PeerRelaySnapshot {
  sessionId: string;
  state: string;
  updatedAt: string;
  relayKey: string;
}

export interface PeerRelayMessageInput {
  peerName: string;
  state: string;
  sessionId: string;
  message: string;
}

const RELAYABLE_STATES = new Set(["idle", "waiting", "error"]);

export function createPeerRelaySnapshot(input: { sessionId: string; state: string; updatedAt: string; messageText?: string }): PeerRelaySnapshot {
  const digest = input.messageText ? shortDigest(input.messageText) : undefined;
  return {
    sessionId: input.sessionId,
    state: input.state,
    updatedAt: input.updatedAt,
    relayKey: digest ? `${input.sessionId}:${input.state}:${digest}` : `${input.sessionId}:${input.state}`,
  };
}

export function shouldRelayPeerCompletion(previous: PeerRelaySnapshot | undefined, current: PeerRelaySnapshot): boolean {
  if (!RELAYABLE_STATES.has(current.state)) {
    return false;
  }
  return previous !== undefined && previous.relayKey !== current.relayKey;
}

export function shouldForceRelayPeerCompletion(previous: PeerRelaySnapshot | undefined, current: PeerRelaySnapshot): boolean {
  if (!RELAYABLE_STATES.has(current.state)) {
    return false;
  }
  return previous?.relayKey !== current.relayKey;
}

export function formatQuotedTextBlock(text: string, language = "text"): string {
  const longestBacktickRun = Math.max(...(text.match(/`+/g) ?? [""]).map((match) => match.length));
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return [`${fence}${language}`, text, fence].join("\n");
}

export function formatPeerCompletionTurn(input: PeerRelayMessageInput): string {
  const headline = input.state === "waiting"
    ? `Peer ${input.peerName} needs input.`
    : input.state === "error"
      ? `Peer ${input.peerName} failed.`
      : `Peer ${input.peerName} finished.`;

  return [
    `[peer_update name=${input.peerName} state=${input.state} session=${shortId(input.sessionId, 12)}]`,
    "Automated peer update.",
    "",
    `Peer: ${input.peerName}`,
    `State: ${input.state}`,
    `Session: ${shortId(input.sessionId, 12)}`,
    headline,
    "",
    "Latest peer message:",
    formatQuotedTextBlock(input.message),
    "",
    "Use this as internal orchestration context.",
    "Choose next step: continue orchestration, ask follow-up, or ignore if already handled.",
    "Do not quote this wrapper verbatim to the user.",
  ].join("\n");
}

function shortId(value: string, size: number): string {
  return value.length > size ? value.slice(0, size) : value;
}

// DJB2 hash — deterministic, no imports, 8 hex chars.
function shortDigest(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = (((hash << 5) + hash) ^ text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
