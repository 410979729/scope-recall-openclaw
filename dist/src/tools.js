/**
 * Agent Tool Definitions
 * Memory management tools for AI agents
 */
import { Type } from "@sinclair/typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isNoise } from "./noise-filter.js";
import { evaluateCaptureSafety } from "./capture-safety.js";
import { isSystemBypassId, resolveScopeFilter, parseAgentIdFromSessionKey } from "./scopes.js";
import { appendRelation, buildSmartMetadata, deriveFactKey, parseSmartMetadata, stringifySmartMetadata, } from "./smart-metadata.js";
import { TEMPORAL_VERSIONED_CATEGORIES } from "./memory-categories.js";
import { appendSelfImprovementEntry, ensureSelfImprovementLearningFiles } from "./self-improvement-files.js";
import { getDisplayCategoryTag } from "./reflection-metadata.js";
import { filterUserMdExclusiveRecallResults, isUserMdExclusiveMemory, } from "./workspace-boundary.js";
import { enrichContentWithArtifactAnchors, mergeArtifactMetadata } from "./artifacts.js";
import { buildSecretIndex } from "./secret-index.js";
import { buildGovernanceReviewCandidates, recordConflictReviewRelations, } from "./conflict-governance.js";
// ============================================================================
// Types
// ============================================================================
export const MEMORY_CATEGORIES = [
    "preference",
    "fact",
    "decision",
    "entity",
    "reflection",
    "other",
];
function stringEnum(values) {
    return Type.Unsafe({
        type: "string",
        enum: [...values],
    });
}
// ============================================================================
// Utility Functions
// ============================================================================
function clampInt(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    return Math.min(max, Math.max(min, Math.floor(value)));
}
function clamp01(value, fallback = 0.7) {
    if (!Number.isFinite(value))
        return fallback;
    return Math.min(1, Math.max(0, value));
}
function normalizeInlineText(text) {
    return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}
function truncateText(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    const clipped = text.slice(0, Math.max(1, maxChars - 1)).trimEnd();
    return `${clipped}…`;
}
function deriveManualMemoryLayer(category) {
    if (category === "preference" || category === "decision" || category === "fact") {
        return "durable";
    }
    return "working";
}
function sanitizeMemoryForSerialization(results) {
    return results.map((r) => ({
        id: r.entry.id,
        text: r.entry.text,
        category: getDisplayCategoryTag(r.entry),
        rawCategory: r.entry.category,
        scope: r.entry.scope,
        importance: r.entry.importance,
        score: r.score,
        sources: r.sources,
    }));
}
function serializeMemoryEntry(entry, includeFullText = false) {
    const metadata = parseSmartMetadata(entry.metadata, entry);
    const base = {
        id: entry.id,
        text: includeFullText
            ? metadata.l2_content || metadata.l1_overview || entry.text
            : truncateText(normalizeInlineText(metadata.l0_abstract || entry.text), 220),
        category: getDisplayCategoryTag(entry),
        rawCategory: entry.category,
        scope: entry.scope,
        importance: entry.importance,
        timestamp: entry.timestamp,
        state: metadata.state,
        layer: metadata.memory_layer,
        source: metadata.source,
        tier: metadata.tier,
        confidence: metadata.confidence,
        factKey: metadata.fact_key,
        validFrom: metadata.valid_from,
        invalidatedAt: metadata.invalidated_at,
        supersedes: metadata.supersedes,
        supersededBy: metadata.superseded_by,
        canonicalId: metadata.canonical_id,
        relations: metadata.relations ?? [],
    };
    return includeFullText
        ? {
            ...base,
            l0Abstract: metadata.l0_abstract,
            l1Overview: metadata.l1_overview,
            l2Content: metadata.l2_content,
        }
        : base;
}
function renderMemoryEntry(entry, index, includeFullText = false) {
    const metadata = parseSmartMetadata(entry.metadata, entry);
    const prefix = index === undefined ? "" : `${index + 1}. `;
    const categoryTag = getDisplayCategoryTag(entry);
    const date = new Date(entry.timestamp).toISOString().split("T")[0];
    const sourceBits = [
        metadata.state,
        metadata.memory_layer,
        metadata.source,
        metadata.tier,
    ].filter(Boolean).join("/");
    const text = includeFullText
        ? normalizeInlineText(metadata.l2_content || metadata.l1_overview || entry.text)
        : truncateText(normalizeInlineText(metadata.l0_abstract || entry.text), 180);
    return `${prefix}[${entry.id}] [${categoryTag}:${entry.scope}] ${text} (${date}; ${sourceBits})`;
}
function memoryMetadataMatches(entry, filters) {
    const metadata = parseSmartMetadata(entry.metadata, entry);
    if (filters.source && metadata.source !== filters.source)
        return false;
    if (filters.state && metadata.state !== filters.state)
        return false;
    if (filters.layer && metadata.memory_layer !== filters.layer)
        return false;
    return true;
}
const _warnedMissingAgentId = new Set();
/** @internal Exported for testing only — resets the missing-agent warning throttle. */
export function _resetWarnedMissingAgentIdState() {
    _warnedMissingAgentId.clear();
}
function resolveRuntimeAgentId(staticAgentId, runtimeCtx) {
    if (!runtimeCtx || typeof runtimeCtx !== "object") {
        const fallback = staticAgentId?.trim();
        if (!fallback && !_warnedMissingAgentId.has("no-context")) {
            _warnedMissingAgentId.add("no-context");
            console.warn("resolveRuntimeAgentId: no runtime context or static agentId; refusing implicit agent:main scope.");
        }
        return fallback || undefined;
    }
    const ctx = runtimeCtx;
    const ctxAgentId = typeof ctx.agentId === "string" ? ctx.agentId : undefined;
    const ctxSessionKey = typeof ctx.sessionKey === "string" ? ctx.sessionKey : undefined;
    const resolved = ctxAgentId || parseAgentIdFromSessionKey(ctxSessionKey) || staticAgentId;
    const trimmed = resolved?.trim();
    if (!trimmed && !_warnedMissingAgentId.has("empty-resolved")) {
        _warnedMissingAgentId.add("empty-resolved");
        console.warn("resolveRuntimeAgentId: resolved agentId is empty after trim; refusing implicit agent:main scope.");
    }
    return trimmed ? trimmed : undefined;
}
function resolveToolContext(base, runtimeCtx) {
    return {
        ...base,
        agentId: resolveRuntimeAgentId(base.agentId, runtimeCtx),
    };
}
function missingAgentContextResponse(toolName) {
    return {
        content: [
            {
                type: "text",
                text: `${toolName} requires OpenClaw agent runtime context; refusing to fall back to agent:main.`,
            },
        ],
        details: {
            error: "missing_agent_context",
            tool: toolName,
        },
    };
}
function requireRuntimeAgentId(staticAgentId, runtimeCtx, toolName) {
    const agentId = resolveRuntimeAgentId(staticAgentId, runtimeCtx);
    if (agentId)
        return { ok: true, agentId };
    return { ok: false, response: missingAgentContextResponse(toolName) };
}
async function sleep(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
}
async function retrieveWithRetry(retriever, params) {
    let results = await retriever.retrieve(params);
    if (results.length === 0) {
        await sleep(75);
        results = await retriever.retrieve(params);
    }
    return results;
}
async function resolveMemoryId(context, memoryRef, scopeFilter) {
    const trimmed = memoryRef.trim();
    if (!trimmed) {
        return {
            ok: false,
            message: "memoryId/query 不能为空。",
            details: { error: "empty_memory_ref" },
        };
    }
    const uuidLike = /^[0-9a-f]{8}(-[0-9a-f]{4}){0,4}/i.test(trimmed);
    if (uuidLike) {
        return { ok: true, id: trimmed };
    }
    const results = await retrieveWithRetry(context.retriever, {
        query: trimmed,
        limit: 5,
        scopeFilter,
    });
    if (results.length === 0) {
        return {
            ok: false,
            message: `No memory found matching "${trimmed}".`,
            details: { error: "not_found", query: trimmed },
        };
    }
    if (results.length === 1 || results[0].score > 0.85) {
        return { ok: true, id: results[0].entry.id };
    }
    const list = results
        .map((r) => `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}${r.entry.text.length > 60 ? "..." : ""}`)
        .join("\n");
    return {
        ok: false,
        message: `Multiple matches. Specify memoryId:\n${list}`,
        details: {
            action: "candidates",
            candidates: sanitizeMemoryForSerialization(results),
        },
    };
}
function resolveWorkspaceDir(toolCtx, fallback) {
    const runtime = toolCtx;
    const runtimePath = typeof runtime?.workspaceDir === "string" ? runtime.workspaceDir.trim() : "";
    if (runtimePath)
        return runtimePath;
    if (fallback && fallback.trim())
        return fallback;
    return join(homedir(), ".openclaw", "workspace");
}
function escapeRegExp(input) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function registerSelfImprovementLogTool(api, context) {
    api.registerTool((toolCtx) => ({
        name: "self_improvement_log",
        label: "Self-Improvement Log",
        description: "Log structured learning/error entries into .learnings for governance and later distillation.",
        parameters: Type.Object({
            type: stringEnum(["learning", "error"]),
            summary: Type.String({ description: "One-line summary" }),
            details: Type.Optional(Type.String({ description: "Detailed context or error output" })),
            suggestedAction: Type.Optional(Type.String({ description: "Concrete action to prevent recurrence" })),
            category: Type.Optional(Type.String({ description: "learning category (correction/best_practice/knowledge_gap) when type=learning" })),
            area: Type.Optional(Type.String({ description: "frontend|backend|infra|tests|docs|config or custom area" })),
            priority: Type.Optional(Type.String({ description: "low|medium|high|critical" })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
            const { type, summary, details = "", suggestedAction = "", category = "best_practice", area = "config", priority = "medium", } = params;
            try {
                const workspaceDir = resolveWorkspaceDir(toolCtx, context.workspaceDir);
                const { id: entryId, filePath } = await appendSelfImprovementEntry({
                    baseDir: workspaceDir,
                    type,
                    summary,
                    details,
                    suggestedAction,
                    category,
                    area,
                    priority,
                    source: "scope-recall-openclaw/self_improvement_log",
                });
                const fileName = type === "learning" ? "LEARNINGS.md" : "ERRORS.md";
                return {
                    content: [{ type: "text", text: `Logged ${type} entry ${entryId} to .learnings/${fileName}` }],
                    details: { action: "logged", type, id: entryId, filePath },
                };
            }
            catch (error) {
                return {
                    content: [{ type: "text", text: `Failed to log self-improvement entry: ${error instanceof Error ? error.message : String(error)}` }],
                    details: { error: "self_improvement_log_failed", message: String(error) },
                };
            }
        },
    }), { name: "self_improvement_log" });
}
export function registerSelfImprovementExtractSkillTool(api, context) {
    api.registerTool((toolCtx) => ({
        name: "self_improvement_extract_skill",
        label: "Extract Skill From Learning",
        description: "Create a new skill scaffold from a learning entry and mark the source learning as promoted_to_skill.",
        parameters: Type.Object({
            learningId: Type.String({ description: "Learning ID like LRN-YYYYMMDD-001" }),
            skillName: Type.String({ description: "Skill folder name, lowercase with hyphens" }),
            sourceFile: Type.Optional(stringEnum(["LEARNINGS.md", "ERRORS.md"])),
            outputDir: Type.Optional(Type.String({ description: "Relative output dir under workspace (default: skills)" })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
            const { learningId, skillName, sourceFile = "LEARNINGS.md", outputDir = "skills" } = params;
            try {
                if (!/^(LRN|ERR)-\d{8}-\d{3}$/.test(learningId)) {
                    return {
                        content: [{ type: "text", text: "Invalid learningId format. Use LRN-YYYYMMDD-001 / ERR-..." }],
                        details: { error: "invalid_learning_id" },
                    };
                }
                if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillName)) {
                    return {
                        content: [{ type: "text", text: "Invalid skillName. Use lowercase letters, numbers, and hyphens only." }],
                        details: { error: "invalid_skill_name" },
                    };
                }
                const workspaceDir = resolveWorkspaceDir(toolCtx, context.workspaceDir);
                await ensureSelfImprovementLearningFiles(workspaceDir);
                const learningsPath = join(workspaceDir, ".learnings", sourceFile);
                const learningBody = await readFile(learningsPath, "utf-8");
                const escapedLearningId = escapeRegExp(learningId.trim());
                const entryRegex = new RegExp(`## \\[${escapedLearningId}\\][\\s\\S]*?(?=\\n## \\[|$)`, "m");
                const match = learningBody.match(entryRegex);
                if (!match) {
                    return {
                        content: [{ type: "text", text: `Learning entry ${learningId} not found in .learnings/${sourceFile}` }],
                        details: { error: "learning_not_found", learningId, sourceFile },
                    };
                }
                const summaryMatch = match[0].match(/### Summary\n([\s\S]*?)\n###/m);
                const summary = (summaryMatch?.[1] ?? "Summarize the source learning here.").trim();
                const safeOutputDir = outputDir
                    .replace(/\\/g, "/")
                    .split("/")
                    .filter((segment) => segment && segment !== "." && segment !== "..")
                    .join("/");
                const skillDir = join(workspaceDir, safeOutputDir || "skills", skillName);
                await mkdir(skillDir, { recursive: true });
                const skillPath = join(skillDir, "SKILL.md");
                const skillTitle = skillName
                    .split("-")
                    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
                    .join(" ");
                const skillContent = [
                    "---",
                    `name: ${skillName}`,
                    `description: "Extracted from learning ${learningId}. Replace with a concise description."`,
                    "---",
                    "",
                    `# ${skillTitle}`,
                    "",
                    "## Why",
                    summary,
                    "",
                    "## When To Use",
                    "- [TODO] Define trigger conditions",
                    "",
                    "## Steps",
                    "1. [TODO] Add repeatable workflow steps",
                    "2. [TODO] Add verification steps",
                    "",
                    "## Source Learning",
                    `- Learning ID: ${learningId}`,
                    `- Source File: .learnings/${sourceFile}`,
                    "",
                ].join("\n");
                await writeFile(skillPath, skillContent, "utf-8");
                const promotedMarker = `**Status**: promoted_to_skill`;
                const skillPathMarker = `- Skill-Path: ${safeOutputDir || "skills"}/${skillName}`;
                let updatedEntry = match[0];
                updatedEntry = updatedEntry.includes("**Status**:")
                    ? updatedEntry.replace(/\*\*Status\*\*:\s*.+/m, promotedMarker)
                    : `${updatedEntry.trimEnd()}\n${promotedMarker}\n`;
                if (!updatedEntry.includes("Skill-Path:")) {
                    updatedEntry = `${updatedEntry.trimEnd()}\n${skillPathMarker}\n`;
                }
                const updatedLearningBody = learningBody.replace(match[0], updatedEntry);
                await writeFile(learningsPath, updatedLearningBody, "utf-8");
                return {
                    content: [{ type: "text", text: `Extracted skill scaffold to ${safeOutputDir || "skills"}/${skillName}/SKILL.md and updated ${learningId}.` }],
                    details: {
                        action: "skill_extracted",
                        learningId,
                        sourceFile,
                        skillPath: `${safeOutputDir || "skills"}/${skillName}/SKILL.md`,
                    },
                };
            }
            catch (error) {
                return {
                    content: [{ type: "text", text: `Failed to extract skill: ${error instanceof Error ? error.message : String(error)}` }],
                    details: { error: "self_improvement_extract_skill_failed", message: String(error) },
                };
            }
        },
    }), { name: "self_improvement_extract_skill" });
}
export function registerSelfImprovementReviewTool(api, context) {
    api.registerTool((toolCtx) => ({
        name: "self_improvement_review",
        label: "Self-Improvement Review",
        description: "Summarize governance backlog from .learnings files (pending/high-priority/promoted counts).",
        parameters: Type.Object({}),
        async execute() {
            try {
                const workspaceDir = resolveWorkspaceDir(toolCtx, context.workspaceDir);
                await ensureSelfImprovementLearningFiles(workspaceDir);
                const learningsDir = join(workspaceDir, ".learnings");
                const files = ["LEARNINGS.md", "ERRORS.md"];
                const stats = { pending: 0, high: 0, promoted: 0, total: 0 };
                for (const f of files) {
                    const content = await readFile(join(learningsDir, f), "utf-8").catch(() => "");
                    stats.total += (content.match(/^## \[/gm) || []).length;
                    stats.pending += (content.match(/\*\*Status\*\*:\s*pending/gi) || []).length;
                    stats.high += (content.match(/\*\*Priority\*\*:\s*(high|critical)/gi) || []).length;
                    stats.promoted += (content.match(/\*\*Status\*\*:\s*promoted(_to_skill)?/gi) || []).length;
                }
                const text = [
                    "Self-Improvement Governance Snapshot:",
                    `- Total entries: ${stats.total}`,
                    `- Pending: ${stats.pending}`,
                    `- High/Critical: ${stats.high}`,
                    `- Promoted: ${stats.promoted}`,
                    "",
                    "Recommended loop:",
                    "1) Resolve high-priority pending entries",
                    "2) Distill reusable rules into AGENTS.md / SOUL.md / TOOLS.md",
                    "3) Extract repeatable patterns as skills",
                ].join("\n");
                return {
                    content: [{ type: "text", text }],
                    details: { action: "review", stats },
                };
            }
            catch (error) {
                return {
                    content: [{ type: "text", text: `Failed to review self-improvement backlog: ${error instanceof Error ? error.message : String(error)}` }],
                    details: { error: "self_improvement_review_failed", message: String(error) },
                };
            }
        },
    }), { name: "self_improvement_review" });
}
// ============================================================================
// Core Tools (Backward Compatible)
// ============================================================================
export function registerMemoryRecallTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_recall",
            label: "Memory Recall",
            description: "Search through long-term memories using hybrid retrieval (vector + keyword search). Use when you need context about user preferences, past decisions, or previously discussed topics.",
            parameters: Type.Object({
                query: Type.String({
                    description: "Search query for finding relevant memories",
                }),
                limit: Type.Optional(Type.Number({
                    description: "Max results to return (default: 3, max: 20; summary mode soft max: 6)",
                })),
                includeFullText: Type.Optional(Type.Boolean({
                    description: "Return full memory text when true (default: false returns summary previews)",
                })),
                maxCharsPerItem: Type.Optional(Type.Number({
                    description: "Maximum characters per returned memory in summary mode (default: 180)",
                })),
                scope: Type.Optional(Type.String({
                    description: "Specific memory scope to search in (optional)",
                })),
                category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { query, limit = 3, includeFullText = false, maxCharsPerItem = 180, scope, category, } = params;
                try {
                    const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_recall");
                    if (agentResolution.ok === false)
                        return agentResolution.response;
                    const agentId = agentResolution.agentId;
                    const safeLimit = includeFullText
                        ? clampInt(limit, 1, 20)
                        : clampInt(limit, 1, 6);
                    const safeCharsPerItem = clampInt(maxCharsPerItem, 60, 1000);
                    // Determine accessible scopes
                    let scopeFilter = resolveScopeFilter(runtimeContext.scopeManager, agentId);
                    if (scope) {
                        if (runtimeContext.scopeManager.isAccessible(scope, agentId)) {
                            scopeFilter = [scope];
                        }
                        else {
                            return {
                                content: [
                                    { type: "text", text: `Access denied to scope: ${scope}` },
                                ],
                                details: {
                                    error: "scope_access_denied",
                                    requestedScope: scope,
                                },
                            };
                        }
                    }
                    const results = filterUserMdExclusiveRecallResults(await retrieveWithRetry(runtimeContext.retriever, {
                        query,
                        limit: safeLimit,
                        scopeFilter,
                        category,
                        source: "manual",
                    }), runtimeContext.workspaceBoundary);
                    if (results.length === 0) {
                        return {
                            content: [{ type: "text", text: "No relevant memories found." }],
                            details: { count: 0, query, scopes: scopeFilter },
                        };
                    }
                    const now = Date.now();
                    await Promise.allSettled(results.map((result) => {
                        const meta = parseSmartMetadata(result.entry.metadata, result.entry);
                        return runtimeContext.store.patchMetadata(result.entry.id, {
                            access_count: meta.access_count + 1,
                            last_accessed_at: now,
                            last_confirmed_use_at: now,
                            bad_recall_count: 0,
                            suppressed_until_turn: 0,
                        }, scopeFilter);
                    }));
                    const text = results
                        .map((r, i) => {
                        const categoryTag = getDisplayCategoryTag(r.entry);
                        const metadata = parseSmartMetadata(r.entry.metadata, r.entry);
                        const base = includeFullText
                            ? (metadata.l2_content || metadata.l1_overview || r.entry.text)
                            : (metadata.l0_abstract || r.entry.text);
                        const inline = normalizeInlineText(base);
                        const rendered = includeFullText
                            ? inline
                            : truncateText(inline, safeCharsPerItem);
                        return `${i + 1}. [${r.entry.id}] [${categoryTag}] ${rendered}`;
                    })
                        .join("\n");
                    const serializedMemories = sanitizeMemoryForSerialization(results);
                    if (includeFullText) {
                        for (let i = 0; i < results.length; i++) {
                            const metadata = parseSmartMetadata(results[i].entry.metadata, results[i].entry);
                            serializedMemories[i].fullText =
                                metadata.l2_content || metadata.l1_overview || results[i].entry.text;
                        }
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Found ${results.length} memories:\n\n${text}`,
                            },
                        ],
                        details: {
                            count: results.length,
                            memories: serializedMemories,
                            query,
                            scopes: scopeFilter,
                            retrievalMode: runtimeContext.retriever.getConfig().mode,
                        },
                    };
                }
                catch (error) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Memory recall failed: ${error instanceof Error ? error.message : String(error)}`,
                            },
                        ],
                        details: { error: "recall_failed", message: String(error) },
                    };
                }
            },
        };
    }, { name: "memory_recall" });
}
export function registerMemoryStoreTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_store",
            label: "Memory Store",
            description: "Save important information in long-term memory. Use for preferences, facts, decisions, and other notable information.",
            parameters: Type.Object({
                text: Type.String({ description: "Information to remember" }),
                importance: Type.Optional(Type.Number({ description: "Importance score 0-1 (default: 0.7)" })),
                category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
                scope: Type.Optional(Type.String({
                    description: "Memory scope (optional, defaults to agent scope)",
                })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { text, importance = 0.7, category = "other", scope, } = params;
                try {
                    const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_store");
                    if (agentResolution.ok === false)
                        return agentResolution.response;
                    const agentId = agentResolution.agentId;
                    // Determine target scope
                    let targetScope = scope;
                    if (!targetScope) {
                        if (isSystemBypassId(agentId)) {
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: "Reserved bypass agent IDs must provide an explicit scope for memory_store writes.",
                                    },
                                ],
                                details: {
                                    error: "explicit_scope_required",
                                    agentId,
                                },
                            };
                        }
                        targetScope = runtimeContext.scopeManager.getDefaultScope(agentId);
                    }
                    // Validate scope access
                    if (!runtimeContext.scopeManager.isAccessible(targetScope, agentId)) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Access denied to scope: ${targetScope}`,
                                },
                            ],
                            details: {
                                error: "scope_access_denied",
                                requestedScope: targetScope,
                            },
                        };
                    }
                    const enrichedText = enrichContentWithArtifactAnchors(text);
                    const captureSafety = evaluateCaptureSafety(enrichedText);
                    if (!captureSafety.allowed) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Skipped: text blocked by capture safety filter (${captureSafety.reason})`,
                                },
                            ],
                            details: {
                                action: "capture_safety_filtered",
                                reason: captureSafety.reason,
                                pattern: captureSafety.pattern,
                            },
                        };
                    }
                    // Reject noise before wasting an embedding API call
                    if (isNoise(enrichedText)) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Skipped: text detected as noise (greeting, boilerplate, or meta-question)`,
                                },
                            ],
                            details: { action: "noise_filtered", text: enrichedText.slice(0, 60) },
                        };
                    }
                    if (isUserMdExclusiveMemory({ text: enrichedText }, runtimeContext.workspaceBoundary)) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "Skipped: this fact belongs in USER.md, not plugin memory.",
                                },
                            ],
                            details: {
                                action: "skipped_by_workspace_boundary",
                                boundary: "user_md_exclusive",
                            },
                        };
                    }
                    const safeImportance = clamp01(importance, 0.7);
                    const vector = await runtimeContext.embedder.embedPassage(enrichedText);
                    // Check for duplicates using raw vector similarity (bypasses importance/recency weighting)
                    // Fail-open by design: dedup must never block a legitimate memory write.
                    // excludeInactive: superseded historical records must not block new writes.
                    let existing = [];
                    try {
                        existing = await runtimeContext.store.vectorSearch(vector, 1, 0.1, [
                            targetScope,
                        ], { excludeInactive: true });
                    }
                    catch (err) {
                        console.warn(`scope-recall-openclaw: duplicate pre-check failed, continue store: ${String(err)}`);
                    }
                    if (existing.length > 0 && existing[0].score > 0.98) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Similar memory already exists: "${existing[0].entry.text}"`,
                                },
                            ],
                            details: {
                                action: "duplicate",
                                existingId: existing[0].entry.id,
                                existingText: existing[0].entry.text,
                                existingScope: existing[0].entry.scope,
                                similarity: existing[0].score,
                            },
                        };
                    }
                    const entry = await runtimeContext.store.store({
                        text: enrichedText,
                        vector,
                        importance: safeImportance,
                        category: category,
                        scope: targetScope,
                        metadata: stringifySmartMetadata(mergeArtifactMetadata(buildSmartMetadata({
                            text: enrichedText,
                            category: category,
                            importance: safeImportance,
                        }, {
                            l0_abstract: enrichedText,
                            l1_overview: `- ${enrichedText}`,
                            l2_content: enrichedText,
                            source: "manual",
                            state: "confirmed",
                            memory_layer: deriveManualMemoryLayer(category),
                            last_confirmed_use_at: Date.now(),
                            bad_recall_count: 0,
                            suppressed_until_turn: 0,
                        }), enrichedText)),
                    });
                    let conflictReview;
                    try {
                        conflictReview = await recordConflictReviewRelations(runtimeContext.store, entry, [targetScope]);
                    }
                    catch (err) {
                        console.warn(`scope-recall-openclaw: conflict-review marking failed: ${String(err)}`);
                    }
                    // Dual-write to Markdown mirror if enabled
                    if (context.mdMirror) {
                        await context.mdMirror({ text: enrichedText, category: category, scope: targetScope, timestamp: entry.timestamp }, { source: "memory_store", agentId });
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Stored: "${enrichedText.slice(0, 100)}${enrichedText.length > 100 ? "..." : ""}" in scope '${targetScope}'`,
                            },
                        ],
                        details: {
                            action: "created",
                            id: entry.id,
                            scope: entry.scope,
                            category: entry.category,
                            importance: entry.importance,
                            conflictReview,
                        },
                    };
                }
                catch (error) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Memory storage failed: ${error instanceof Error ? error.message : String(error)}`,
                            },
                        ],
                        details: { error: "store_failed", message: String(error) },
                    };
                }
            },
        };
    }, { name: "memory_store" });
}
export function registerMemoryStoreSecretIndexTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_store_secret_index",
            label: "Memory Store Secret Index",
            description: "Store searchable credential index metadata and vault references without storing plaintext secret values.",
            parameters: Type.Object({
                label: Type.Optional(Type.String({ description: "Human-readable credential label" })),
                service: Type.Optional(Type.String({ description: "Service or product name" })),
                account: Type.Optional(Type.String({ description: "Account, tenant, or project name" })),
                username: Type.Optional(Type.String({ description: "Username or login identifier" })),
                hostname: Type.Optional(Type.String({ description: "Host or server name" })),
                vaultRef: Type.Optional(Type.String({ description: "External vault/keyring reference or locator" })),
                secretType: Type.Optional(Type.String({ description: "password, token, api_key, private_key, cookie, credential, or other" })),
                rotationDue: Type.Optional(Type.String({ description: "Optional rotation due date" })),
                notes: Type.Optional(Type.String({ description: "Non-secret notes" })),
                entities: Type.Optional(Type.Array(Type.String())),
                tags: Type.Optional(Type.Array(Type.String())),
                secretValue: Type.Optional(Type.String({ description: "Optional plaintext used only to compute a short SHA-256 fingerprint; never stored" })),
                scope: Type.Optional(Type.String({ description: "Memory scope (optional, defaults to agent scope)" })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                try {
                    const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_store_secret_index");
                    if (agentResolution.ok === false)
                        return agentResolution.response;
                    const agentId = agentResolution.agentId;
                    const raw = params;
                    let targetScope = typeof raw.scope === "string" && raw.scope.trim() ? raw.scope.trim() : undefined;
                    if (!targetScope) {
                        if (isSystemBypassId(agentId)) {
                            return {
                                content: [{ type: "text", text: "Reserved bypass agent IDs must provide an explicit scope for secret index writes." }],
                                details: { error: "explicit_scope_required", agentId },
                            };
                        }
                        targetScope = runtimeContext.scopeManager.getDefaultScope(agentId);
                    }
                    if (!runtimeContext.scopeManager.isAccessible(targetScope, agentId)) {
                        return {
                            content: [{ type: "text", text: `Access denied to scope: ${targetScope}` }],
                            details: { error: "scope_access_denied", requestedScope: targetScope },
                        };
                    }
                    const { content: text, metadata: secretMetadata } = buildSecretIndex(raw);
                    const vector = await runtimeContext.embedder.embedPassage(text);
                    const importance = clamp01(secretMetadata.importance, 0.82);
                    const entry = await runtimeContext.store.store({
                        text,
                        vector,
                        importance,
                        category: "fact",
                        scope: targetScope,
                        metadata: stringifySmartMetadata(buildSmartMetadata({ text, category: "fact", importance }, {
                            ...secretMetadata,
                            l0_abstract: text.split("\n").slice(0, 4).join("; "),
                            l1_overview: text,
                            l2_content: text,
                            source: "manual",
                            state: "confirmed",
                            memory_layer: "durable",
                            last_confirmed_use_at: Date.now(),
                            bad_recall_count: 0,
                            suppressed_until_turn: 0,
                        })),
                    });
                    return {
                        content: [{ type: "text", text: `Stored secret index ${entry.id.slice(0, 8)} in scope '${targetScope}' without plaintext secret value.` }],
                        details: {
                            action: "stored_secret_index",
                            id: entry.id,
                            scope: targetScope,
                            plaintextStored: false,
                        },
                    };
                }
                catch (error) {
                    return {
                        content: [{ type: "text", text: `Secret index store failed: ${error instanceof Error ? error.message : String(error)}` }],
                        details: { error: "secret_index_store_failed", message: String(error) },
                    };
                }
            },
        };
    }, { name: "memory_store_secret_index" });
}
export function registerMemoryForgetTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_forget",
            label: "Memory Forget",
            description: "Preview and delete specific memories. Deletion requires confirm=true.",
            parameters: Type.Object({
                query: Type.Optional(Type.String({ description: "Search query to find memory to delete" })),
                memoryId: Type.Optional(Type.String({ description: "Specific memory ID to delete" })),
                scope: Type.Optional(Type.String({
                    description: "Scope to search/delete from (optional)",
                })),
                confirm: Type.Optional(Type.Boolean({
                    description: "Required true to delete a memoryId. Query mode returns candidates for confirmation.",
                })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { query, memoryId, scope, confirm } = params;
                try {
                    const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_forget");
                    if (agentResolution.ok === false)
                        return agentResolution.response;
                    const agentId = agentResolution.agentId;
                    // Determine accessible scopes
                    let scopeFilter = resolveScopeFilter(runtimeContext.scopeManager, agentId);
                    if (scope) {
                        if (runtimeContext.scopeManager.isAccessible(scope, agentId)) {
                            scopeFilter = [scope];
                        }
                        else {
                            return {
                                content: [
                                    { type: "text", text: `Access denied to scope: ${scope}` },
                                ],
                                details: {
                                    error: "scope_access_denied",
                                    requestedScope: scope,
                                },
                            };
                        }
                    }
                    if (memoryId) {
                        if (confirm !== true) {
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `Deletion requires confirm=true for memoryId ${memoryId}.`,
                                    },
                                ],
                                details: {
                                    action: "confirmation_required",
                                    id: memoryId,
                                },
                            };
                        }
                        const deleted = await context.store.delete(memoryId, scopeFilter);
                        if (deleted) {
                            return {
                                content: [
                                    { type: "text", text: `Memory ${memoryId} forgotten.` },
                                ],
                                details: { action: "deleted", id: memoryId },
                            };
                        }
                        else {
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `Memory ${memoryId} not found or access denied.`,
                                    },
                                ],
                                details: { error: "not_found", id: memoryId },
                            };
                        }
                    }
                    if (query) {
                        const results = await retrieveWithRetry(context.retriever, {
                            query,
                            limit: 5,
                            scopeFilter,
                        });
                        if (results.length === 0) {
                            return {
                                content: [
                                    { type: "text", text: "No matching memories found." },
                                ],
                                details: { found: 0, query },
                            };
                        }
                        const list = results
                            .map((r) => `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}${r.entry.text.length > 60 ? "..." : ""}`)
                            .join("\n");
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Found ${results.length} candidates. Specify memoryId to delete:\n${list}`,
                                },
                            ],
                            details: {
                                action: "candidates",
                                candidates: sanitizeMemoryForSerialization(results),
                            },
                        };
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text: "Provide either 'query' to search for memories or 'memoryId' to delete specific memory.",
                            },
                        ],
                        details: { error: "missing_param" },
                    };
                }
                catch (error) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Memory deletion failed: ${error instanceof Error ? error.message : String(error)}`,
                            },
                        ],
                        details: { error: "delete_failed", message: String(error) },
                    };
                }
            },
        };
    }, { name: "memory_forget" });
}
// ============================================================================
// Update Tool
// ============================================================================
export function registerMemoryUpdateTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_update",
            label: "Memory Update",
            description: "Update an existing memory. For preferences/entities, changing text creates a new version (supersede) to preserve history. Metadata-only changes (importance, category) update in-place.",
            parameters: Type.Object({
                memoryId: Type.String({
                    description: "ID of the memory to update (full UUID or 8+ char prefix)",
                }),
                text: Type.Optional(Type.String({
                    description: "New text content (triggers re-embedding)",
                })),
                importance: Type.Optional(Type.Number({ description: "New importance score 0-1" })),
                category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { memoryId, text, importance, category } = params;
                try {
                    if (!text && importance === undefined && !category) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "Nothing to update. Provide at least one of: text, importance, category.",
                                },
                            ],
                            details: { error: "no_updates" },
                        };
                    }
                    // Determine accessible scopes
                    const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_update");
                    if (agentResolution.ok === false)
                        return agentResolution.response;
                    const agentId = agentResolution.agentId;
                    const scopeFilter = resolveScopeFilter(runtimeContext.scopeManager, agentId);
                    // Resolve memoryId: if it doesn't look like a UUID, try search
                    let resolvedId = memoryId;
                    const uuidLike = /^[0-9a-f]{8}(-[0-9a-f]{4}){0,4}/i.test(memoryId);
                    if (!uuidLike) {
                        // Treat as search query
                        const results = await retrieveWithRetry(context.retriever, {
                            query: memoryId,
                            limit: 3,
                            scopeFilter,
                        });
                        if (results.length === 0) {
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `No memory found matching "${memoryId}".`,
                                    },
                                ],
                                details: { error: "not_found", query: memoryId },
                            };
                        }
                        if (results.length === 1 || results[0].score > 0.85) {
                            resolvedId = results[0].entry.id;
                        }
                        else {
                            const list = results
                                .map((r) => `- [${r.entry.id.slice(0, 8)}] ${r.entry.text.slice(0, 60)}${r.entry.text.length > 60 ? "..." : ""}`)
                                .join("\n");
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `Multiple matches. Specify memoryId:\n${list}`,
                                    },
                                ],
                                details: {
                                    action: "candidates",
                                    candidates: sanitizeMemoryForSerialization(results),
                                },
                            };
                        }
                    }
                    // If text changed, re-embed; reject noise
                    let newVector;
                    if (text) {
                        if (isNoise(text)) {
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: "Skipped: updated text detected as noise",
                                    },
                                ],
                                details: { action: "noise_filtered" },
                            };
                        }
                        newVector = await context.embedder.embedPassage(text);
                    }
                    // --- Temporal supersede guard ---
                    // For temporal-versioned categories (preferences/entities), changing
                    // text must go through supersede to preserve the history chain.
                    if (text && newVector) {
                        const existing = await context.store.getById(resolvedId, scopeFilter);
                        if (existing) {
                            const meta = parseSmartMetadata(existing.metadata, existing);
                            if (TEMPORAL_VERSIONED_CATEGORIES.has(meta.memory_category)) {
                                const now = Date.now();
                                const factKey = meta.fact_key ?? deriveFactKey(meta.memory_category, text);
                                // Create new superseding record
                                const newMeta = buildSmartMetadata({ text, category: existing.category }, {
                                    l0_abstract: text,
                                    l1_overview: meta.l1_overview,
                                    l2_content: text,
                                    memory_category: meta.memory_category,
                                    tier: meta.tier,
                                    access_count: 0,
                                    confidence: importance !== undefined ? clamp01(importance, 0.7) : meta.confidence,
                                    valid_from: now,
                                    fact_key: factKey,
                                    supersedes: resolvedId,
                                    relations: appendRelation([], {
                                        type: "supersedes",
                                        targetId: resolvedId,
                                    }),
                                });
                                const newEntry = await context.store.store({
                                    text,
                                    vector: newVector,
                                    category: category ? category : existing.category,
                                    scope: existing.scope,
                                    importance: importance !== undefined
                                        ? clamp01(importance, 0.7)
                                        : existing.importance,
                                    metadata: stringifySmartMetadata(newMeta),
                                });
                                // Invalidate old record (metadata-only patch — safe)
                                try {
                                    const invalidatedMeta = buildSmartMetadata(existing, {
                                        fact_key: factKey,
                                        invalidated_at: now,
                                        superseded_by: newEntry.id,
                                        relations: appendRelation(meta.relations, {
                                            type: "superseded_by",
                                            targetId: newEntry.id,
                                        }),
                                    });
                                    await context.store.update(resolvedId, { metadata: stringifySmartMetadata(invalidatedMeta) }, scopeFilter);
                                }
                                catch (patchErr) {
                                    // New record is already the source of truth; log but don't fail
                                    console.warn(`scope-recall: failed to patch superseded record ${resolvedId.slice(0, 8)}: ${patchErr}`);
                                }
                                return {
                                    content: [
                                        {
                                            type: "text",
                                            text: `Superseded memory ${resolvedId.slice(0, 8)}... → new version ${newEntry.id.slice(0, 8)}...: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`,
                                        },
                                    ],
                                    details: {
                                        action: "superseded",
                                        oldId: resolvedId,
                                        newId: newEntry.id,
                                        category: meta.memory_category,
                                    },
                                };
                            }
                        }
                    }
                    // --- End temporal supersede guard ---
                    const updates = {};
                    if (text)
                        updates.text = text;
                    if (newVector)
                        updates.vector = newVector;
                    if (importance !== undefined)
                        updates.importance = clamp01(importance, 0.7);
                    if (category)
                        updates.category = category;
                    const updated = await context.store.update(resolvedId, updates, scopeFilter);
                    if (!updated) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Memory ${resolvedId.slice(0, 8)}... not found or access denied.`,
                                },
                            ],
                            details: { error: "not_found", id: resolvedId },
                        };
                    }
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Updated memory ${updated.id.slice(0, 8)}...: "${updated.text.slice(0, 80)}${updated.text.length > 80 ? "..." : ""}"`,
                            },
                        ],
                        details: {
                            action: "updated",
                            id: updated.id,
                            scope: updated.scope,
                            category: updated.category,
                            importance: updated.importance,
                            fieldsUpdated: Object.keys(updates),
                        },
                    };
                }
                catch (error) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Memory update failed: ${error instanceof Error ? error.message : String(error)}`,
                            },
                        ],
                        details: { error: "update_failed", message: String(error) },
                    };
                }
            },
        };
    }, { name: "memory_update" });
}
// ============================================================================
// Management Tools (Optional)
// ============================================================================
export function registerMemoryStatsTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_stats",
            label: "Memory Statistics",
            description: "Get statistics about memory usage, scopes, and categories.",
            parameters: Type.Object({
                scope: Type.Optional(Type.String({
                    description: "Specific scope to get stats for (optional)",
                })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { scope } = params;
                try {
                    const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_stats");
                    if (agentResolution.ok === false)
                        return agentResolution.response;
                    const agentId = agentResolution.agentId;
                    // Determine accessible scopes
                    let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
                    if (scope) {
                        if (context.scopeManager.isAccessible(scope, agentId)) {
                            scopeFilter = [scope];
                        }
                        else {
                            return {
                                content: [
                                    { type: "text", text: `Access denied to scope: ${scope}` },
                                ],
                                details: {
                                    error: "scope_access_denied",
                                    requestedScope: scope,
                                },
                            };
                        }
                    }
                    const stats = await context.store.stats(scopeFilter);
                    const scopeManagerStats = context.scopeManager.getStats();
                    const retrievalConfig = context.retriever.getConfig();
                    const textLines = [
                        `Memory Statistics:`,
                        `\u2022 Total memories: ${stats.totalCount}`,
                        `\u2022 Available scopes: ${scopeManagerStats.totalScopes}`,
                        `\u2022 Retrieval mode: ${retrievalConfig.mode}`,
                        `\u2022 FTS support: ${context.store.hasFtsSupport ? "Yes" : "No"}`,
                        ``,
                        `Memories by scope:`,
                        ...Object.entries(stats.scopeCounts).map(([s, count]) => `  \u2022 ${s}: ${count}`),
                        ``,
                        `Memories by category:`,
                        ...Object.entries(stats.categoryCounts).map(([c, count]) => `  \u2022 ${c}: ${count}`),
                    ];
                    // Include retrieval quality metrics if stats collector is available
                    const statsCollector = context.retriever.getStatsCollector();
                    let retrievalStats = undefined;
                    if (statsCollector && statsCollector.count > 0) {
                        retrievalStats = statsCollector.getStats();
                        textLines.push(``, `Retrieval Quality (last ${retrievalStats.totalQueries} queries):`, `  \u2022 Zero-result queries: ${retrievalStats.zeroResultQueries}`, `  \u2022 Avg latency: ${retrievalStats.avgLatencyMs}ms`, `  \u2022 P95 latency: ${retrievalStats.p95LatencyMs}ms`, `  \u2022 Avg result count: ${retrievalStats.avgResultCount}`, `  \u2022 Rerank used: ${retrievalStats.rerankUsed}`, `  \u2022 Noise filtered: ${retrievalStats.noiseFiltered}`);
                        if (retrievalStats.topDropStages.length > 0) {
                            textLines.push(`  Top drop stages:`);
                            for (const ds of retrievalStats.topDropStages) {
                                textLines.push(`    \u2022 ${ds.name}: ${ds.totalDropped} dropped`);
                            }
                        }
                    }
                    const text = textLines.join("\n");
                    return {
                        content: [{ type: "text", text }],
                        details: {
                            stats,
                            scopeManagerStats,
                            retrievalConfig: {
                                ...retrievalConfig,
                                rerankApiKey: retrievalConfig.rerankApiKey ? "***" : undefined,
                            },
                            hasFtsSupport: context.store.hasFtsSupport,
                            retrievalStats,
                        },
                    };
                }
                catch (error) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Failed to get memory stats: ${error instanceof Error ? error.message : String(error)}`,
                            },
                        ],
                        details: { error: "stats_failed", message: String(error) },
                    };
                }
            },
        };
    }, { name: "memory_stats" });
}
export function registerMemoryDebugTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_debug",
            label: "Memory Debug",
            description: "Debug memory retrieval: search with full pipeline trace showing per-stage drop info, score ranges, and timing.",
            parameters: Type.Object({
                query: Type.String({ description: "Search query to debug" }),
                limit: Type.Optional(Type.Number({ description: "Max results to return (default: 5, max: 20)" })),
                scope: Type.Optional(Type.String({ description: "Specific memory scope to search in (optional)" })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { query, limit = 5, scope } = params;
                try {
                    const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_debug");
                    if (agentResolution.ok === false)
                        return agentResolution.response;
                    const agentId = agentResolution.agentId;
                    const safeLimit = clampInt(limit, 1, 20);
                    let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
                    if (scope) {
                        if (context.scopeManager.isAccessible(scope, agentId)) {
                            scopeFilter = [scope];
                        }
                        else {
                            return {
                                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                                details: { error: "scope_access_denied", requestedScope: scope },
                            };
                        }
                    }
                    const { results, trace } = await context.retriever.retrieveWithTrace({
                        query, limit: safeLimit, scopeFilter, source: "manual",
                    });
                    const traceLines = [
                        `Retrieval Debug Trace:`,
                        `  Mode: ${trace.mode}`,
                        `  Total: ${trace.totalMs}ms`,
                        `  Stages:`,
                    ];
                    for (const stage of trace.stages) {
                        const dropped = Math.max(0, stage.inputCount - stage.outputCount);
                        const scoreStr = stage.scoreRange
                            ? ` scores=[${stage.scoreRange[0].toFixed(3)}, ${stage.scoreRange[1].toFixed(3)}]`
                            : "";
                        // For search stages (input=0), show "found N" instead of "dropped -N"
                        const dropStr = stage.inputCount === 0
                            ? `found ${stage.outputCount}`
                            : `${stage.inputCount} -> ${stage.outputCount} (-${dropped})`;
                        traceLines.push(`    ${stage.name}: ${dropStr} ${stage.durationMs}ms${scoreStr}`);
                        if (stage.droppedIds.length > 0 && stage.droppedIds.length <= 3) {
                            traceLines.push(`      dropped: ${stage.droppedIds.join(", ")}`);
                        }
                        else if (stage.droppedIds.length > 3) {
                            traceLines.push(`      dropped: ${stage.droppedIds.slice(0, 3).join(", ")} (+${stage.droppedIds.length - 3} more)`);
                        }
                    }
                    if (results.length === 0) {
                        traceLines.push(``, `No results survived the pipeline.`);
                        return {
                            content: [{ type: "text", text: traceLines.join("\n") }],
                            details: { count: 0, query, trace },
                        };
                    }
                    const resultLines = results.map((r, i) => {
                        const sources = [];
                        if (r.sources.vector)
                            sources.push("vector");
                        if (r.sources.bm25)
                            sources.push("BM25");
                        if (r.sources.reranked)
                            sources.push("reranked");
                        const categoryTag = getDisplayCategoryTag(r.entry);
                        return `${i + 1}. [${r.entry.id}] [${categoryTag}] ${r.entry.text.slice(0, 120)}${r.entry.text.length > 120 ? "..." : ""} (${(r.score * 100).toFixed(1)}%${sources.length > 0 ? `, ${sources.join("+")}` : ""})`;
                    });
                    const text = [...traceLines, ``, `Results (${results.length}):`, ...resultLines].join("\n");
                    return {
                        content: [{ type: "text", text }],
                        details: {
                            count: results.length,
                            memories: sanitizeMemoryForSerialization(results),
                            query,
                            trace,
                        },
                    };
                }
                catch (error) {
                    return {
                        content: [{
                                type: "text",
                                text: `Memory debug failed: ${error instanceof Error ? error.message : String(error)}`,
                            }],
                        details: { error: "debug_failed", message: String(error) },
                    };
                }
            },
        };
    }, { name: "memory_debug" });
}
export function registerMemoryListTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_list",
            label: "Memory List",
            description: "List recent memories with optional filtering by scope and category.",
            parameters: Type.Object({
                limit: Type.Optional(Type.Number({
                    description: "Max memories to list (default: 10, max: 50)",
                })),
                scope: Type.Optional(Type.String({ description: "Filter by specific scope (optional)" })),
                category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
                offset: Type.Optional(Type.Number({
                    description: "Number of memories to skip (default: 0)",
                })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { limit = 10, scope, category, offset = 0, } = params;
                try {
                    const safeLimit = clampInt(limit, 1, 50);
                    const safeOffset = clampInt(offset, 0, 1000);
                    const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_list");
                    if (agentResolution.ok === false)
                        return agentResolution.response;
                    const agentId = agentResolution.agentId;
                    // Determine accessible scopes
                    let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
                    if (scope) {
                        if (context.scopeManager.isAccessible(scope, agentId)) {
                            scopeFilter = [scope];
                        }
                        else {
                            return {
                                content: [
                                    { type: "text", text: `Access denied to scope: ${scope}` },
                                ],
                                details: {
                                    error: "scope_access_denied",
                                    requestedScope: scope,
                                },
                            };
                        }
                    }
                    const entries = await context.store.list(scopeFilter, category, safeLimit, safeOffset);
                    if (entries.length === 0) {
                        return {
                            content: [{ type: "text", text: "No memories found." }],
                            details: {
                                count: 0,
                                filters: {
                                    scope,
                                    category,
                                    limit: safeLimit,
                                    offset: safeOffset,
                                },
                            },
                        };
                    }
                    const text = entries
                        .map((entry, i) => {
                        const date = new Date(entry.timestamp)
                            .toISOString()
                            .split("T")[0];
                        const categoryTag = getDisplayCategoryTag(entry);
                        return `${safeOffset + i + 1}. [${entry.id}] [${categoryTag}] ${entry.text.slice(0, 100)}${entry.text.length > 100 ? "..." : ""} (${date})`;
                    })
                        .join("\n");
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Recent memories (showing ${entries.length}):\n\n${text}`,
                            },
                        ],
                        details: {
                            count: entries.length,
                            memories: entries.map((e) => ({
                                id: e.id,
                                text: e.text,
                                category: getDisplayCategoryTag(e),
                                rawCategory: e.category,
                                scope: e.scope,
                                importance: e.importance,
                                timestamp: e.timestamp,
                            })),
                            filters: {
                                scope,
                                category,
                                limit: safeLimit,
                                offset: safeOffset,
                            },
                        },
                    };
                }
                catch (error) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Failed to list memories: ${error instanceof Error ? error.message : String(error)}`,
                            },
                        ],
                        details: { error: "list_failed", message: String(error) },
                    };
                }
            },
        };
    }, { name: "memory_list" });
}
export function registerMemoryContextTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_context",
            label: "Memory Context",
            description: "Inspect the current accessible memory context with optional query, scope, category, source, state, and layer filters.",
            parameters: Type.Object({
                query: Type.Optional(Type.String({ description: "Optional query. When omitted, lists recent context." })),
                limit: Type.Optional(Type.Number({ description: "Max memories to return (default: 10, max: 30)" })),
                offset: Type.Optional(Type.Number({ description: "Number of recent memories to skip when query is omitted (default: 0)" })),
                scope: Type.Optional(Type.String({ description: "Filter by specific accessible scope." })),
                category: Type.Optional(stringEnum(MEMORY_CATEGORIES)),
                source: Type.Optional(Type.Union([
                    Type.Literal("manual"),
                    Type.Literal("auto-capture"),
                    Type.Literal("reflection"),
                    Type.Literal("session-summary"),
                    Type.Literal("legacy"),
                ])),
                state: Type.Optional(Type.Union([
                    Type.Literal("pending"),
                    Type.Literal("confirmed"),
                    Type.Literal("archived"),
                    Type.Literal("rejected"),
                ])),
                layer: Type.Optional(Type.Union([
                    Type.Literal("durable"),
                    Type.Literal("working"),
                    Type.Literal("reflection"),
                    Type.Literal("archive"),
                ])),
                includeFullText: Type.Optional(Type.Boolean({ description: "Return full memory text in details and rendered output." })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { query, limit = 10, offset = 0, scope, category, source, state, layer, includeFullText = false, } = params;
                try {
                    const safeLimit = clampInt(limit, 1, 30);
                    const safeOffset = clampInt(offset, 0, 1000);
                    const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_context");
                    if (agentResolution.ok === false)
                        return agentResolution.response;
                    const agentId = agentResolution.agentId;
                    let scopeFilter = resolveScopeFilter(runtimeContext.scopeManager, agentId);
                    if (scope) {
                        if (!runtimeContext.scopeManager.isAccessible(scope, agentId)) {
                            return {
                                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                                details: { error: "scope_access_denied", requestedScope: scope },
                            };
                        }
                        scopeFilter = [scope];
                    }
                    const metadataFilters = { source, state, layer };
                    let entries;
                    if (query?.trim()) {
                        const candidateLimit = Math.min(80, Math.max(safeLimit * 4, safeLimit));
                        const results = await retrieveWithRetry(runtimeContext.retriever, {
                            query: query.trim(),
                            limit: candidateLimit,
                            scopeFilter,
                            category,
                        });
                        entries = results
                            .map((result) => result.entry)
                            .filter((entry) => memoryMetadataMatches(entry, metadataFilters))
                            .slice(0, safeLimit);
                    }
                    else {
                        const scanLimit = Math.min(500, Math.max(safeOffset + safeLimit * 5, safeLimit));
                        entries = (await runtimeContext.store.list(scopeFilter, category, scanLimit, 0))
                            .filter((entry) => memoryMetadataMatches(entry, metadataFilters))
                            .slice(safeOffset, safeOffset + safeLimit);
                    }
                    if (entries.length === 0) {
                        return {
                            content: [{ type: "text", text: "No memories matched the requested context filters." }],
                            details: {
                                action: "context",
                                count: 0,
                                query,
                                filters: { scope, category, source, state, layer, limit: safeLimit, offset: safeOffset },
                                scopes: scopeFilter,
                            },
                        };
                    }
                    const lines = entries.map((entry, index) => renderMemoryEntry(entry, index, includeFullText));
                    return {
                        content: [{
                                type: "text",
                                text: `Memory context (${entries.length}):\n\n${lines.join("\n")}`,
                            }],
                        details: {
                            action: "context",
                            count: entries.length,
                            query,
                            filters: { scope, category, source, state, layer, limit: safeLimit, offset: safeOffset },
                            scopes: scopeFilter,
                            memories: entries.map((entry) => serializeMemoryEntry(entry, includeFullText)),
                        },
                    };
                }
                catch (error) {
                    return {
                        content: [{
                                type: "text",
                                text: `Memory context inspection failed: ${error instanceof Error ? error.message : String(error)}`,
                            }],
                        details: { error: "context_failed", message: String(error) },
                    };
                }
            },
        };
    }, { name: "memory_context" });
}
export function registerMemoryInspectTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_inspect",
            label: "Memory Inspect",
            description: "Inspect one memory record by id/prefix or search query, including lifecycle metadata and relation hints.",
            parameters: Type.Object({
                memoryId: Type.Optional(Type.String({ description: "Memory id or unambiguous prefix." })),
                query: Type.Optional(Type.String({ description: "Search query when memoryId is omitted." })),
                scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
                includeFullText: Type.Optional(Type.Boolean({ description: "Return L0/L1/L2 content fields." })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { memoryId, query, scope, includeFullText = true, } = params;
                if (!memoryId && !query) {
                    return {
                        content: [{ type: "text", text: "Provide memoryId or query." }],
                        details: { error: "missing_selector" },
                    };
                }
                try {
                    const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_inspect");
                    if (agentResolution.ok === false)
                        return agentResolution.response;
                    const agentId = agentResolution.agentId;
                    let scopeFilter = resolveScopeFilter(runtimeContext.scopeManager, agentId);
                    if (scope) {
                        if (!runtimeContext.scopeManager.isAccessible(scope, agentId)) {
                            return {
                                content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                                details: { error: "scope_access_denied", requestedScope: scope },
                            };
                        }
                        scopeFilter = [scope];
                    }
                    const resolved = await resolveMemoryId(runtimeContext, memoryId ?? query ?? "", scopeFilter);
                    if (resolved.ok === false) {
                        return {
                            content: [{ type: "text", text: resolved.message }],
                            details: resolved.details ?? { error: "resolve_failed" },
                        };
                    }
                    const entry = await runtimeContext.store.getById(resolved.id, scopeFilter);
                    if (!entry) {
                        return {
                            content: [{ type: "text", text: `Memory ${resolved.id.slice(0, 8)} not found.` }],
                            details: { error: "not_found", id: resolved.id },
                        };
                    }
                    const metadata = parseSmartMetadata(entry.metadata, entry);
                    const lines = [
                        renderMemoryEntry(entry, undefined, includeFullText),
                        `state=${metadata.state} layer=${metadata.memory_layer} source=${metadata.source} tier=${metadata.tier} confidence=${metadata.confidence.toFixed(2)}`,
                        `access=${metadata.access_count} injected=${metadata.injected_count} badRecall=${metadata.bad_recall_count} suppressedUntilTurn=${metadata.suppressed_until_turn}`,
                    ];
                    if (metadata.fact_key)
                        lines.push(`factKey=${metadata.fact_key}`);
                    if (metadata.supersedes)
                        lines.push(`supersedes=${metadata.supersedes}`);
                    if (metadata.superseded_by)
                        lines.push(`supersededBy=${metadata.superseded_by}`);
                    if (metadata.canonical_id)
                        lines.push(`canonicalId=${metadata.canonical_id}`);
                    if (metadata.relations?.length) {
                        lines.push(`relations=${metadata.relations.map((rel) => `${rel.type}:${rel.targetId}`).join(", ")}`);
                    }
                    return {
                        content: [{ type: "text", text: lines.join("\n") }],
                        details: {
                            action: "inspect",
                            memory: serializeMemoryEntry(entry, includeFullText),
                        },
                    };
                }
                catch (error) {
                    return {
                        content: [{
                                type: "text",
                                text: `Memory inspect failed: ${error instanceof Error ? error.message : String(error)}`,
                            }],
                        details: { error: "inspect_failed", message: String(error) },
                    };
                }
            },
        };
    }, { name: "memory_inspect" });
}
export function registerMemoryGovernTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_govern",
            label: "Memory Governance Review",
            description: "List memories that need operator review: conflicts, archived/inactive lifecycle rows, local scratch, legacy rows, and low-confidence auto-captures.",
            parameters: Type.Object({
                scope: Type.Optional(Type.String({ description: "Optional accessible scope filter." })),
                limit: Type.Optional(Type.Number({ description: "Max candidates to return (default: 20, max: 100)." })),
                includeText: Type.Optional(Type.Boolean({ description: "Include full memory text in details." })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { scope, limit = 20, includeText = false } = params;
                const safeLimit = clampInt(limit, 1, 100);
                const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_govern");
                if (agentResolution.ok === false)
                    return agentResolution.response;
                const agentId = agentResolution.agentId;
                let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
                if (scope) {
                    if (!context.scopeManager.isAccessible(scope, agentId)) {
                        return {
                            content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                            details: { error: "scope_access_denied", requestedScope: scope },
                        };
                    }
                    scopeFilter = [scope];
                }
                const entries = await context.store.list(scopeFilter, undefined, 1000, 0);
                const candidates = buildGovernanceReviewCandidates(entries, {
                    limit: safeLimit,
                    includeText,
                });
                if (candidates.length === 0) {
                    return {
                        content: [{ type: "text", text: "No memory governance candidates found." }],
                        details: { count: 0, scopes: scopeFilter },
                    };
                }
                const lines = candidates.map((candidate, index) => {
                    const reasons = candidate.reasons.join(",");
                    return `${index + 1}. [${candidate.id}] [${candidate.category}:${candidate.scope}] ${truncateText(normalizeInlineText(candidate.text), 140)} (${reasons}; action=${candidate.suggestedAction})`;
                });
                return {
                    content: [{ type: "text", text: `Memory governance candidates (${candidates.length}):\n\n${lines.join("\n")}` }],
                    details: {
                        count: candidates.length,
                        candidates,
                        scopes: scopeFilter,
                    },
                };
            },
        };
    }, { name: "memory_govern" });
}
export function registerMemoryPromoteTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_promote",
            label: "Memory Promote",
            description: "Set a memory governance state/layer, including confirmed promotion or archive/rejected review outcomes.",
            parameters: Type.Object({
                memoryId: Type.Optional(Type.String({ description: "Memory id (UUID/prefix). Optional when query is provided." })),
                query: Type.Optional(Type.String({ description: "Search query to locate a memory when memoryId is omitted." })),
                scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
                state: Type.Optional(Type.Union([
                    Type.Literal("pending"),
                    Type.Literal("confirmed"),
                    Type.Literal("archived"),
                    Type.Literal("rejected"),
                ])),
                layer: Type.Optional(Type.Union([
                    Type.Literal("durable"),
                    Type.Literal("working"),
                    Type.Literal("reflection"),
                    Type.Literal("archive"),
                ])),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { memoryId, query, scope, state = "confirmed", layer, } = params;
                const targetLayer = layer ?? (state === "archived" || state === "rejected" ? "archive" : "durable");
                if (!memoryId && !query) {
                    return {
                        content: [{ type: "text", text: "Provide memoryId or query." }],
                        details: { error: "missing_selector" },
                    };
                }
                const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_promote");
                if (agentResolution.ok === false)
                    return agentResolution.response;
                const agentId = agentResolution.agentId;
                let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
                if (scope) {
                    if (!context.scopeManager.isAccessible(scope, agentId)) {
                        return {
                            content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                            details: { error: "scope_access_denied", requestedScope: scope },
                        };
                    }
                    scopeFilter = [scope];
                }
                const resolved = await resolveMemoryId(runtimeContext, memoryId ?? query ?? "", scopeFilter);
                if (resolved.ok === false) {
                    return {
                        content: [{ type: "text", text: resolved.message }],
                        details: resolved.details ?? { error: "resolve_failed" },
                    };
                }
                const before = await runtimeContext.store.getById(resolved.id, scopeFilter);
                if (!before) {
                    return {
                        content: [{ type: "text", text: `Memory ${resolved.id.slice(0, 8)} not found.` }],
                        details: { error: "not_found", id: resolved.id },
                    };
                }
                const now = Date.now();
                const updated = await runtimeContext.store.patchMetadata(resolved.id, {
                    source: "manual",
                    state,
                    memory_layer: targetLayer,
                    last_confirmed_use_at: state === "confirmed" ? now : undefined,
                    bad_recall_count: 0,
                    suppressed_until_turn: 0,
                }, scopeFilter);
                if (!updated) {
                    return {
                        content: [{ type: "text", text: `Failed to promote memory ${resolved.id.slice(0, 8)}.` }],
                        details: { error: "promote_failed", id: resolved.id },
                    };
                }
                return {
                    content: [{
                            type: "text",
                            text: `Updated memory ${resolved.id.slice(0, 8)} to state=${state}, layer=${targetLayer}.`,
                        }],
                    details: {
                        action: "state_updated",
                        id: resolved.id,
                        state,
                        layer: targetLayer,
                    },
                };
            },
        };
    }, { name: "memory_promote" });
}
export function registerMemoryArchiveTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_archive",
            label: "Memory Archive",
            description: "Archive a memory to remove it from default auto-recall while preserving history.",
            parameters: Type.Object({
                memoryId: Type.Optional(Type.String({ description: "Memory id (UUID/prefix)." })),
                query: Type.Optional(Type.String({ description: "Search query when memoryId is omitted." })),
                scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
                reason: Type.Optional(Type.String({ description: "Archive reason for audit trail." })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { memoryId, query, scope, reason = "manual_archive" } = params;
                if (!memoryId && !query) {
                    return {
                        content: [{ type: "text", text: "Provide memoryId or query." }],
                        details: { error: "missing_selector" },
                    };
                }
                const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_archive");
                if (agentResolution.ok === false)
                    return agentResolution.response;
                const agentId = agentResolution.agentId;
                let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
                if (scope) {
                    if (!context.scopeManager.isAccessible(scope, agentId)) {
                        return {
                            content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                            details: { error: "scope_access_denied", requestedScope: scope },
                        };
                    }
                    scopeFilter = [scope];
                }
                const resolved = await resolveMemoryId(runtimeContext, memoryId ?? query ?? "", scopeFilter);
                if (resolved.ok === false) {
                    return {
                        content: [{ type: "text", text: resolved.message }],
                        details: resolved.details ?? { error: "resolve_failed" },
                    };
                }
                const patch = {
                    state: "archived",
                    memory_layer: "archive",
                    archive_reason: reason,
                    archived_at: Date.now(),
                };
                const updated = await runtimeContext.store.patchMetadata(resolved.id, patch, scopeFilter);
                if (!updated) {
                    return {
                        content: [{ type: "text", text: `Failed to archive memory ${resolved.id.slice(0, 8)}.` }],
                        details: { error: "archive_failed", id: resolved.id },
                    };
                }
                return {
                    content: [{ type: "text", text: `Archived memory ${resolved.id.slice(0, 8)}.` }],
                    details: { action: "archived", id: resolved.id, reason },
                };
            },
        };
    }, { name: "memory_archive" });
}
export function registerMemoryCompactTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_compact",
            label: "Memory Compact",
            description: "Compact duplicate low-value memories by archiving redundant entries and linking them to a canonical memory.",
            parameters: Type.Object({
                scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
                dryRun: Type.Optional(Type.Boolean({ description: "Preview compaction only (default true)." })),
                limit: Type.Optional(Type.Number({ description: "Max entries to scan (default 200)." })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { scope, dryRun = true, limit = 200 } = params;
                const safeLimit = clampInt(limit, 20, 1000);
                const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_compact");
                if (agentResolution.ok === false)
                    return agentResolution.response;
                const agentId = agentResolution.agentId;
                let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
                if (scope) {
                    if (!context.scopeManager.isAccessible(scope, agentId)) {
                        return {
                            content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                            details: { error: "scope_access_denied", requestedScope: scope },
                        };
                    }
                    scopeFilter = [scope];
                }
                const entries = await runtimeContext.store.list(scopeFilter, undefined, safeLimit, 0);
                const canonicalByKey = new Map();
                const duplicates = [];
                for (const entry of entries) {
                    const meta = parseSmartMetadata(entry.metadata, entry);
                    if (meta.state === "archived")
                        continue;
                    const key = `${meta.memory_category}:${normalizeInlineText(meta.l0_abstract).toLowerCase()}`;
                    const existing = canonicalByKey.get(key);
                    if (!existing) {
                        canonicalByKey.set(key, entry);
                        continue;
                    }
                    const keep = existing.timestamp >= entry.timestamp ? existing : entry;
                    const drop = keep.id === existing.id ? entry : existing;
                    canonicalByKey.set(key, keep);
                    duplicates.push({ duplicateId: drop.id, canonicalId: keep.id, key });
                }
                let archivedCount = 0;
                if (!dryRun) {
                    for (const item of duplicates) {
                        await runtimeContext.store.patchMetadata(item.duplicateId, {
                            state: "archived",
                            memory_layer: "archive",
                            canonical_id: item.canonicalId,
                            archive_reason: "compact_duplicate",
                            archived_at: Date.now(),
                        }, scopeFilter);
                        archivedCount++;
                    }
                }
                return {
                    content: [{
                            type: "text",
                            text: dryRun
                                ? `Compaction preview: ${duplicates.length} duplicate(s) detected across ${entries.length} entries.`
                                : `Compaction complete: archived ${archivedCount} duplicate memory record(s).`,
                        }],
                    details: {
                        action: dryRun ? "compact_preview" : "compact_applied",
                        scanned: entries.length,
                        duplicates: duplicates.length,
                        archived: archivedCount,
                        sample: duplicates.slice(0, 20),
                    },
                };
            },
        };
    }, { name: "memory_compact" });
}
export function registerMemoryExplainRankTool(api, context) {
    api.registerTool((toolCtx) => {
        const runtimeContext = resolveToolContext(context, toolCtx);
        return {
            name: "memory_explain_rank",
            label: "Memory Explain Rank",
            description: "Run recall and explain why each memory was ranked, including governance metadata (state/layer/source/suppression).",
            parameters: Type.Object({
                query: Type.String({ description: "Query used for ranking analysis." }),
                limit: Type.Optional(Type.Number({ description: "How many items to explain (default 5)." })),
                scope: Type.Optional(Type.String({ description: "Optional scope filter." })),
            }),
            async execute(_toolCallId, params, _signal, _onUpdate, runtimeCtx) {
                const { query, limit = 5, scope } = params;
                const safeLimit = clampInt(limit, 1, 20);
                const agentResolution = requireRuntimeAgentId(runtimeContext.agentId, runtimeCtx, "memory_explain_rank");
                if (agentResolution.ok === false)
                    return agentResolution.response;
                const agentId = agentResolution.agentId;
                let scopeFilter = resolveScopeFilter(context.scopeManager, agentId);
                if (scope) {
                    if (!context.scopeManager.isAccessible(scope, agentId)) {
                        return {
                            content: [{ type: "text", text: `Access denied to scope: ${scope}` }],
                            details: { error: "scope_access_denied", requestedScope: scope },
                        };
                    }
                    scopeFilter = [scope];
                }
                const results = await retrieveWithRetry(runtimeContext.retriever, {
                    query,
                    limit: safeLimit,
                    scopeFilter,
                    source: "manual",
                });
                if (results.length === 0) {
                    return {
                        content: [{ type: "text", text: "No relevant memories found." }],
                        details: { action: "empty", query, scopeFilter },
                    };
                }
                const lines = results.map((r, idx) => {
                    const meta = parseSmartMetadata(r.entry.metadata, r.entry);
                    const sourceBreakdown = [];
                    if (r.sources.vector)
                        sourceBreakdown.push(`vec=${r.sources.vector.score.toFixed(3)}`);
                    if (r.sources.bm25)
                        sourceBreakdown.push(`bm25=${r.sources.bm25.score.toFixed(3)}`);
                    if (r.sources.reranked)
                        sourceBreakdown.push(`rerank=${r.sources.reranked.score.toFixed(3)}`);
                    return [
                        `${idx + 1}. [${r.entry.id}] score=${r.score.toFixed(3)} ${sourceBreakdown.join(" ")}`.trim(),
                        `   state=${meta.state} layer=${meta.memory_layer} source=${meta.source} tier=${meta.tier}`,
                        `   access=${meta.access_count} injected=${meta.injected_count} badRecall=${meta.bad_recall_count} suppressedUntilTurn=${meta.suppressed_until_turn}`,
                        `   text=${truncateText(normalizeInlineText(meta.l0_abstract || r.entry.text), 180)}`,
                    ].join("\n");
                });
                return {
                    content: [{ type: "text", text: lines.join("\n") }],
                    details: {
                        action: "explain_rank",
                        query,
                        count: results.length,
                        results: sanitizeMemoryForSerialization(results),
                    },
                };
            },
        };
    }, { name: "memory_explain_rank" });
}
// ============================================================================
// Tool Registration Helper
// ============================================================================
export function registerAllMemoryTools(api, context, options = {}) {
    // Core tools (always enabled)
    registerMemoryRecallTool(api, context);
    registerMemoryStoreTool(api, context);
    registerMemoryStoreSecretIndexTool(api, context);
    registerMemoryForgetTool(api, context);
    registerMemoryUpdateTool(api, context);
    // Management tools (optional)
    if (options.enableManagementTools) {
        registerMemoryStatsTool(api, context);
        registerMemoryDebugTool(api, context);
        registerMemoryListTool(api, context);
        registerMemoryContextTool(api, context);
        registerMemoryInspectTool(api, context);
        registerMemoryGovernTool(api, context);
        registerMemoryPromoteTool(api, context);
        registerMemoryArchiveTool(api, context);
        registerMemoryCompactTool(api, context);
        registerMemoryExplainRankTool(api, context);
    }
    if (options.enableSelfImprovementTools !== false) {
        registerSelfImprovementLogTool(api, context);
        if (options.enableManagementTools) {
            registerSelfImprovementExtractSkillTool(api, context);
            registerSelfImprovementReviewTool(api, context);
        }
    }
}
