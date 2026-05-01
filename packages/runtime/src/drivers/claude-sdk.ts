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

function toUsage(usage: unknown, totalCostUsd?: unknown): NormalizedDriverUsage | undefined {
  if (!usage || typeof usage !== "object") {
    return typeof totalCostUsd === "number" ? { totalCostUsd } : undefined;
  }
  const value = usage as Record<string, unknown>;
  return {
    inputTokens: typeof value.input_tokens === "number" ? value.input_tokens : undefined,
    outputTokens: typeof value.output_tokens === "number" ? value.output_tokens : undefined,
    cacheCreationInputTokens: typeof value.cache_creation_input_tokens === "number"
      ? value.cache_creation_input_tokens
      : undefined,
    cacheReadInputTokens: typeof value.cache_read_input_tokens === "number" ? value.cache_read_input_tokens : undefined,
    totalCostUsd: typeof totalCostUsd === "number" ? totalCostUsd : undefined,
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
      usage: toUsage(item.usage, item.total_cost_usd ?? item.totalCostUsd),
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

export class ClaudeSdkDriver implements RuntimeDriver {
  readonly name = "claude-sdk" as const;

  run(input: RuntimeDriverRunInput, onEvent: (event: DriverEventEnvelope) => Promise<void> | void): RuntimeDriverRunHandle {
    const controller = new AbortController();

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
          await request.close?.();
        }
      } catch (error) {
        if ((error as Error)?.name === "AbortError") {
          return { code: 130, signal: "SIGINT" as const };
        }
        await onEvent({
          type: "error",
          payload: {
            message: error instanceof Error ? error.message : String(error),
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
    const result: Record<string, unknown> = {
      cwd: input.cwd,
      permissionMode: input.permissionMode ?? "bypassPermissions",
      allowDangerouslySkipPermissions: true,
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
