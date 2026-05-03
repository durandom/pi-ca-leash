const ROLE_KEYWORDS: Array<{ tokens: string[]; name: string }> = [
  { tokens: ["review", "reviewer"], name: "reviewer" },
  { tokens: ["fix", "bug", "debug", "repair"], name: "fixer" },
  { tokens: ["research", "investigate", "explore"], name: "researcher" },
  { tokens: ["test", "qa", "verify"], name: "tester" },
  { tokens: ["build", "compile"], name: "builder" },
  { tokens: ["document", "docs", "write"], name: "writer" },
  { tokens: ["plan", "design"], name: "planner" },
  { tokens: ["search", "find", "grep"], name: "searcher" },
  { tokens: ["refactor", "cleanup", "clean"], name: "cleaner" },
];

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "brief",
  "can",
  "code",
  "concise",
  "direct",
  "do",
  "exactly",
  "file",
  "for",
  "from",
  "help",
  "in",
  "into",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "please",
  "prompt",
  "reply",
  "role",
  "task",
  "that",
  "the",
  "this",
  "to",
  "use",
  "with",
  "you",
  "your",
]);

export interface ParsedPeerStartInput {
  name?: string;
  prompt?: string;
  autoNamed: boolean;
}

export function parsePeerStartInput(args: string): ParsedPeerStartInput {
  const parts = args.split("|").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return { autoNamed: false };
  }
  if (parts.length === 1) {
    return {
      prompt: parts[0],
      autoNamed: true,
    };
  }
  return {
    name: parts[0],
    prompt: parts.slice(1).join(" | "),
    autoNamed: false,
  };
}

export function derivePeerName(prompt: string, existingNames: Iterable<string>): string {
  const existing = new Set([...existingNames].map((name) => name.toLowerCase()));
  const normalized = prompt.toLowerCase();

  for (const candidate of ROLE_KEYWORDS) {
    if (candidate.tokens.some((token) => normalized.includes(token))) {
      return ensureUniqueName(candidate.name, existing);
    }
  }

  const roleMatch = normalized.match(/you are (?:an? )?(?:\w+\s+){0,2}(\w+)/i);
  const roleToken = sanitizeToken(roleMatch?.[1]);
  if (roleToken && !STOP_WORDS.has(roleToken)) {
    return ensureUniqueName(roleToken, existing);
  }

  const tokens = normalized
    .split(/[^a-z0-9]+/)
    .map((token) => sanitizeToken(token))
    .filter((token): token is string => Boolean(token && !STOP_WORDS.has(token)));

  for (const token of tokens) {
    if (token.length >= 3) {
      return ensureUniqueName(token, existing);
    }
  }

  return ensureUniqueName("peer", existing);
}

function ensureUniqueName(base: string, existing: Set<string>): string {
  const normalizedBase = sanitizeToken(base) ?? "peer";
  if (!existing.has(normalizedBase)) {
    return normalizedBase;
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${normalizedBase}-${suffix}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  return `${normalizedBase}-${Date.now()}`;
}

function sanitizeToken(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || undefined;
}
