import { createHash } from "node:crypto";
import { evaluateCaptureSafety } from "./capture-safety.js";
const ALLOWED_SECRET_TYPES = new Set(["password", "token", "api_key", "private_key", "cookie", "credential", "other"]);
const SECRET_ASSIGNMENT_RE = /\b(api[_\s-]?key|token|secret|password|passwd|credential|private[_\s-]?key|cookie)\s*[:=]\s*[^\s,'"\]}]+/gi;
const BEARER_RE = /\bbearer\s+[A-Za-z0-9._\-~+/=]{16,}/gi;
function compactText(value, maxChars) {
    const text = String(value || "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(SECRET_ASSIGNMENT_RE, (_match, key) => `${key}=[REDACTED]`)
        .replace(BEARER_RE, "bearer [REDACTED]");
    return text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…` : text;
}
function stringList(value) {
    if (typeof value === "string")
        return value.split(",").map((item) => item.trim()).filter(Boolean);
    if (Array.isArray(value))
        return value.map((item) => String(item).trim()).filter(Boolean);
    return [];
}
function normalizeEntity(value) {
    return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 160);
}
function secretType(value) {
    const normalized = String(value || "credential").trim().toLowerCase().replace(/-/g, "_");
    return ALLOWED_SECRET_TYPES.has(normalized) ? normalized : "other";
}
function fingerprint(value) {
    const text = String(value || "");
    return text ? createHash("sha256").update(text).digest("hex").slice(0, 16) : "";
}
function safeIndexField(field, value, maxChars) {
    const text = compactText(value, maxChars);
    if (!text)
        return "";
    const decision = evaluateCaptureSafety(text);
    if (!decision.allowed) {
        throw new Error(`secret index field '${field}' rejected by capture safety filter (${decision.reason}${decision.pattern ? `:${decision.pattern}` : ""})`);
    }
    return text;
}
export function buildSecretIndex(args) {
    const label = safeIndexField("label", args.label || args.name, 160);
    const service = safeIndexField("service", args.service, 120);
    const account = safeIndexField("account", args.account, 120);
    const username = safeIndexField("username", args.username, 120);
    const hostname = safeIndexField("hostname", args.hostname, 120);
    const vaultRef = safeIndexField("vaultRef", args.vaultRef || args.vault_ref || args.locator, 260);
    const notes = safeIndexField("notes", args.notes, 300);
    const rotationDue = safeIndexField("rotationDue", args.rotationDue || args.rotation_due || args.expires_at, 80);
    const kind = secretType(args.secretType || args.secret_type || args.type);
    const secretFingerprint = fingerprint(args.secretValue || args.secret_value);
    const safeLabel = label || service || account || vaultRef || "unnamed credential";
    const lines = [`Secret index: ${safeLabel}`, `Kind: ${kind}`];
    if (service)
        lines.push(`Service: ${service}`);
    if (account)
        lines.push(`Account: ${account}`);
    if (username)
        lines.push(`Username: ${username}`);
    if (hostname)
        lines.push(`Host: ${hostname}`);
    lines.push(vaultRef ? `Vault ref: ${vaultRef}` : "Vault ref: [not provided]");
    if (rotationDue)
        lines.push(`Rotation due: ${rotationDue}`);
    if (secretFingerprint)
        lines.push(`Secret fingerprint: sha256:${secretFingerprint}`);
    if (notes)
        lines.push(`Notes: ${notes}`);
    lines.push("Plaintext secret value: [not stored in scope-recall SQL/FTS/vector]");
    const entities = [safeLabel, service, account, username, hostname, vaultRef, ...stringList(args.entities)]
        .map((item) => normalizeEntity(item))
        .filter(Boolean);
    const tags = ["secret-index", "credential", `secret-type:${kind}`, ...stringList(args.tags)]
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean);
    const metadata = {
        memory_type: "resource",
        importance: 0.82,
        sensitivity: "secret-index",
        secret_storage: "external-vault-reference",
        secret_value_stored: false,
        secret_type: kind,
        secret_value_sha256_prefix: secretFingerprint,
        entities: [...new Set(entities)].sort(),
        tags: [...new Set(tags)].sort(),
    };
    if (vaultRef)
        metadata.vault_ref = vaultRef;
    if (service)
        metadata.service = service;
    if (account)
        metadata.account = account;
    if (rotationDue)
        metadata.rotation_due = rotationDue;
    return { content: lines.join("\n"), metadata };
}
