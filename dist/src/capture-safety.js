function looksLikePlaceholder(value) {
    const lower = value.toLowerCase();
    return (value.includes("${") ||
        value.includes("...") ||
        lower.includes("example") ||
        lower.includes("placeholder") ||
        lower.includes("dummy") ||
        lower.includes("redacted") ||
        lower.includes("test-key") ||
        lower.includes("your-key") ||
        lower.includes("changeme") ||
        value.includes("****"));
}
const SECRET_PATTERNS = [
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
const INJECTED_CONTEXT_PATTERNS = [
    { name: "relevant-memories", re: /<\/?relevant-memories>/i },
    { name: "untrusted-data-block", re: /\[UNTRUSTED DATA[^\]]*\][\s\S]*?\[END UNTRUSTED DATA\]/i },
    { name: "openclaw-runtime-context", re: /OpenClaw runtime context for this turn:/i },
    { name: "workspace-context", re: /## OpenClaw Workspace Context/i },
    { name: "conversation-metadata", re: /Conversation info \(untrusted metadata\):/i },
    { name: "sender-metadata", re: /Sender \(untrusted metadata\):/i },
    { name: "message-metadata-json", re: /```json[\s\S]*"message_id"[\s\S]*"sender_id"[\s\S]*```/i },
];
const SYSTEM_WRAPPER_PATTERNS = [
    { name: "system-exec-line", re: /^System:\s*\[[^\n]*\]\s*Exec\s+(?:completed|failed|started)\b/im },
    { name: "session-reset-wrapper", re: /^A new session was started via \/new or \/reset\./i },
    { name: "current-user-request-wrapper", re: /^Current user request:/im },
];
const OPERATIONAL_TRACE_PATTERNS = [
    { name: "command-hints-block", re: /^Command hints:\s*[\s\S]*?(?:^Files:|^Result:|\|\s*status=)/im },
    { name: "execution-status-marker", re: /\|\s*status=(?:completed|failed|running|cancelled)\b/i },
    { name: "execution-result-block", re: /^Result:\s*(?:Command|Task|Exec|Shell|Tool)\b/im },
    { name: "tool-fields-block", re: /^(?:Files|Result):\s*[\s\S]*\n(?:Files|Result|Command hints):/im },
];
const CONTEXT_COMPACTION_PATTERNS = [
    { name: "turn-context-split", re: /Turn Context \(split turn\):/i },
    { name: "compaction-summary", re: /^## (?:Goal|Progress|Decisions|Open TODOs|Constraints\/Rules|Pending user asks|Exact identifiers)\b/m },
    { name: "critical-context-block", re: /^## Critical Context\b/m },
];
function matchPattern(patterns, text) {
    for (const pattern of patterns) {
        if (pattern.re.test(text))
            return { name: pattern.name };
    }
    return null;
}
function matchSecret(text) {
    for (const pattern of SECRET_PATTERNS) {
        const match = pattern.re.exec(text);
        if (!match)
            continue;
        const value = pattern.valueIndex ? match[pattern.valueIndex] ?? "" : match[0] ?? "";
        if (value && looksLikePlaceholder(value))
            continue;
        return { name: pattern.name };
    }
    return null;
}
export function evaluateCaptureSafety(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return { allowed: false, reason: "empty" };
    const injected = matchPattern(INJECTED_CONTEXT_PATTERNS, trimmed);
    if (injected) {
        return { allowed: false, reason: "injected-context", pattern: injected.name };
    }
    const wrapper = matchPattern(SYSTEM_WRAPPER_PATTERNS, trimmed);
    if (wrapper) {
        return { allowed: false, reason: "system-wrapper", pattern: wrapper.name };
    }
    const operationalTrace = matchPattern(OPERATIONAL_TRACE_PATTERNS, trimmed);
    if (operationalTrace) {
        return { allowed: false, reason: "operational-trace", pattern: operationalTrace.name };
    }
    const compaction = matchPattern(CONTEXT_COMPACTION_PATTERNS, trimmed);
    if (compaction) {
        return { allowed: false, reason: "context-compaction", pattern: compaction.name };
    }
    const secret = matchSecret(trimmed);
    if (secret) {
        return { allowed: false, reason: "secret", pattern: secret.name };
    }
    return { allowed: true };
}
export function isCaptureSafeText(text) {
    return evaluateCaptureSafety(text).allowed;
}
