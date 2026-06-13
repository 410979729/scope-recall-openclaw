import { extractInjectableReflectionSliceItems, extractInjectableReflectionSlices, sanitizeReflectionSliceLines, sanitizeInjectableReflectionLines, } from "./reflection-slices.js";
import { parseReflectionMetadata } from "./reflection-metadata.js";
import { buildReflectionEventPayload, createReflectionEventId } from "./reflection-event-store.js";
import { buildReflectionItemPayloads, getReflectionItemDecayDefaults, REFLECTION_DERIVED_DECAY_K, REFLECTION_DERIVED_DECAY_MIDPOINT_DAYS, REFLECTION_INVARIANT_DECAY_K, REFLECTION_INVARIANT_DECAY_MIDPOINT_DAYS, } from "./reflection-item-store.js";
import { getReflectionMappedDecayDefaults } from "./reflection-mapped-metadata.js";
import { computeReflectionScore, normalizeReflectionLineForAggregation } from "./reflection-ranking.js";
import { evaluateCaptureSafety } from "./capture-safety.js";
export const REFLECTION_DERIVE_LOGISTIC_MIDPOINT_DAYS = 3;
export const REFLECTION_DERIVE_LOGISTIC_K = 1.2;
export const REFLECTION_DERIVE_FALLBACK_BASE_WEIGHT = 0.35;
export const DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_REFLECTION_MAPPED_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
export function buildReflectionStorePayloads(params) {
    const slices = extractInjectableReflectionSlices(params.reflectionText);
    const eventId = params.eventId || createReflectionEventId({
        runAt: params.runAt,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        agentId: params.agentId,
        command: params.command,
    });
    const payloads = [
        buildReflectionEventPayload({
            eventId,
            scope: params.scope,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            agentId: params.agentId,
            command: params.command,
            toolErrorSignals: params.toolErrorSignals,
            runAt: params.runAt,
            usedFallback: params.usedFallback,
            sourceReflectionPath: params.sourceReflectionPath,
        }),
    ];
    const itemPayloads = buildReflectionItemPayloads({
        items: extractInjectableReflectionSliceItems(params.reflectionText),
        eventId,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        runAt: params.runAt,
        usedFallback: params.usedFallback,
        toolErrorSignals: params.toolErrorSignals,
        sourceReflectionPath: params.sourceReflectionPath,
    });
    payloads.push(...itemPayloads);
    if (params.writeLegacyCombined !== false && (slices.invariants.length > 0 || slices.derived.length > 0)) {
        payloads.push(buildLegacyCombinedPayload({
            slices,
            scope: params.scope,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            agentId: params.agentId,
            command: params.command,
            toolErrorSignals: params.toolErrorSignals,
            runAt: params.runAt,
            usedFallback: params.usedFallback,
            sourceReflectionPath: params.sourceReflectionPath,
        }));
    }
    return { eventId, slices, payloads };
}
function buildLegacyCombinedPayload(params) {
    const dateYmd = new Date(params.runAt).toISOString().split("T")[0];
    const deriveQuality = computeDerivedLineQuality(params.slices.derived.length);
    const deriveBaseWeight = params.usedFallback ? REFLECTION_DERIVE_FALLBACK_BASE_WEIGHT : 1;
    return {
        kind: "combined-legacy",
        text: [
            `reflection · ${params.scope} · ${dateYmd}`,
            `Session Reflection (${new Date(params.runAt).toISOString()})`,
            `Session Key: ${params.sessionKey}`,
            `Session ID: ${params.sessionId}`,
            "",
            "Invariants:",
            ...(params.slices.invariants.length > 0 ? params.slices.invariants.map((x) => `- ${x}`) : ["- (none captured)"]),
            "",
            "Derived:",
            ...(params.slices.derived.length > 0 ? params.slices.derived.map((x) => `- ${x}`) : ["- (none captured)"]),
        ].join("\n"),
        metadata: {
            type: "memory-reflection",
            stage: "reflect-store",
            reflectionVersion: 3,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            agentId: params.agentId,
            command: params.command,
            storedAt: params.runAt,
            invariants: params.slices.invariants,
            derived: params.slices.derived,
            usedFallback: params.usedFallback,
            errorSignals: params.toolErrorSignals.map((s) => s.signatureHash),
            decayModel: "logistic",
            decayMidpointDays: REFLECTION_DERIVE_LOGISTIC_MIDPOINT_DAYS,
            decayK: REFLECTION_DERIVE_LOGISTIC_K,
            deriveBaseWeight,
            deriveQuality,
            deriveSource: params.usedFallback ? "fallback" : "normal",
            ...(params.sourceReflectionPath ? { sourceReflectionPath: params.sourceReflectionPath } : {}),
        },
    };
}
export async function storeReflectionToLanceDB(params) {
    const { eventId, slices, payloads } = buildReflectionStorePayloads(params);
    const storedKinds = [];
    const dedupeThreshold = Number.isFinite(params.dedupeThreshold) ? Number(params.dedupeThreshold) : 0.97;
    for (const payload of payloads) {
        const safety = evaluateCaptureSafety(payload.text);
        if (!safety.allowed) {
            continue;
        }
        const vector = await params.embedPassage(payload.text);
        if (payload.kind === "combined-legacy") {
            const existing = await params.vectorSearch(vector, 1, 0.1, [params.scope]);
            if (existing.length > 0 && existing[0].score > dedupeThreshold) {
                continue;
            }
        }
        await params.store({
            text: payload.text,
            vector,
            category: "reflection",
            scope: params.scope,
            importance: resolveReflectionImportance(payload.kind),
            metadata: JSON.stringify(payload.metadata),
        });
        storedKinds.push(payload.kind);
    }
    return { stored: storedKinds.length > 0, eventId, slices, storedKinds };
}
function resolveReflectionImportance(kind) {
    if (kind === "event")
        return 0.55;
    if (kind === "item-invariant")
        return 0.82;
    if (kind === "item-derived")
        return 0.78;
    return 0.75;
}
export function loadAgentReflectionSlicesFromEntries(params) {
    const now = Number.isFinite(params.now) ? Number(params.now) : Date.now();
    const deriveMaxAgeMs = Number.isFinite(params.deriveMaxAgeMs)
        ? Math.max(0, Number(params.deriveMaxAgeMs))
        : DEFAULT_REFLECTION_DERIVED_MAX_AGE_MS;
    const invariantMaxAgeMs = Number.isFinite(params.invariantMaxAgeMs)
        ? Math.max(0, Number(params.invariantMaxAgeMs))
        : undefined;
    const reflectionRows = params.entries
        .map((entry) => ({ entry, metadata: parseReflectionMetadata(entry.metadata) }))
        .filter(({ metadata }) => isReflectionMetadataType(metadata.type) && isOwnedByAgent(metadata, params.agentId))
        .sort((a, b) => b.entry.timestamp - a.entry.timestamp)
        .slice(0, 160);
    const itemRows = reflectionRows.filter(({ metadata }) => metadata.type === "memory-reflection-item");
    const legacyRows = reflectionRows.filter(({ metadata }) => metadata.type === "memory-reflection");
    const invariantCandidates = buildInvariantCandidates(itemRows, legacyRows);
    const derivedCandidates = buildDerivedCandidates(itemRows, legacyRows);
    const invariants = rankReflectionLines(invariantCandidates, {
        now,
        maxAgeMs: invariantMaxAgeMs,
        limit: 8,
    });
    const derived = rankReflectionLines(derivedCandidates, {
        now,
        maxAgeMs: deriveMaxAgeMs,
        limit: 10,
    });
    return { invariants, derived };
}
function buildInvariantCandidates(itemRows, legacyRows) {
    const itemCandidates = itemRows
        .filter(({ metadata }) => metadata.itemKind === "invariant")
        .flatMap(({ entry, metadata }) => {
        const safeLines = sanitizeInjectableReflectionLines([entry.text]);
        if (safeLines.length === 0)
            return [];
        const defaults = getReflectionItemDecayDefaults("invariant");
        const timestamp = metadataTimestamp(metadata, entry.timestamp);
        return safeLines.map((line) => ({
            line,
            timestamp,
            midpointDays: readPositiveNumber(metadata.decayMidpointDays, defaults.midpointDays),
            k: readPositiveNumber(metadata.decayK, defaults.k),
            baseWeight: readPositiveNumber(metadata.baseWeight, defaults.baseWeight),
            quality: readClampedNumber(metadata.quality, defaults.quality, 0.2, 1),
            usedFallback: metadata.usedFallback === true,
        }));
    });
    if (itemCandidates.length > 0)
        return itemCandidates;
    return legacyRows.flatMap(({ entry, metadata }) => {
        const defaults = getReflectionItemDecayDefaults("invariant");
        const timestamp = metadataTimestamp(metadata, entry.timestamp);
        const lines = sanitizeInjectableReflectionLines(toStringArray(metadata.invariants));
        return lines.map((line) => ({
            line,
            timestamp,
            midpointDays: defaults.midpointDays,
            k: defaults.k,
            baseWeight: defaults.baseWeight,
            quality: defaults.quality,
            usedFallback: metadata.usedFallback === true,
        }));
    });
}
function buildDerivedCandidates(itemRows, legacyRows) {
    const itemCandidates = itemRows
        .filter(({ metadata }) => metadata.itemKind === "derived")
        .flatMap(({ entry, metadata }) => {
        const safeLines = sanitizeInjectableReflectionLines([entry.text]);
        if (safeLines.length === 0)
            return [];
        const defaults = getReflectionItemDecayDefaults("derived");
        const timestamp = metadataTimestamp(metadata, entry.timestamp);
        return safeLines.map((line) => ({
            line,
            timestamp,
            midpointDays: readPositiveNumber(metadata.decayMidpointDays, defaults.midpointDays),
            k: readPositiveNumber(metadata.decayK, defaults.k),
            baseWeight: readPositiveNumber(metadata.baseWeight, defaults.baseWeight),
            quality: readClampedNumber(metadata.quality, defaults.quality, 0.2, 1),
            usedFallback: metadata.usedFallback === true,
        }));
    });
    if (itemCandidates.length > 0)
        return itemCandidates;
    return legacyRows.flatMap(({ entry, metadata }) => {
        const timestamp = metadataTimestamp(metadata, entry.timestamp);
        const lines = sanitizeInjectableReflectionLines(toStringArray(metadata.derived));
        if (lines.length === 0)
            return [];
        const defaults = {
            midpointDays: REFLECTION_DERIVE_LOGISTIC_MIDPOINT_DAYS,
            k: REFLECTION_DERIVE_LOGISTIC_K,
            baseWeight: resolveLegacyDeriveBaseWeight(metadata),
            quality: computeDerivedLineQuality(lines.length),
        };
        return lines.map((line) => ({
            line,
            timestamp,
            midpointDays: readPositiveNumber(metadata.decayMidpointDays, defaults.midpointDays),
            k: readPositiveNumber(metadata.decayK, defaults.k),
            baseWeight: readPositiveNumber(metadata.deriveBaseWeight, defaults.baseWeight),
            quality: readClampedNumber(metadata.deriveQuality, defaults.quality, 0.2, 1),
            usedFallback: metadata.usedFallback === true,
        }));
    });
}
function rankReflectionLines(candidates, options) {
    const lineScores = new Map();
    for (const candidate of candidates) {
        const timestamp = Number.isFinite(candidate.timestamp) ? candidate.timestamp : options.now;
        if (Number.isFinite(options.maxAgeMs) && options.maxAgeMs >= 0 && options.now - timestamp > options.maxAgeMs) {
            continue;
        }
        const ageDays = Math.max(0, (options.now - timestamp) / 86_400_000);
        const score = computeReflectionScore({
            ageDays,
            midpointDays: candidate.midpointDays,
            k: candidate.k,
            baseWeight: candidate.baseWeight,
            quality: candidate.quality,
            usedFallback: candidate.usedFallback,
        });
        if (!Number.isFinite(score) || score <= 0)
            continue;
        const key = normalizeReflectionLineForAggregation(candidate.line);
        if (!key)
            continue;
        const current = lineScores.get(key);
        if (!current) {
            lineScores.set(key, { line: candidate.line, score, latestTs: timestamp });
            continue;
        }
        current.score += score;
        if (timestamp > current.latestTs) {
            current.latestTs = timestamp;
            current.line = candidate.line;
        }
    }
    return [...lineScores.values()]
        .sort((a, b) => {
        if (b.score !== a.score)
            return b.score - a.score;
        if (b.latestTs !== a.latestTs)
            return b.latestTs - a.latestTs;
        return a.line.localeCompare(b.line);
    })
        .slice(0, options.limit)
        .map((item) => item.line);
}
function isReflectionMetadataType(type) {
    return type === "memory-reflection-item" || type === "memory-reflection";
}
function isOwnedByAgent(metadata, agentId) {
    const owner = typeof metadata.agentId === "string" ? metadata.agentId.trim() : "";
    if (!owner)
        return true;
    return owner === agentId || owner === "main";
}
function toStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .map((item) => String(item).trim())
        .filter(Boolean);
}
function metadataTimestamp(metadata, fallbackTs) {
    const storedAt = Number(metadata.storedAt);
    if (Number.isFinite(storedAt) && storedAt > 0)
        return storedAt;
    return Number.isFinite(fallbackTs) ? fallbackTs : Date.now();
}
function readPositiveNumber(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0)
        return fallback;
    return num;
}
function readClampedNumber(value, fallback, min, max) {
    const num = Number(value);
    const resolved = Number.isFinite(num) ? num : fallback;
    return Math.max(min, Math.min(max, resolved));
}
export function computeDerivedLineQuality(nonPlaceholderLineCount) {
    const n = Number.isFinite(nonPlaceholderLineCount) ? Math.max(0, Math.floor(nonPlaceholderLineCount)) : 0;
    if (n <= 0)
        return 0.2;
    return Math.min(1, 0.55 + Math.min(6, n) * 0.075);
}
function resolveLegacyDeriveBaseWeight(metadata) {
    const explicit = Number(metadata.deriveBaseWeight);
    if (Number.isFinite(explicit) && explicit > 0) {
        return Math.max(0.1, Math.min(1.2, explicit));
    }
    if (metadata.usedFallback === true) {
        return REFLECTION_DERIVE_FALLBACK_BASE_WEIGHT;
    }
    return 1;
}
export function loadReflectionMappedRowsFromEntries(params) {
    const now = Number.isFinite(params.now) ? Number(params.now) : Date.now();
    const maxAgeMs = Number.isFinite(params.maxAgeMs)
        ? Math.max(0, Number(params.maxAgeMs))
        : DEFAULT_REFLECTION_MAPPED_MAX_AGE_MS;
    const maxPerKind = Number.isFinite(params.maxPerKind) ? Math.max(1, Math.floor(Number(params.maxPerKind))) : 10;
    const weighted = params.entries
        .map((entry) => ({ entry, metadata: parseReflectionMetadata(entry.metadata) }))
        .filter(({ metadata }) => metadata.type === "memory-reflection-mapped" && isOwnedByAgent(metadata, params.agentId))
        .flatMap(({ entry, metadata }) => {
        const mappedKind = parseMappedKind(metadata.mappedKind);
        if (!mappedKind)
            return [];
        const lines = sanitizeReflectionSliceLines([entry.text]);
        if (lines.length === 0)
            return [];
        const defaults = getReflectionMappedDecayDefaults(mappedKind);
        const timestamp = metadataTimestamp(metadata, entry.timestamp);
        return lines.map((line) => ({
            text: line,
            mappedKind,
            timestamp,
            midpointDays: readPositiveNumber(metadata.decayMidpointDays, defaults.midpointDays),
            k: readPositiveNumber(metadata.decayK, defaults.k),
            baseWeight: readPositiveNumber(metadata.baseWeight, defaults.baseWeight),
            quality: readClampedNumber(metadata.quality, defaults.quality, 0.2, 1),
            usedFallback: metadata.usedFallback === true,
        }));
    });
    const grouped = new Map();
    for (const item of weighted) {
        if (now - item.timestamp > maxAgeMs)
            continue;
        const ageDays = Math.max(0, (now - item.timestamp) / 86_400_000);
        const score = computeReflectionScore({
            ageDays,
            midpointDays: item.midpointDays,
            k: item.k,
            baseWeight: item.baseWeight,
            quality: item.quality,
            usedFallback: item.usedFallback,
        });
        if (!Number.isFinite(score) || score <= 0)
            continue;
        const normalized = normalizeReflectionLineForAggregation(item.text);
        if (!normalized)
            continue;
        const key = `${item.mappedKind}::${normalized}`;
        const current = grouped.get(key);
        if (!current) {
            grouped.set(key, { text: item.text, score, latestTs: item.timestamp, kind: item.mappedKind });
            continue;
        }
        current.score += score;
        if (item.timestamp > current.latestTs) {
            current.latestTs = item.timestamp;
            current.text = item.text;
        }
    }
    const sortedByKind = (kind) => [...grouped.values()]
        .filter((row) => row.kind === kind)
        .sort((a, b) => {
        if (b.score !== a.score)
            return b.score - a.score;
        if (b.latestTs !== a.latestTs)
            return b.latestTs - a.latestTs;
        return a.text.localeCompare(b.text);
    })
        .slice(0, maxPerKind)
        .map((row) => row.text);
    return {
        userModel: sortedByKind("user-model"),
        agentModel: sortedByKind("agent-model"),
        lesson: sortedByKind("lesson"),
        decision: sortedByKind("decision"),
    };
}
function parseMappedKind(value) {
    if (value === "user-model" || value === "agent-model" || value === "lesson" || value === "decision") {
        return value;
    }
    return null;
}
export function getReflectionDerivedDecayDefaults() {
    return {
        midpointDays: REFLECTION_DERIVED_DECAY_MIDPOINT_DAYS,
        k: REFLECTION_DERIVED_DECAY_K,
    };
}
export function getReflectionInvariantDecayDefaults() {
    return {
        midpointDays: REFLECTION_INVARIANT_DECAY_MIDPOINT_DAYS,
        k: REFLECTION_INVARIANT_DECAY_K,
    };
}
