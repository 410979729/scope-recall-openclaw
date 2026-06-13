/**
 * Noise Filter
 * Filters out low-quality memories (meta-questions, agent denials, session boilerplate)
 * Inspired by openclaw-plugin-continuity's noise filtering approach.
 */
// Agent-side denial patterns
const DENIAL_PATTERNS = [
    /i don'?t have (any )?(information|data|memory|record)/i,
    /i'?m not sure about/i,
    /i don'?t recall/i,
    /i don'?t remember/i,
    /it looks like i don'?t/i,
    /i wasn'?t able to find/i,
    /no (relevant )?memories found/i,
    /i don'?t have access to/i,
];
// User-side meta-question patterns (about memory itself, not content)
const META_QUESTION_PATTERNS = [
    /\bdo you (remember|recall|know about)\b/i,
    /\bcan you (remember|recall)\b/i,
    /\bdid i (tell|mention|say|share)\b/i,
    /\bhave i (told|mentioned|said)\b/i,
    /\bwhat did i (tell|say|mention)\b/i,
    /如果你知道.+只回复/i,
    /如果不知道.+只回复\s*none/i,
    /只回复精确代号/i,
    /只回复\s*none/i,
    // Chinese recall / meta-question patterns
    /你还?记得/,
    /记不记得/,
    /还记得.*吗/,
    /你[知晓]道.+吗/,
    /我(?:之前|上次|以前)(?:说|提|讲).*(?:吗|呢|？|\?)/,
];
// Session boilerplate
const BOILERPLATE_PATTERNS = [
    /^(hi|hello|hey|good morning|good evening|greetings)/i,
    /^fresh session/i,
    /^new session/i,
    /^HEARTBEAT/i,
];
const OPERATIONAL_TRACE_PATTERNS = [
    /^Command hints:\s*[\s\S]*?(?:^Files:|^Result:|\|\s*status=)/im,
    /\|\s*status=(?:completed|failed|running|cancelled)\b/i,
    /^Result:\s*(?:Command|Task|Exec|Shell|Tool)\b/im,
    /^(?:Files|Result):\s*[\s\S]*\n(?:Files|Result|Command hints):/im,
];
const RAW_USER_INSTRUCTION_PATTERNS = [
    /^(?:去|帮我|你去|现在|继续|再|直接).{0,80}(?:检查|看看|处理|改好|审计|搜索|定位|收口)/,
    /^(?:检查|审计|搜索|定位|修复|迁移|蒸馏).{0,120}(?:记忆|插件|数据库|授权|服务)/,
];
// Extractor artifacts from validation prompts / synthetic summaries
const DIAGNOSTIC_ARTIFACT_PATTERNS = [
    /\bquery\s*->\s*(none|no explicit solution|unknown|not found)\b/i,
    /\buser asked for\b.*\b(none|no explicit solution|unknown|not found)\b/i,
    /\bno explicit solution\b/i,
];
const DEFAULT_OPTIONS = {
    filterDenials: true,
    filterMetaQuestions: true,
    filterBoilerplate: true,
};
/**
 * Check if a memory text is noise that should be filtered out.
 * Returns true if the text is noise.
 */
export function isNoise(text, options = {}) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const trimmed = text.trim();
    if (trimmed.length < 5)
        return true;
    if (opts.filterDenials && DENIAL_PATTERNS.some(p => p.test(trimmed)))
        return true;
    if (opts.filterMetaQuestions && META_QUESTION_PATTERNS.some(p => p.test(trimmed)))
        return true;
    if (opts.filterBoilerplate && BOILERPLATE_PATTERNS.some(p => p.test(trimmed)))
        return true;
    if (OPERATIONAL_TRACE_PATTERNS.some(p => p.test(trimmed)))
        return true;
    if (trimmed.length <= 180 && RAW_USER_INSTRUCTION_PATTERNS.some(p => p.test(trimmed)))
        return true;
    if (DIAGNOSTIC_ARTIFACT_PATTERNS.some(p => p.test(trimmed)))
        return true;
    return false;
}
/**
 * Filter an array of items, removing noise entries.
 */
export function filterNoise(items, getText, options) {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    return items.filter(item => !isNoise(getText(item), opts));
}
