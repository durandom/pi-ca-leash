import type { RuntimeDriverName } from "@pi-claude-code-agent/runtime";

export interface RuntimeModelCatalogEntry {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  inputModalities: string[];
  inputCostPerMillion: number;
  outputCostPerMillion: number;
}

export interface RuntimeDriverModelCatalog {
  driver: RuntimeDriverName;
  provider: "anthropic" | "openai-codex";
  defaultModel: string;
  cli: string;
  flag: string;
  source: string;
  models: RuntimeModelCatalogEntry[];
}

const LANISTA_SOURCE = "lanista agents anthropic/codex";

export const RUNTIME_MODEL_CATALOGS: Record<RuntimeDriverName, RuntimeDriverModelCatalog> = {
  "claude-sdk": {
    driver: "claude-sdk",
    provider: "anthropic",
    defaultModel: "claude-opus-4-7",
    cli: "claude-code",
    flag: "claude --model <id>",
    source: LANISTA_SOURCE,
    models: [
      { id: "claude-3-5-haiku-20241022", name: "Claude Haiku 3.5", contextWindow: 200000, maxTokens: 8192, reasoning: false, inputModalities: ["text", "image"], inputCostPerMillion: 0.8, outputCostPerMillion: 4 },
      { id: "claude-3-5-haiku-latest", name: "Claude Haiku 3.5 (latest)", contextWindow: 200000, maxTokens: 8192, reasoning: false, inputModalities: ["text", "image"], inputCostPerMillion: 0.8, outputCostPerMillion: 4 },
      { id: "claude-3-5-sonnet-20240620", name: "Claude Sonnet 3.5", contextWindow: 200000, maxTokens: 8192, reasoning: false, inputModalities: ["text", "image"], inputCostPerMillion: 3, outputCostPerMillion: 15 },
      { id: "claude-3-5-sonnet-20241022", name: "Claude Sonnet 3.5 v2", contextWindow: 200000, maxTokens: 8192, reasoning: false, inputModalities: ["text", "image"], inputCostPerMillion: 3, outputCostPerMillion: 15 },
      { id: "claude-3-7-sonnet-20250219", name: "Claude Sonnet 3.7", contextWindow: 200000, maxTokens: 64000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 3, outputCostPerMillion: 15 },
      { id: "claude-3-haiku-20240307", name: "Claude Haiku 3", contextWindow: 200000, maxTokens: 4096, reasoning: false, inputModalities: ["text", "image"], inputCostPerMillion: 0.25, outputCostPerMillion: 1.25 },
      { id: "claude-3-opus-20240229", name: "Claude Opus 3", contextWindow: 200000, maxTokens: 4096, reasoning: false, inputModalities: ["text", "image"], inputCostPerMillion: 15, outputCostPerMillion: 75 },
      { id: "claude-3-sonnet-20240229", name: "Claude Sonnet 3", contextWindow: 200000, maxTokens: 4096, reasoning: false, inputModalities: ["text", "image"], inputCostPerMillion: 3, outputCostPerMillion: 15 },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5 (latest)", contextWindow: 200000, maxTokens: 64000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 1, outputCostPerMillion: 5 },
      { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", contextWindow: 200000, maxTokens: 64000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 1, outputCostPerMillion: 5 },
      { id: "claude-opus-4-0", name: "Claude Opus 4 (latest)", contextWindow: 200000, maxTokens: 32000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 15, outputCostPerMillion: 75 },
      { id: "claude-opus-4-1", name: "Claude Opus 4.1 (latest)", contextWindow: 200000, maxTokens: 32000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 15, outputCostPerMillion: 75 },
      { id: "claude-opus-4-1-20250805", name: "Claude Opus 4.1", contextWindow: 200000, maxTokens: 32000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 15, outputCostPerMillion: 75 },
      { id: "claude-opus-4-20250514", name: "Claude Opus 4", contextWindow: 200000, maxTokens: 32000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 15, outputCostPerMillion: 75 },
      { id: "claude-opus-4-5", name: "Claude Opus 4.5 (latest)", contextWindow: 200000, maxTokens: 64000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 5, outputCostPerMillion: 25 },
      { id: "claude-opus-4-5-20251101", name: "Claude Opus 4.5", contextWindow: 200000, maxTokens: 64000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 5, outputCostPerMillion: 25 },
      { id: "claude-opus-4-6", name: "Claude Opus 4.6", contextWindow: 1000000, maxTokens: 128000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 5, outputCostPerMillion: 25 },
      { id: "claude-opus-4-7", name: "Claude Opus 4.7", contextWindow: 1000000, maxTokens: 128000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 5, outputCostPerMillion: 25 },
      { id: "claude-sonnet-4-0", name: "Claude Sonnet 4 (latest)", contextWindow: 200000, maxTokens: 64000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 3, outputCostPerMillion: 15 },
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", contextWindow: 200000, maxTokens: 64000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 3, outputCostPerMillion: 15 },
      { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5 (latest)", contextWindow: 200000, maxTokens: 64000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 3, outputCostPerMillion: 15 },
      { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", contextWindow: 200000, maxTokens: 64000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 3, outputCostPerMillion: 15 },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 1000000, maxTokens: 64000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 3, outputCostPerMillion: 15 },
    ],
  },
  "codex-cli": {
    driver: "codex-cli",
    provider: "openai-codex",
    defaultModel: "gpt-5.5",
    cli: "codex",
    flag: "codex --model <id>",
    source: LANISTA_SOURCE,
    models: [
      { id: "gpt-5.1", name: "GPT-5.1", contextWindow: 272000, maxTokens: 128000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 1.25, outputCostPerMillion: 10 },
      { id: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max", contextWindow: 272000, maxTokens: 128000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 1.25, outputCostPerMillion: 10 },
      { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini", contextWindow: 272000, maxTokens: 128000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 0.25, outputCostPerMillion: 2 },
      { id: "gpt-5.2", name: "GPT-5.2", contextWindow: 272000, maxTokens: 128000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 1.75, outputCostPerMillion: 14 },
      { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", contextWindow: 272000, maxTokens: 128000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 1.75, outputCostPerMillion: 14 },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", contextWindow: 272000, maxTokens: 128000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 1.75, outputCostPerMillion: 14 },
      { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", contextWindow: 128000, maxTokens: 128000, reasoning: true, inputModalities: ["text"], inputCostPerMillion: 0, outputCostPerMillion: 0 },
      { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 272000, maxTokens: 128000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 2.5, outputCostPerMillion: 15 },
      { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", contextWindow: 272000, maxTokens: 128000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 0.75, outputCostPerMillion: 4.5 },
      { id: "gpt-5.5", name: "GPT-5.5", contextWindow: 272000, maxTokens: 128000, reasoning: true, inputModalities: ["text", "image"], inputCostPerMillion: 5, outputCostPerMillion: 30 },
    ],
  },
};

export function modelCatalogsForDriver(driver?: RuntimeDriverName): RuntimeDriverModelCatalog[] {
  if (driver) {
    return [RUNTIME_MODEL_CATALOGS[driver]];
  }
  return [RUNTIME_MODEL_CATALOGS["claude-sdk"], RUNTIME_MODEL_CATALOGS["codex-cli"]];
}

export function findRuntimeModel(driver: RuntimeDriverName, model: string): RuntimeModelCatalogEntry | undefined {
  const normalized = model.trim();
  return RUNTIME_MODEL_CATALOGS[driver].models.find((entry) => entry.id === normalized);
}

export function describeModelSelection(driver: RuntimeDriverName, model?: string): string | undefined {
  if (!model) {
    return `model default ${RUNTIME_MODEL_CATALOGS[driver].defaultModel}`;
  }
  const entry = findRuntimeModel(driver, model);
  if (!entry) {
    return `model ${model} not in bundled ${RUNTIME_MODEL_CATALOGS[driver].provider} catalog; passing through to runtime`;
  }
  return `model ${entry.id} (${entry.name}, ctx ${entry.contextWindow}, max ${entry.maxTokens})`;
}
