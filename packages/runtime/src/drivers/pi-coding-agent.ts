import type {
  AssistantDriverMessage,
  NormalizedDriverMessage,
  NormalizedDriverMessageBlock,
  NormalizedDriverUsage,
  ResultDriverMessage,
  SystemDriverMessage,
  ToolResultDriverMessage,
  ToolUseDriverMessage,
} from "./messages.js";
import type {
  DriverEventEnvelope,
  RuntimeDriver,
  RuntimeDriverRunHandle,
  RuntimeDriverRunInput,
} from "../types.js";

// ---------------------------------------------------------------------------
// AgentSessionEvent → NormalizedDriverMessage translation
// ---------------------------------------------------------------------------
//
// pi-coding-agent emits these event types through `session.subscribe(...)`:
//   agent_start, agent_end, turn_start, turn_end,
//   message_start, message_update, message_end,
//   tool_execution_start, tool_execution_update, tool_execution_end,
//   plus session-only events (queue_update, compaction_*, retry_*, etc.).
//
// We map them to the runtime's normalized stream this way:
//
//   tool_execution_start  → tool_use   (live request, before message_end fires)
//   message_end (assistant) → assistant (text/thinking/tool_use blocks)
//   message_end (toolResult) → tool_result
//   turn_end             → result      (per-turn usage from message.usage)
//   agent_end            → ignored     (covered by per-turn result events)
//
// Lifecycle events (turn_start, message_start, message_update,
// tool_execution_update, tool_execution_end) are intentionally dropped — they
// produce no additional runtime state and would only churn the transcript.
// See docs/pi-coding-agent-event-mapping.md for the full rationale.

interface AgentMessageContent {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  data?: string;
  mimeType?: string;
}

function toAssistantBlock(content: AgentMessageContent): NormalizedDriverMessageBlock | null {
  if (!content || typeof content !== "object") return null;
  if (content.type === "text") {
    return { type: "text", text: typeof content.text === "string" ? content.text : "", raw: content };
  }
  if (content.type === "thinking") {
    return { type: "thinking", text: typeof content.thinking === "string" ? content.thinking : "", raw: content };
  }
  if (content.type === "toolCall") {
    return {
      type: "tool_use",
      id: typeof content.id === "string" ? content.id : undefined,
      name: typeof content.name === "string" ? content.name : undefined,
      input: content.arguments,
      raw: content,
    };
  }
  return null;
}

function toContentBlock(content: AgentMessageContent): NormalizedDriverMessageBlock | null {
  if (!content || typeof content !== "object") return null;
  if (content.type === "text") {
    return { type: "text", text: typeof content.text === "string" ? content.text : "", raw: content };
  }
  if (content.type === "image") {
    return { type: "image", raw: content };
  }
  return null;
}

function extractAssistantText(message: Record<string, unknown> | undefined): string {
  if (!message) return "";
  const content = Array.isArray(message.content) ? (message.content as AgentMessageContent[]) : [];
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function toUsage(value: unknown): NormalizedDriverUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const u = value as Record<string, unknown>;
  const inputTokens = typeof u.input === "number" ? u.input : undefined;
  const outputTokens = typeof u.output === "number" ? u.output : undefined;
  const cacheReadInputTokens = typeof u.cacheRead === "number" ? u.cacheRead : undefined;
  const cacheCreationInputTokens = typeof u.cacheWrite === "number" ? u.cacheWrite : undefined;
  const cost = u.cost && typeof u.cost === "object" ? (u.cost as Record<string, unknown>) : undefined;
  const totalCostUsd = typeof cost?.total === "number" ? cost.total : undefined;
  const contextTokens = [inputTokens, cacheReadInputTokens, cacheCreationInputTokens]
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .reduce((sum, v) => sum + v, 0);
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    totalCostUsd,
    contextTokens: contextTokens > 0 ? contextTokens : undefined,
    raw: value,
  };
}

export function parsePiCodingAgentEvent(event: unknown): NormalizedDriverMessage[] {
  if (!event || typeof event !== "object") return [];
  const e = event as Record<string, unknown>;
  const type = String(e.type ?? "");

  if (type === "tool_execution_start") {
    return [{
      type: "tool_use",
      toolName: typeof e.toolName === "string" ? e.toolName : "unknown",
      toolUseId: typeof e.toolCallId === "string" ? e.toolCallId : undefined,
      input: e.args,
      raw: event,
    } satisfies ToolUseDriverMessage];
  }

  if (type === "message_end") {
    const message = e.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") return [];
    if (message.role === "assistant") {
      const content = Array.isArray(message.content) ? (message.content as AgentMessageContent[]) : [];
      const blocks = content
        .map(toAssistantBlock)
        .filter((b): b is NormalizedDriverMessageBlock => b != null);
      return [{
        type: "assistant",
        blocks,
        model: typeof message.model === "string" ? message.model : undefined,
        raw: event,
      } satisfies AssistantDriverMessage];
    }
    if (message.role === "toolResult") {
      const content = Array.isArray(message.content) ? (message.content as AgentMessageContent[]) : [];
      const blocks = content
        .map(toContentBlock)
        .filter((b): b is NormalizedDriverMessageBlock => b != null);
      return [{
        type: "tool_result",
        role: "user",
        toolName: typeof message.toolName === "string" ? message.toolName : "tool",
        toolUseId: typeof message.toolCallId === "string" ? message.toolCallId : undefined,
        output: message.content,
        isError: typeof message.isError === "boolean" ? message.isError : undefined,
        blocks: blocks.length > 0 ? blocks : undefined,
        raw: event,
      } satisfies ToolResultDriverMessage];
    }
    return [];
  }

  if (type === "turn_end") {
    const message = e.message as Record<string, unknown> | undefined;
    const summary = extractAssistantText(message);
    const stopReason = typeof message?.stopReason === "string" ? (message.stopReason as string) : undefined;
    const ok = stopReason !== "error" && stopReason !== "aborted";
    return [{
      type: "result",
      ok,
      summary,
      stopReason,
      usage: toUsage(message?.usage),
      raw: event,
    } satisfies ResultDriverMessage];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface PiCodingAgentSessionLike {
  readonly sessionId: string;
  subscribe(listener: (event: unknown) => void): () => void;
  prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<void>;
  abort?: () => Promise<void> | void;
  dispose?: () => void;
}

export interface PiCodingAgentSessionFactoryInput {
  cwd: string;
  prompt: string;
  model?: string;
  tools?: string[];
  env?: Record<string, string>;
  appendSystemPrompt?: string;
  resumeSessionId?: string;
  /**
   * Effective thinking level for this session. Resolved by the driver from
   * the per-call `RuntimeDriverRunInput.thinkingLevel` with a fallback to
   * `PiCodingAgentDriverOptions.defaultThinkingLevel`. Always set.
   */
  thinkingLevel: "off" | "low" | "medium" | "high";
}

export type PiCodingAgentSessionFactory = (
  input: PiCodingAgentSessionFactoryInput,
) => Promise<PiCodingAgentSessionLike>;

export interface PiCodingAgentDriverOptions {
  /** Inject a custom session factory (used by tests; otherwise the real SDK is loaded). */
  createSession?: PiCodingAgentSessionFactory;
  /** Default thinking level when none is configured. */
  defaultThinkingLevel?: "off" | "low" | "medium" | "high";
}

const DEFAULT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

async function defaultCreateSession(
  input: PiCodingAgentSessionFactoryInput,
): Promise<PiCodingAgentSessionLike> {
  // Dynamic import keeps the load lazy; the package is a hard dep of
  // pi-ca-leash so resolution should always succeed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdk: any;
  try {
    sdk = await import("@earendil-works/pi-coding-agent");
  } catch (error) {
    throw new Error(
      `pi-coding-agent driver requires @earendil-works/pi-coding-agent. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { createAgentSession, AuthStorage, ModelRegistry, SessionManager } = sdk;
  const modelRegistry = input.model ? ModelRegistry.create(AuthStorage.create()) : undefined;
  const model = input.model && modelRegistry ? resolvePiModel(modelRegistry, input.model) : undefined;
  // When the runtime hands us a resumeSessionId, restore the most recent
  // SDK session for this cwd so subsequent prompts inherit the prior
  // conversation history. The SDK keys session files by cwd-encoded path
  // under ~/.pi/agent/sessions/, and pi-ca-leash peers have a stable cwd
  // per peer name — so continueRecent(cwd) reliably picks the right one.
  const sessionManager = input.resumeSessionId
    ? SessionManager.continueRecent(input.cwd)
    : undefined;
  const { session } = await createAgentSession({
    cwd: input.cwd,
    tools: input.tools ?? DEFAULT_TOOLS,
    model,
    modelRegistry,
    thinkingLevel: input.thinkingLevel,
    sessionManager,
    sessionStartEvent: {
      type: "session_start",
      reason: input.resumeSessionId ? "resume" : "startup",
    },
  });
  return session as PiCodingAgentSessionLike;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolvePiModel(registry: any, modelName: string): unknown {
  const slash = modelName.indexOf("/");
  if (slash !== -1) {
    const provider = modelName.slice(0, slash);
    const id = modelName.slice(slash + 1);
    const model = registry.find(provider, id);
    if (!model) throw new Error(`Unknown pi-coding-agent model: ${modelName}`);
    return model;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const matches = registry.getAll().filter((m: any) => m.id === modelName || m.name === modelName);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Ambiguous pi-coding-agent model ${modelName}; use provider/model syntax (e.g. anthropic/${modelName})`);
  }
  throw new Error(`Unknown pi-coding-agent model: ${modelName}`);
}

export class PiCodingAgentDriver implements RuntimeDriver {
  readonly name = "pi-coding-agent" as const;

  private readonly createSession: PiCodingAgentSessionFactory;
  private readonly defaultThinkingLevel: "off" | "low" | "medium" | "high";

  constructor(options: PiCodingAgentDriverOptions = {}) {
    this.defaultThinkingLevel = options.defaultThinkingLevel ?? "high";
    this.createSession = options.createSession ?? defaultCreateSession;
  }

  run(
    input: RuntimeDriverRunInput,
    onEvent: (event: DriverEventEnvelope) => Promise<void> | void,
  ): RuntimeDriverRunHandle {
    let aborted = false;
    let session: PiCodingAgentSessionLike | undefined;

    // Serial delivery chain — subscribe callbacks fire synchronously; we
    // serialize them through this chain so onEvent invocations remain in
    // order and `done` only resolves after every delivery completes.
    let deliveryChain: Promise<void> = Promise.resolve();
    function deliver(envelope: DriverEventEnvelope): void {
      deliveryChain = deliveryChain.then(async () => {
        try {
          await onEvent(envelope);
        } catch {
          // swallow handler errors to keep the chain alive
        }
      });
    }

    // Resolve per-call thinking level with a fallback to the driver default.
    // Downstream consumers (e.g. pi-ca-leash event log) can audit what
    // actually landed on the wire via the `thinkingLevel` field echoed on
    // the init system event below.
    const effectiveThinkingLevel = input.thinkingLevel ?? this.defaultThinkingLevel;

    const done = (async () => {
      try {
        session = await this.createSession({
          cwd: input.cwd,
          prompt: input.prompt,
          model: input.model,
          tools: input.tools,
          env: input.env,
          appendSystemPrompt: input.appendSystemPrompt,
          resumeSessionId: input.resumeSessionId,
          thinkingLevel: effectiveThinkingLevel,
        });

        // pi-coding-agent has no native sandbox. Echo the requested
        // securityMode and explicitly note it is not enforced, so audit
        // consumers can flag callers relying on a security guarantee that
        // does not exist for this driver.
        const requestedSecurityMode = input.securityMode ?? "safe";
        deliver({
          type: "message",
          payload: {
            type: "system",
            subtype: "init",
            sessionId: session.sessionId,
            cwd: input.cwd,
            model: input.model,
            raw: {
              sessionId: session.sessionId,
              thinkingLevel: effectiveThinkingLevel,
              thinkingLevelSource: input.thinkingLevel ? "per-call" : "default",
              securityMode: requestedSecurityMode,
              securityModeEnforced: false,
              securityModeNote:
                "pi-coding-agent has no native sandbox; securityMode is echoed for audit but not enforced. Use the `tools` allowlist to limit capability.",
            },
          } satisfies SystemDriverMessage,
        });

        const unsubscribe = session.subscribe((event) => {
          if (aborted) return;
          for (const normalized of parsePiCodingAgentEvent(event)) {
            deliver({ type: "message", payload: normalized });
          }
        });

        try {
          await session.prompt(input.prompt, { expandPromptTemplates: false });
        } finally {
          unsubscribe();
        }

        await deliveryChain;
        return { code: aborted ? 130 : 0, signal: aborted ? ("SIGINT" as NodeJS.Signals) : null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deliver({
          type: "error",
          payload: { message, code: "PI_CODING_AGENT_ERROR" },
        });
        await deliveryChain;
        return { code: 1, signal: null as NodeJS.Signals | null };
      } finally {
        try {
          session?.dispose?.();
        } catch {
          // ignore dispose errors
        }
      }
    })();

    return {
      kill(_signal?: NodeJS.Signals) {
        aborted = true;
        // session.abort() may be a Promise; we don't await it here. The
        // caller drives shutdown through `done`, which awaits the in-flight
        // prompt() and any pending deliveries.
        void session?.abort?.();
      },
      done,
    };
  }
}
