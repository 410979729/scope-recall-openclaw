const ANCHOR_MARKER = "Artifact anchors:";

const URL_RE = /https?:\/\/[^\s<>'"\])}，。；、]+/gi;
const GITHUB_URL_RE =
  /https?:\/\/github\.com\/(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+)(?:\/(?<section>issues|pull|pulls|commit|releases\/tag)\/(?<item>[^\s<>'"\])}，。；、]+))?/gi;
const GITHUB_SHORTHAND_RE = /\b(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+)#(?<number>\d+)\b/g;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const TRAILING_PUNCT = /[.,;:!?。！？、，；：)\]}）]+$/;

export type ArtifactAnchor = {
  kind: string;
  repo?: string;
  number?: number;
  tag?: string;
  commit?: string;
  url?: string;
};

function stripUrl(value: string): string {
  return String(value || "").replace(TRAILING_PUNCT, "");
}

function artifactKey(artifact: ArtifactAnchor): string {
  return [
    artifact.kind || "",
    artifact.repo || "",
    artifact.number ?? artifact.tag ?? artifact.commit ?? "",
    artifact.url || "",
  ].join("\0");
}

function normalizeEntity(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 160);
}

function githubArtifactFromMatch(match: RegExpExecArray, url = ""): ArtifactAnchor {
  const groups = match.groups || {};
  const repo = `${groups.owner}/${groups.repo}`;
  const section = String(groups.section || "").toLowerCase();
  const item = stripUrl(groups.item || "");
  if (section === "issues" && /^\d+$/.test(item)) {
    return { kind: "github_issue", repo, number: Number(item), url: url || `https://github.com/${repo}/issues/${item}` };
  }
  if ((section === "pull" || section === "pulls") && /^\d+$/.test(item)) {
    return { kind: "github_pull", repo, number: Number(item), url: url || `https://github.com/${repo}/pull/${item}` };
  }
  if (section === "commit" && SHA_RE.test(item)) {
    return { kind: "github_commit", repo, commit: item, url: url || `https://github.com/${repo}/commit/${item}` };
  }
  if (section === "releases/tag" && item) {
    return { kind: "github_release", repo, tag: item, url: url || `https://github.com/${repo}/releases/tag/${item}` };
  }
  return { kind: "github_repo", repo, url: url || `https://github.com/${repo}` };
}

export function extractArtifacts(text: string): ArtifactAnchor[] {
  const source = String(text || "");
  const artifacts: ArtifactAnchor[] = [];
  const seen = new Set<string>();
  const githubUrlSpans: Array<[number, number]> = [];

  GITHUB_URL_RE.lastIndex = 0;
  for (let match = GITHUB_URL_RE.exec(source); match; match = GITHUB_URL_RE.exec(source)) {
    const url = stripUrl(match[0]);
    const artifact = githubArtifactFromMatch(match, url);
    const key = artifactKey(artifact);
    if (!seen.has(key)) {
      seen.add(key);
      artifacts.push(artifact);
    }
    githubUrlSpans.push([match.index, match.index + match[0].length]);
  }

  GITHUB_SHORTHAND_RE.lastIndex = 0;
  for (let match = GITHUB_SHORTHAND_RE.exec(source); match; match = GITHUB_SHORTHAND_RE.exec(source)) {
    const groups = match.groups || {};
    const artifact: ArtifactAnchor = {
      kind: "github_issue_or_pull",
      repo: `${groups.owner}/${groups.repo}`,
      number: Number(groups.number),
    };
    const key = artifactKey(artifact);
    if (!seen.has(key)) {
      seen.add(key);
      artifacts.push(artifact);
    }
  }

  URL_RE.lastIndex = 0;
  for (let match = URL_RE.exec(source); match; match = URL_RE.exec(source)) {
    if (githubUrlSpans.some(([start, end]) => start <= match.index && match.index < end)) continue;
    const artifact = { kind: "url", url: stripUrl(match[0]) };
    const key = artifactKey(artifact);
    if (!seen.has(key)) {
      seen.add(key);
      artifacts.push(artifact);
    }
  }

  return artifacts.slice(0, 24);
}

function artifactLabel(artifact: ArtifactAnchor): string {
  const repo = artifact.repo || "";
  const url = artifact.url || "";
  let label: string;
  if (artifact.kind === "github_issue") label = `GitHub issue ${repo}#${artifact.number}`;
  else if (artifact.kind === "github_pull") label = `GitHub PR ${repo}#${artifact.number}`;
  else if (artifact.kind === "github_issue_or_pull") label = `GitHub issue/PR ${repo}#${artifact.number}`;
  else if (artifact.kind === "github_commit") label = `GitHub commit ${repo}@${String(artifact.commit || "").slice(0, 12)}`;
  else if (artifact.kind === "github_release") label = `GitHub release ${repo} ${artifact.tag}`;
  else if (artifact.kind === "github_repo") label = `GitHub repo ${repo}`;
  else label = `URL ${url}`;
  if (url && !label.includes(url)) label = `${label} (${url})`;
  return label.length > 240 ? `${label.slice(0, 239).trimEnd()}…` : label;
}

export function artifactAnchorBlock(artifacts: ArtifactAnchor[]): string {
  if (!artifacts.length) return "";
  return `${ANCHOR_MARKER} ${artifacts.slice(0, 10).map(artifactLabel).join("; ")}`;
}

export function enrichContentWithArtifactAnchors(content: string): string {
  const cleaned = String(content || "").trim();
  if (!cleaned || cleaned.includes(ANCHOR_MARKER)) return cleaned;
  const block = artifactAnchorBlock(extractArtifacts(cleaned));
  return block ? `${cleaned}\n\n${block}` : cleaned;
}

export function mergeArtifactMetadata(metadata: Record<string, unknown>, content: string): Record<string, unknown> {
  const artifacts = extractArtifacts(content);
  if (!artifacts.length) return metadata;

  const existing = Array.isArray(metadata.artifacts) ? metadata.artifacts : [];
  const merged: ArtifactAnchor[] = [];
  const seen = new Set<string>();
  for (const artifact of [...existing, ...artifacts]) {
    if (!artifact || typeof artifact !== "object") continue;
    const normalized = artifact as ArtifactAnchor;
    const key = artifactKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...normalized });
  }
  metadata.artifacts = merged.slice(0, 24);

  const rawEntities = Array.isArray(metadata.entities) ? metadata.entities : [];
  const artifactEntities: string[] = [];
  for (const artifact of artifacts) {
    if (artifact.repo) artifactEntities.push(artifact.repo);
    if (artifact.repo && artifact.number) artifactEntities.push(`${artifact.repo}#${artifact.number}`);
    if (artifact.repo && artifact.tag) artifactEntities.push(`${artifact.repo}@${artifact.tag}`);
    if (artifact.repo && artifact.commit) artifactEntities.push(`${artifact.repo}@${artifact.commit.slice(0, 12)}`);
  }
  metadata.entities = [...new Set([...rawEntities, ...artifactEntities].map((item) => normalizeEntity(String(item))).filter(Boolean))].sort();

  const rawTags = Array.isArray(metadata.tags) ? metadata.tags : [];
  const tags = ["artifact"];
  if (artifacts.some((artifact) => artifact.kind.startsWith("github_"))) tags.push("github");
  tags.push(...artifacts.map((artifact) => `artifact:${artifact.kind}`));
  metadata.tags = [...new Set([...rawTags, ...tags].map((item) => String(item).trim().toLowerCase()).filter(Boolean))].sort();
  return metadata;
}
