import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function readJson(path) {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
}

test("package metadata points at the public repository", async () => {
  const pkg = await readJson("package.json");
  const manifest = await readJson("openclaw.plugin.json");

  assert.equal(pkg.name, "scope-recall-openclaw");
  assert.equal(pkg.name, manifest.id);
  assert.equal(pkg.version, manifest.version);
  assert.equal(pkg.repository.url, "git+https://github.com/410979729/scope-recall-openclaw.git");
  assert.equal(pkg.bugs.url, "https://github.com/410979729/scope-recall-openclaw/issues");
  assert.equal(pkg.homepage, "https://github.com/410979729/scope-recall-openclaw#readme");
});

test("package allowlist includes release-quality docs and tests", async () => {
  const pkg = await readJson("package.json");
  for (const expected of [
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "DESIGN.md",
    "SECURITY.md",
    "docs/",
    "tests/",
  ]) {
    assert.ok(pkg.files.includes(expected), `package.json files is missing ${expected}`);
  }
});

test("manifest exposes the expected OpenClaw memory tools", async () => {
  const manifest = await readJson("openclaw.plugin.json");
  const tools = new Set(manifest.contracts?.tools ?? []);

  for (const expected of ["memory_recall", "memory_store", "memory_forget", "memory_update"]) {
    assert.ok(tools.has(expected), `manifest contracts.tools is missing ${expected}`);
  }

  assert.equal(manifest.kind, "memory");
  assert.equal(manifest.configSchema?.additionalProperties, false);
});

test("docs state the OpenClaw and Hermes boundary", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const roadmap = await readFile(new URL("../docs/parity-roadmap.md", import.meta.url), "utf8");

  assert.match(readme, /not a one-for-one Hermes plugin copy/i);
  assert.match(roadmap, /Hermes-Only Surfaces Not Yet Claimed/);
});
