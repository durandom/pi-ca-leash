type DriverMessage = {
  type: string;
  content?: string;
  metadata?: Record<string, unknown>;
};

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

function parseAssistantBlocks(blocks: unknown[], model?: unknown): DriverMessage[] {
  return blocks.flatMap((block): DriverMessage[] => {
    const item = block as Record<string, unknown>;
    const type = String(item.type ?? item.constructor?.name ?? "");
    if (type === "text" || type === "TextBlock") {
      return [{ type: "assistant", content: String(item.text ?? ""), metadata: { model } }];
    }
    if (type === "tool_use" || type === "ToolUseBlock") {
      return [{
        type: "tool_use",
        content: `Using tool: ${String(item.name ?? "")}`,
        metadata: { tool_name: item.name, tool_input: item.input, tool_use_id: item.id },
      }];
    }
    if (type === "tool_result" || type === "ToolResultBlock") {
      const content = typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? "");
      return [{
        type: "tool_result",
        content,
        metadata: { tool_use_id: item.tool_use_id ?? item.toolUseId, is_error: item.is_error ?? item.isError ?? false },
      }];
    }
    if (type === "thinking" || type === "ThinkingBlock") {
      return [{ type: "assistant", content: `[thinking] ${String(item.thinking ?? "")}`, metadata: { thinking: true } }];
    }
    return [];
  });
}

export function parseClaudeSdkMessage(message: unknown): DriverMessage[] {
  if (!message || typeof message !== "object") {
    return [];
  }
  const item = message as Record<string, unknown>;
  const type = String(item.type ?? item.constructor?.name ?? "");

  if (type === "system" || type === "SystemMessage") {
    const metadata = { subtype: item.subtype, ...((item.data as Record<string, unknown> | undefined) ?? {}) } as Record<string, unknown>;
    if (item.session_id || item.sessionId) {
      metadata.session_id = item.session_id ?? item.sessionId;
    }
    if (item.cwd) {
      metadata.cwd = item.cwd;
    }
    if (item.model) {
      metadata.model = item.model;
    }
    return [{ type: "system", content: "", metadata }];
  }

  if (type === "assistant" || type === "AssistantMessage") {
    const assistant = (item.message as Record<string, unknown> | undefined) ?? item;
    const blocks = Array.isArray(assistant.content) ? assistant.content : Array.isArray(item.content) ? item.content : [];
    return parseAssistantBlocks(blocks, assistant.model ?? item.model);
  }

  if (type === "result" || type === "ResultMessage") {
    return [{
      type: "result",
      content: String(item.result ?? ""),
      metadata: {
        session_id: item.session_id ?? item.sessionId,
        is_error: item.is_error ?? item.isError,
        duration_ms: item.duration_ms ?? item.durationMs,
        total_cost_usd: item.total_cost_usd ?? item.totalCostUsd,
        num_turns: item.num_turns ?? item.numTurns,
        usage: item.usage,
      },
    }];
  }

  if (type === "user" || type === "UserMessage") {
    return [];
  }

  if (["rate_limit_event", "task_notification", "compact_boundary"].includes(type)) {
    return [{
      type: "stream_event",
      content: String(item.summary ?? item.subtype ?? type),
      metadata: { event_type: type, session_id: item.session_id ?? item.sessionId },
    }];
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
            await onEvent({ type: "raw", payload: message });
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
