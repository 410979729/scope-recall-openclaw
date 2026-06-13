import { appendRelation, parseSmartMetadata, stringifySmartMetadata, } from "./smart-metadata.js";
const CLAIM_RE = /^\s*(?<subject>.+?)\s+(?<predicate>is\s+not|are\s+not|was\s+not|were\s+not|does\s+not\s+use|do\s+not\s+use|doesn't\s+use|don't\s+use|no\s+longer\s+uses?|is|are|was|were|uses?|prefers?|likes?|wants?)\s+(?<value>.+?)\s*[.!?。！？]?\s*$/i;
const DEPLOY_RE = /\b(?<subject>.+?\bdeploy(?:ment)?(?:\s+command)?)\s+(?<predicate>is\s+not|does\s+not\s+use|do\s+not\s+use|doesn't\s+use|don't\s+use|no\s+longer\s+uses?|uses?|is|=)\s+(?<value>[^.!?。！？]+)\s*[.!?。！？]?/i;
const NEGATION_RE = /\b(no longer|not|never|doesn't|don't|does not|do not|不再|不要|不是|取消|avoid|stop)\b/i;
const TOKEN_RE = /[a-zA-Z0-9_./:-]{2,}|[\u4e00-\u9fff]{2,}/g;
const STOPWORDS = new Set([
    "a", "an", "and", "are", "as", "be", "by", "current", "for", "in",
    "is", "it", "of", "on", "or", "the", "to", "with", "does", "do",
    "not", "no", "longer", "never",
]);
function normalizeText(value) {
    return value
        .toLowerCase()
        .replace(/[`"'“”‘’]/g, "")
        .replace(/\s+/g, " ")
        .replace(/[。.!?；;，,]+$/g, "")
        .trim();
}
function tokens(value) {
    const seen = new Set();
    const result = [];
    for (const match of normalizeText(value).matchAll(TOKEN_RE)) {
        const token = match[0];
        if (STOPWORDS.has(token) || seen.has(token))
            continue;
        seen.add(token);
        result.push(token);
    }
    return result;
}
export function semanticSimilarity(a, b) {
    const left = tokens(a);
    const right = tokens(b);
    if (left.length === 0 || right.length === 0)
        return 0;
    const rightSet = new Set(right);
    const overlap = left.filter((token) => rightSet.has(token)).length;
    const union = new Set([...left, ...right]).size || 1;
    return Math.max(overlap / left.length, overlap / right.length, overlap / union);
}
function compactValue(value) {
    return normalizeText(value)
        .replace(/^(?:documented|configured|set|defined)\s+(?:in|as)\s+/i, "")
        .replace(/^(?:not|never|no\s+longer)\s+/i, "")
        .replace(/^(?:does\s+not|do\s+not|doesn't|don't)\s+use\s+/i, "")
        .trim();
}
function compactPredicate(value) {
    return normalizeText(value)
        .replace(/\b(?:not|never)\b/gi, "")
        .replace(/\bno\s+longer\b/gi, "")
        .replace(/\b(?:does\s+not|do\s+not|doesn't|don't)\s+/gi, "")
        .replace(/\s+/g, " ")
        .trim();
}
function parseClaim(text) {
    const cleaned = normalizeText(text);
    if (!cleaned)
        return null;
    const deploy = DEPLOY_RE.exec(cleaned);
    const groups = deploy?.groups ?? CLAIM_RE.exec(cleaned)?.groups;
    if (!groups)
        return null;
    const subject = normalizeText(groups.subject ?? "");
    const predicate = normalizeText(groups.predicate ?? "");
    const value = compactValue(groups.value ?? "");
    if (!subject || !predicate || !value)
        return null;
    return {
        subject,
        predicate: compactPredicate(predicate),
        value,
        negated: NEGATION_RE.test(predicate) || NEGATION_RE.test(cleaned),
    };
}
export function isReviewConflict(existingText, candidateText) {
    const existing = parseClaim(existingText);
    const candidate = parseClaim(candidateText);
    if (!existing || !candidate)
        return false;
    if (existing.negated === candidate.negated)
        return false;
    if (semanticSimilarity(existing.subject, candidate.subject) < 0.45)
        return false;
    if (existing.predicate !== candidate.predicate &&
        semanticSimilarity(existing.predicate, candidate.predicate) < 0.35) {
        return false;
    }
    if (semanticSimilarity(existing.value, candidate.value) < 0.75)
        return false;
    return true;
}
function uniqueStrings(values) {
    return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].sort();
}
function withConflictReviewMetadata(entry, relatedId) {
    const meta = parseSmartMetadata(entry.metadata, entry);
    const currentIds = Array.isArray(meta.conflict_review_ids)
        ? meta.conflict_review_ids.map(String)
        : [];
    const relationTypes = Array.isArray(meta.relation_types)
        ? meta.relation_types.map(String)
        : [];
    const conflictIds = uniqueStrings([...currentIds, relatedId]);
    return {
        ...meta,
        relations: appendRelation(meta.relations, {
            type: "contradicts",
            targetId: relatedId,
        }),
        relation_types: uniqueStrings([...relationTypes, "contradicts"]),
        conflict_review_ids: conflictIds,
        conflict_review_count: conflictIds.length,
        needs_conflict_review: true,
    };
}
export async function recordConflictReviewRelations(store, entry, scopeFilter, options = {}) {
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 80)));
    const candidates = await store.list(scopeFilter, entry.category, limit, 0);
    const conflicts = candidates.filter((candidate) => candidate.id !== entry.id && isReviewConflict(candidate.text, entry.text));
    if (conflicts.length === 0)
        return { conflictCount: 0, conflictIds: [] };
    for (const candidate of conflicts) {
        await store.patchMetadata(candidate.id, withConflictReviewMetadata(candidate, entry.id), scopeFilter);
    }
    let current = await store.getById(entry.id, scopeFilter);
    if (!current)
        current = entry;
    const conflictIds = conflicts.map((candidate) => candidate.id);
    const meta = conflictIds.reduce((acc, conflictId) => withConflictReviewMetadata({ ...current, metadata: stringifySmartMetadata(acc) }, conflictId), parseSmartMetadata(current.metadata, current));
    await store.patchMetadata(entry.id, meta, scopeFilter);
    return { conflictCount: conflicts.length, conflictIds };
}
export function buildGovernanceReviewCandidates(entries, options = {}) {
    const candidates = [];
    for (const entry of entries) {
        const meta = parseSmartMetadata(entry.metadata, entry);
        const lifecycle = String(meta.lifecycle ?? "").trim().toLowerCase();
        const reasons = [];
        if (meta.needs_conflict_review)
            reasons.push("conflict_review");
        if (meta.state === "rejected")
            reasons.push("inactive_lifecycle:rejected");
        if (["superseded", "obsolete", "rejected"].includes(lifecycle))
            reasons.push(`inactive_lifecycle:${lifecycle}`);
        if (meta.state === "archived" || meta.memory_layer === "archive" || lifecycle === "archived")
            reasons.push("archive_review");
        if (meta.memory_layer === "working" || entry.category === "other")
            reasons.push("local_or_working_scratch");
        if (meta.source === "auto-capture" && meta.confidence < 0.72)
            reasons.push("raw_or_low_confidence_auto_capture");
        if (meta.source === "legacy")
            reasons.push("legacy_metadata_review");
        if (meta.confidence < 0.55)
            reasons.push("low_confidence");
        if (!reasons.length)
            continue;
        const suggestedAction = reasons.includes("conflict_review")
            ? "review"
            : reasons.some((reason) => reason.startsWith("inactive_lifecycle") || reason === "archive_review")
                ? "archive"
                : reasons.includes("low_confidence")
                    ? "promote"
                    : "review";
        candidates.push({
            id: entry.id,
            category: entry.category,
            scope: entry.scope,
            text: options.includeText ? entry.text : entry.text.slice(0, 220),
            reasons,
            suggestedAction,
            confidence: meta.confidence,
            state: meta.state,
            layer: meta.memory_layer,
            source: meta.source,
            relations: meta.relations ?? [],
        });
    }
    candidates.sort((a, b) => {
        const conflictDelta = Number(b.reasons.includes("conflict_review")) - Number(a.reasons.includes("conflict_review"));
        if (conflictDelta)
            return conflictDelta;
        return a.confidence - b.confidence;
    });
    return candidates.slice(0, Math.max(1, Math.min(200, Math.floor(options.limit ?? 50))));
}
