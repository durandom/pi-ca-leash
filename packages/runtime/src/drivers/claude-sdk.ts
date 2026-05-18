import type {
  AssistantDriverMessage,
  NormalizedDriverMessage,
  NormalizedDriverMessageBlock,
  NormalizedDriverUsage,
  StreamEventDriverMessage,
  SystemDriverMessage,
  ToolResultDriverMessage,
  ToolUseDriverMessage,
} from "./messages.js";
import type { DriverEventEnvelope, RuntimeDriver, RuntimeDriverRunHandle, RuntimeDriverRunInput } from "../types.js";
import { enrichInitWithCapabilities, foldThinkingLevelForClaude } from "./thinking.js";

function parseJsonOrRaw(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

interface ChildExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Try to locate the SDK's underlying native child process on the query
 * object and listen for its death. Returns a detach callback. The SDK does
 * not promise this shape, so we probe defensively: if the field is missing
 * or doesn't quack like an EventEmitter, we log once and return a noop —
 * the run will still complete normally on the cooperative path. Issue #7.
 */
/** @internal exported for tests; not part of the public driver surface */
export function attachChildDeathWatchdog(
  request: unknown,
  graceMs: number,
  controller: AbortController,
  onDeath: (info: ChildExitInfo) => void | Promise<void>,
): () => void {
  const candidates = ["subprocess", "process", "child"] as const;
  const handle = candidates
    .map((key) => (request as Record<string, unknown> | null)?.[key])
    .find((value): value is { once: Function; off?: Function; removeListener?: Function } => {
      return Boolean(value) && typeof (value as { once?: unknown }).once === "function";
    });

  if (!handle) {
    if (!childHandleProbeWarned) {
      childHandleProbeWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[pi-ca-leash] claude-agent-sdk query has no reachable subprocess handle; " +
          "external SIGKILL of the native child may wedge sessions (issue #7).",
      );
    }
    return () => {};
  }

  let fired = false;
  let timer: NodeJS.Timeout | undefined;
  const listener = (code: number | null, signal: NodeJS.Signals | null) => {
    if (fired) return;
    fired = true;
    void onDeath({ code, signal });
    timer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort();
    }, graceMs);
    if (typeof timer.unref === "function") timer.unref();
  };

  handle.once("close", listener);
  handle.once("exit", listener);

  return () => {
    if (timer) clearTimeout(timer);
    const off = handle.off ?? handle.removeListener;
    if (typeof off === "function") {
      off.call(handle, "close", listener);
      off.call(handle, "exit", listener);
    }
  };
}

type StreamUserMessage = {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
  session_id: string;
};

class MessageStream implements AsyncIterable<StreamUserMessage> {
  private readonly queue: StreamUserMessage[] = [];
  private readonly waiters: Array<() => void> = [];
  private ended = false;

  push(text: string): void {
    this.queue.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    });
    this.waiters.splice(0).forEach((wake) => wake());
  }

  end(): void {
    this.ended = true;
    this.waiters.splice(0).forEach((wake) => wake());
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.ended) {
        return;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

function toBlock(block: unknown): NormalizedDriverMessageBlock {
  const item = block as Record<string, unknown>;
  return {
    type: String(item.type ?? item.constructor?.name ?? "unknown"),
    text: typeof item.text === "string" ? item.text : undefined,
    name: typeof item.name === "string" ? item.name : undefined,
    id: typeof item.id === "string" ? item.id : undefined,
    input: item.input,
    content: item.content,
    isError: typeof item.is_error === "boolean" ? item.is_error : typeof item.isError === "boolean" ? item.isError : undefined,
    raw: item,
  };
}

function toUsage(usage: unknown, totalCostUsd?: unknown, modelUsage?: unknown): NormalizedDriverUsage | undefined {
  if (!usage || typeof usage !== "object") {
    return typeof totalCostUsd === "number" ? { totalCostUsd } : undefined;
  }
  const value = usage as Record<string, unknown>;
  const inputTokens = typeof value.input_tokens === "number" ? value.input_tokens : undefined;
  const outputTokens = typeof value.output_tokens === "number" ? value.output_tokens : undefined;
  const cacheCreationInputTokens = typeof value.cache_creation_input_tokens === "number"
    ? value.cache_creation_input_tokens
    : undefined;
  const cacheReadInputTokens = typeof value.cache_read_input_tokens === "number" ? value.cache_read_input_tokens : undefined;
  const reasoningOutputTokens = typeof value.reasoning_output_tokens === "number" ? value.reasoning_output_tokens : undefined;
  const modelUsageValues = modelUsage && typeof modelUsage === "object" ? Object.values(modelUsage as Record<string, unknown>) : [];
  const modelContextWindows = modelUsageValues
    .map((entry) => entry && typeof entry === "object" ? (entry as Record<string, unknown>).contextWindow : undefined)
    .filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
  const modelMaxOutputTokens = modelUsageValues
    .map((entry) => entry && typeof entry === "object" ? (entry as Record<string, unknown>).maxOutputTokens : undefined)
    .filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
  const contextWindow = modelContextWindows.length > 0 ? Math.max(...modelContextWindows) : undefined;
  const maxOutputTokens = modelMaxOutputTokens.length > 0 ? Math.max(...modelMaxOutputTokens) : undefined;
  const contextTokens = [inputTokens, cacheCreationInputTokens, cacheReadInputTokens]
    .filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
    .reduce((sum, entry) => sum + entry, 0);

  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    reasoningOutputTokens,
    totalCostUsd: typeof totalCostUsd === "number" ? totalCostUsd : undefined,
    contextTokens: contextTokens > 0 ? contextTokens : undefined,
    contextWindow,
    contextPercentage: contextWindow && contextTokens > 0 ? Math.round((contextTokens / contextWindow) * 1000) / 10 : undefined,
    maxOutputTokens,
    raw: usage,
  };
}

function parseAssistantMessage(message: Record<string, unknown>, raw: unknown): NormalizedDriverMessage[] {
  const blocks = (Array.isArray(message.content) ? message.content : []).map(toBlock);
  const result: NormalizedDriverMessage[] = [
    {
      type: "assistant",
      blocks,
      model: typeof message.model === "string" ? message.model : undefined,
      raw,
    } satisfies AssistantDriverMessage,
  ];

  for (const block of blocks) {
    if (block.type === "tool_use") {
      result.push({
        type: "tool_use",
        toolName: block.name ?? "unknown",
        toolUseId: block.id,
        input: block.input,
        raw: block.raw,
      } satisfies ToolUseDriverMessage);
    }
  }

  return result;
}

function parseUserMessage(message: Record<string, unknown>, raw: unknown, toolUseResult: unknown): NormalizedDriverMessage[] {
  const blocks = (Array.isArray(message.content) ? message.content : []).map(toBlock);
  const toolResultBlock = blocks.find((block) => block.type === "tool_result");
  if (!toolResultBlock) {
    return [];
  }

  const toolResult = toolUseResult && typeof toolUseResult === "object"
    ? toolUseResult as Record<string, unknown>
    : undefined;
  return [{
    type: "tool_result",
    role: "user",
    blocks,
    toolName: typeof toolResult?.tool_name === "string" ? toolResult.tool_name : toolResultBlock.name ?? "tool",
    toolUseId: typeof (toolResultBlock.raw as Record<string, unknown> | undefined)?.tool_use_id === "string"
      ? String((toolResultBlock.raw as Record<string, unknown>).tool_use_id)
      : undefined,
    output: toolResult ?? toolResultBlock.content,
    isError: toolResultBlock.isError,
    raw,
  } satisfies ToolResultDriverMessage];
}

export function parseClaudeSdkMessage(message: unknown): NormalizedDriverMessage[] {
  if (!message || typeof message !== "object") {
    return [];
  }
  const item = message as Record<string, unknown>;
  const type = String(item.type ?? item.constructor?.name ?? "");

  if (type === "system" || type === "SystemMessage") {
    return [{
      type: "system",
      subtype: typeof item.subtype === "string" ? item.subtype : undefined,
      sessionId: typeof item.session_id === "string" ? item.session_id : typeof item.sessionId === "string" ? item.sessionId : undefined,
      cwd: typeof item.cwd === "string" ? item.cwd : undefined,
      model: typeof item.model === "string" ? item.model : undefined,
      metadata: { ...((item.data as Record<string, unknown> | undefined) ?? {}) },
      raw: message,
    } satisfies SystemDriverMessage];
  }

  if (type === "assistant" || type === "AssistantMessage") {
    const assistant = (item.message as Record<string, unknown> | undefined) ?? item;
    return parseAssistantMessage(assistant, message);
  }

  if (type === "user" || type === "UserMessage") {
    const user = (item.message as Record<string, unknown> | undefined) ?? item;
    return parseUserMessage(user, message, item.tool_use_result);
  }

  if (type === "result" || type === "ResultMessage") {
    return [{
      type: "result",
      ok: !Boolean(item.is_error ?? item.isError),
      summary: typeof item.result === "string" ? item.result : JSON.stringify(item.result ?? ""),
      stopReason: typeof item.stop_reason === "string" ? item.stop_reason : undefined,
      usage: toUsage(item.usage, item.total_cost_usd ?? item.totalCostUsd, item.modelUsage),
      raw: message,
    }];
  }

  if (type === "error" || type === "ErrorMessage") {
    return [{
      type: "error",
      message: typeof item.message === "string" ? item.message : JSON.stringify(item),
      code: typeof item.code === "string" ? item.code : undefined,
      raw: message,
    }];
  }

  if (["rate_limit_event", "task_notification", "compact_boundary"].includes(type)) {
    return [{
      type: "stream_event",
      summary: String(item.summary ?? item.subtype ?? type),
      metadata: {
        eventType: type,
        sessionId: item.session_id ?? item.sessionId,
      },
      raw: message,
    } satisfies StreamEventDriverMessage];
  }

  return [];
}

export interface ClaudeSdkDriverOptions {
  /**
   * Grace window (ms) between observing the SDK's native child exit and
   * aborting the in-process iterator. Lets in-flight messages drain. Issue #7.
   */
  childDeathGraceMs?: number;
}

const DEFAULT_CHILD_DEATH_GRACE_MS = 5_000;
let childHandleProbeWarned = false;

export class ClaudeSdkDriver implements RuntimeDriver {
  readonly name = "claude-sdk" as const;
  private readonly childDeathGraceMs: number;

  constructor(options: ClaudeSdkDriverOptions = {}) {
    this.childDeathGraceMs = options.childDeathGraceMs ?? DEFAULT_CHILD_DEATH_GRACE_MS;
  }

  run(input: RuntimeDriverRunInput, onEventRaw: (event: DriverEventEnvelope) => Promise<void> | void): RuntimeDriverRunHandle {
    // Echo the effective thinking budget on the upstream init event so audit
    // consumers can detect silent drops / folds without a probe. The fold is
    // an identity here (Claude SDK uses the runtime vocabulary natively) but
    // we record it explicitly to keep the audit surface uniform across
    // drivers (issues #6, follow-up).
    const effort = input.thinkingLevel
      ? foldThinkingLevelForClaude(input.thinkingLevel)
      : undefined;
    const onEvent = enrichInitWithCapabilities(onEventRaw, {
      thinkingLevelSupported: true,
      requestedThinkingLevel: input.thinkingLevel,
      effectiveThinkingLevel: effort,
    });
    const controller = new AbortController();
    // Hoisted out of the try so the catch block can read it. See issue #7.
    const childDiedFlag = { value: false };

    const done = (async () => {
      try {
        let sdk: any;
        try {
          sdk = await import("@anthropic-ai/claude-agent-sdk");
        } catch (error) {
          await onEvent({
            type: "error",
            payload: {
              message: `Claude Agent SDK not found. Install @anthropic-ai/claude-agent-sdk. ${error instanceof Error ? error.message : String(error)}`,
              code: "CLAUDE_SDK_MISSING",
            },
          });
          return { code: 1, signal: null };
        }

        const promptStream = new MessageStream();
        promptStream.push(input.prompt);
        promptStream.end();

        const request = sdk.query({
          prompt: promptStream,
          options: this.buildOptions(input),
        });

        // Issue #7: when a host externally SIGKILLs the SDK's native child,
        // the async iterator never settles (no Node-level close event because
        // we don't own the child handle). If we can reach the SDK's
        // subprocess, listen for its death and abort the iterator so the run
        // transitions to `failed` instead of wedging at `state="running"`.
        const detachChildWatchdog = attachChildDeathWatchdog(request, this.childDeathGraceMs, controller, async (info) => {
          childDiedFlag.value = true;
          await onEvent({
            type: "error",
            payload: {
              message: `claude-agent-sdk child exited unexpectedly (code=${info.code ?? "null"} signal=${info.signal ?? "null"})`,
              code: "CLAUDE_SDK_CHILD_DIED",
            },
          });
        });

        const onAbort = () => {
          void request.close?.();
          void request.interrupt?.();
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });

        try {
          for await (const message of request) {
            if (controller.signal.aborted) {
              throw abortError();
            }
            for (const normalized of parseClaudeSdkMessage(message)) {
              await onEvent({ type: "message", payload: normalized });
            }
          }
          return { code: 0, signal: null };
        } finally {
          controller.signal.removeEventListener("abort", onAbort);
          detachChildWatchdog();
          await request.close?.();
        }
      } catch (error) {
        if ((error as Error)?.name === "AbortError") {
          if (childDiedFlag.value) {
            return { code: 137, signal: "SIGKILL" as const };
          }
          return { code: 130, signal: "SIGINT" as const };
        }
        const message = enrichClaudeSdkErrorMessage(error instanceof Error ? error.message : String(error), input.model);
        await onEvent({
          type: "error",
          payload: {
            message,
            code: "CLAUDE_SDK_ERROR",
          },
        });
        return { code: 1, signal: null };
      }
    })();

    return {
      kill() {
        controller.abort();
      },
      done,
    };
  }

  private buildOptions(input: RuntimeDriverRunInput): Record<string, unknown> {
    // securityMode mapping: yolo → bypassPermissions, safe → default.
    // Default kept at yolo for historical parity with non-interactive runs.
    const securityMode = input.securityMode ?? "yolo";
    const permissionMode = securityMode === "yolo" ? "bypassPermissions" : "default";
    const result: Record<string, unknown> = {
      cwd: input.cwd,
      permissionMode,
      allowDangerouslySkipPermissions: securityMode === "yolo",
      settingSources: ["project", "user"],
    };
    if (input.env) {
      result.env = input.env;
    }
    if (process.env.CLAUDE_CODE_EXECUTABLE) {
      result.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_EXECUTABLE;
    }
    if (input.resumeSessionId) {
      result.resume = input.resumeSessionId;
    }
    if (input.model) {
      result.model = input.model;
    }
    if (input.appendSystemPrompt != null) {
      result.systemPrompt = { type: "preset", preset: "claude_code", append: input.appendSystemPrompt };
    }
    if (input.thinkingLevel) {
      // Claude SDK option name is `effort`; vocabulary matches runtime.
      result.effort = foldThinkingLevelForClaude(input.thinkingLevel);
    }
    if (input.tools?.length) {
      result.allowedTools = input.tools;
    }
    if (input.additionalDirectories?.length) {
      result.additionalDirectories = input.additionalDirectories;
    }
    if (process.env.CLAUDE_SDK_OUTPUT_FORMAT) {
      result.outputFormat = parseJsonOrRaw(process.env.CLAUDE_SDK_OUTPUT_FORMAT);
    }
    return result;
  }
}

function enrichClaudeSdkErrorMessage(message: string, model?: string): string {
  const lower = message.toLowerCase();
  const hints: string[] = [];

  if (lower.includes("native binary not found") || lower.includes("claude code") && lower.includes("not found")) {
    hints.push("Install Claude Code or set CLAUDE_CODE_EXECUTABLE to the native binary path.");
  }
  if (lower.includes("bedrock")) {
    hints.push("This model/provider appears to route through Amazon Bedrock; use a fully qualified model id from runtime_models or configure Bedrock credentials.");
  }
  if (lower.includes("api key") || lower.includes("apikey") || lower.includes("unauthorized")) {
    hints.push("Provider credentials are missing or rejected for this runtime/model.");
  }
  if (lower.includes("prompt is too long") || lower.includes("prompt too long") || lower.includes("context length")) {
    hints.push("Split the task into smaller slices or ask the peer to inspect files instead of pasting large context.");
  }
  if (model && /^(opus|sonnet|haiku)$/i.test(model.trim())) {
    hints.push(`"${model}" is a shorthand alias; pass the full Claude model id to the runtime.`);
  }

  if (hints.length === 0) {
    return message;
  }
  return [message, ...[...new Set(hints)].map((hint) => `Hint: ${hint}`)].join("\n");
}
