export type CaptureSafetyReason =
  | "empty"
  | "injected-context"
  | "system-wrapper"
  | "context-compaction"
  | "operational-trace"
  | "secret"
  | "trivial";

export interface CaptureSafetyDecision {
  allowed: boolean;
  reason?: CaptureSafetyReason;
  pattern?: string;
}

type SecretPattern = {
  name: string;
  re: RegExp;
  valueIndex?: number;
};

function looksLikePlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    value.includes("${") ||
    value.includes("...") ||
    lower.includes("example") ||
    lower.includes("placeholder") ||
    lower.includes("dummy") ||
    lower.includes("redacted") ||
    lower.includes("test-key") ||
    lower.includes("your-key") ||
    lower.includes("changeme") ||
    value.includes("****")
  );
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: "private-key-block",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  },
  {
    name: "authorization-bearer",
    re: /\bAuthorization\s*:\s*Bearer\s+([A-Za-z0-9._~+/=-]{12,})(?=$|\s|[,;])/i,
    valueIndex: 1,
  },
  {
    name: "credentialed-url",
    re: /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:([^@\s/]+)@[^/\s]+/i,
    valueIndex: 1,
  },
  {
    name: "password-assignment-quoted-special",
    re: /\b(?:password|passwd|pwd)\b\s*[:=]\s*["'`](?=[^"'`\r\n]*[^A-Za-z0-9\s])([^"'`\r\n]{6,})["'`]/i,
    valueIndex: 1,
  },
  {
    name: "password-assignment-unquoted-special",
    re: /\b(?:password|passwd|pwd)\b\s*[:=]\s*(?=[^\s"',;)}\]]*[^A-Za-z0-9\s])([^\s"',;)}\]]{6,})/i,
    valueIndex: 1,
  },
  {
    name: "secret-assignment",
    re: /\b(?:api[_-]?key|apikey|secret|token|password|passwd|private[_-]?key|client[_-]?secret|access[_-]?key|refresh[_-]?token)\b\s*[:=]\s*["'`]?([A-Za-z0-9_./+=:@-]{16,})/i,
    valueIndex: 1,
  },
  {
    name: "credential-pair-with-password",
    re: /(?:账号|用户名|用户|user(?:name)?|login)\s*(?:是|为|[:：=])\s*["'`]?[^\s"'`，。；;,)}\]]{2,}["'`]?(?:(?:[\s,，;；]+)|.{0,20})(?:密码|口令|password|passwd|pwd)\s*(?:是|为|[:：=])\s*["'`]?([^\s"'`，。；;,)}\]]{6,})/iu,
    valueIndex: 1,
  },
  {
    name: "chinese-password-assignment",
    re: /(?:密码|口令|登录密码|远程密码)\s*(?:是|为|[:：=])\s*["'`]?([^\s"'`，。；;,)}\]]{6,})/iu,
    valueIndex: 1,
  },
  {
    name: "chinese-secret-assignment",
    re: /(?:api\s*key|apikey|密钥|令牌|访问令牌|secret|token|凭证)\s*(?:是|为|[:：=])\s*["'`]?([A-Za-z0-9_./+=:@-]{12,})/iu,
    valueIndex: 1,
  },
  {
    name: "openai-style-key",
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  },
  {
    name: "github-token",
    re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/,
  },
  {
    name: "slack-token",
    re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  },
  {
    name: "google-api-key",
    re: /\bAIza[0-9A-Za-z_-]{20,}\b/,
  },
  {
    name: "aws-access-key",
    re: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
];

const INJECTED_CONTEXT_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "relevant-memories", re: /<\/?relevant-memories>/i },
  { name: "untrusted-data-block", re: /\[UNTRUSTED DATA[^\]]*\][\s\S]*?\[END UNTRUSTED DATA\]/i },
  { name: "openclaw-runtime-context", re: /OpenClaw runtime context for this turn:/i },
  { name: "workspace-context", re: /## OpenClaw Workspace Context/i },
  { name: "conversation-metadata", re: /Conversation info \(untrusted metadata\):/i },
  { name: "sender-metadata", re: /Sender \(untrusted metadata\):/i },
  { name: "message-metadata-json", re: /```json[\s\S]*"message_id"[\s\S]*"sender_id"[\s\S]*```/i },
];

const SYSTEM_WRAPPER_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "system-exec-line", re: /^System:\s*\[[^\n]*\]\s*Exec\s+(?:completed|failed|started)\b/im },
  { name: "session-reset-wrapper", re: /^A new session was started via \/new or \/reset\./i },
  { name: "current-user-request-wrapper", re: /^Current user request:/im },
];

const OPERATIONAL_TRACE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "command-hints-block", re: /^Command hints:\s*[\s\S]*?(?:^Files:|^Result:|\|\s*status=)/im },
  { name: "execution-status-marker", re: /\|\s*status=(?:completed|failed|running|cancelled)\b/i },
  { name: "execution-result-block", re: /^Result:\s*(?:Command|Task|Exec|Shell|Tool)\b/im },
  { name: "tool-fields-block", re: /^(?:Files|Result):\s*[\s\S]*\n(?:Files|Result|Command hints):/im },
];

const CONTEXT_COMPACTION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "turn-context-split", re: /Turn Context \(split turn\):/i },
  { name: "compaction-summary", re: /^## (?:Goal|Progress|Decisions|Open TODOs|Constraints\/Rules|Pending user asks|Exact identifiers)\b/m },
  { name: "critical-context-block", re: /^## Critical Context\b/m },
];

/**
 * Attachment line patterns — matched against trimmed lines for full-line removal.
 */
const ATTACHMENT_LINE_PATTERNS: RegExp[] = [
  /^\[Image attached at:\s*.*\]\s*$/i,
  /^\[inline image\/[^\]]*data omitted\]\s*$/i,
  /^\[screenshot\]\s*$/i,
];

/**
 * Inline attachment patterns — matched within lines for partial removal.
 */
const INLINE_ATTACHMENT_PATTERNS: RegExp[] = [
  /\[Image attached at:\s*[^\]]*\]/gi,
  /\[inline image\/[^\]]*data omitted\]/gi,
  /\[screenshot\]/gi,
  /(?:[A-Za-z]:)?[^\s\]]*[/\\]image_cache[/\\]img_[A-Za-z0-9_-]+\.(?:jpe?g|png|webp|gif)\b/gi,
];

/**
 * Trivial/ACK pattern — matches short acknowledgements that should not enter journal.
 */
const TRIVIAL_RE = /^(?:ok|okay|kk|k|yes|no|yep|nope|sure|thanks|thank you|thx|ty|got it|roger|understood|noted|acknowledged|done|hi|hello|hey|yo|早|早安|你好|嗨|在吗|在嗎|谢谢|謝謝|收到|明白|明白了|了解|了解了|好的|好)(?:[!！,.。?？~\s]*)$/i;

function matchPattern(
  patterns: Array<{ name: string; re: RegExp }>,
  text: string,
): { name: string } | null {
  for (const pattern of patterns) {
    if (pattern.re.test(text)) return { name: pattern.name };
  }
  return null;
}

function matchSecret(text: string): { name: string } | null {
  for (const pattern of SECRET_PATTERNS) {
    const match = pattern.re.exec(text);
    if (!match) continue;
    const value = pattern.valueIndex ? match[pattern.valueIndex] ?? "" : match[0] ?? "";
    if (value && looksLikePlaceholder(value)) continue;
    return { name: pattern.name };
  }
  return null;
}

/**
 * Sanitize text by removing gateway attachment markers before capture/journal storage.
 *
 * The LLM may receive images through native vision paths, but scope-recall should not
 * persist local cache paths or inline-image placeholders as memory material. Keeps the
 * user's surrounding text so a screenshot question can still be represented.
 */
export function sanitizeCaptureText(text: string | null | undefined): string {
  if (!text) return "";
  const cleaned = text.trim();
  if (!cleaned) return "";

  const keptLines: string[] = [];
  for (const line of cleaned.split(/\r?\n/)) {
    const stripped = line.trim();
    // Skip full-line attachment markers
    if (ATTACHMENT_LINE_PATTERNS.some((p) => p.test(stripped))) {
      continue;
    }
    // Remove inline attachment markers
    let sanitizedLine = line.trimEnd();
    for (const pattern of INLINE_ATTACHMENT_PATTERNS) {
      sanitizedLine = sanitizedLine.replace(pattern, "");
    }
    // Collapse multiple spaces within the line
    sanitizedLine = sanitizedLine.replace(/[ \t]{2,}/g, " ").trim();
    // Keep the line (even if empty, to preserve paragraph structure)
    keptLines.push(sanitizedLine);
  }
  const sanitized = keptLines.join("\n").trim();
  return sanitized.replace(/\n{3,}/g, "\n\n");
}

/**
 * Check if text is a trivial acknowledgement that should not enter journal.
 */
export function isTrivial(text: string): boolean {
  return TRIVIAL_RE.test((text || "").trim());
}

export function evaluateCaptureSafety(text: string): CaptureSafetyDecision {
  // Sanitize attachment markers first
  const sanitized = sanitizeCaptureText(text);
  if (!sanitized) return { allowed: false, reason: "empty" };

  // Check trivial/ACK
  if (isTrivial(sanitized)) {
    return { allowed: false, reason: "trivial" };
  }

  const injected = matchPattern(INJECTED_CONTEXT_PATTERNS, sanitized);
  if (injected) {
    return { allowed: false, reason: "injected-context", pattern: injected.name };
  }

  const wrapper = matchPattern(SYSTEM_WRAPPER_PATTERNS, sanitized);
  if (wrapper) {
    return { allowed: false, reason: "system-wrapper", pattern: wrapper.name };
  }

  const operationalTrace = matchPattern(OPERATIONAL_TRACE_PATTERNS, sanitized);
  if (operationalTrace) {
    return { allowed: false, reason: "operational-trace", pattern: operationalTrace.name };
  }

  const compaction = matchPattern(CONTEXT_COMPACTION_PATTERNS, sanitized);
  if (compaction) {
    return { allowed: false, reason: "context-compaction", pattern: compaction.name };
  }

  const secret = matchSecret(sanitized);
  if (secret) {
    return { allowed: false, reason: "secret", pattern: secret.name };
  }

  return { allowed: true };
}

export function isCaptureSafeText(text: string): boolean {
  return evaluateCaptureSafety(text).allowed;
}
