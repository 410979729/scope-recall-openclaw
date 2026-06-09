import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(import.meta.url);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with code ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

const pkg = await readJson("package.json");
const manifest = await readJson("openclaw.plugin.json");

assert(pkg.name === manifest.id, `package name ${pkg.name} does not match manifest id ${manifest.id}`);
assert(pkg.version === manifest.version, `package version ${pkg.version} does not match manifest version ${manifest.version}`);
assert(pkg.main === "dist/index.js", `unexpected package main: ${pkg.main}`);
assert(pkg.dependencies?.jiti, "package.json must include jiti for the dist wrapper");
assert(
  pkg.repository?.url === "git+https://github.com/410979729/scope-recall-openclaw.git",
  `package repository points at the wrong URL: ${pkg.repository?.url ?? "missing"}`,
);
assert(
  pkg.bugs?.url === "https://github.com/410979729/scope-recall-openclaw/issues",
  "package.json must expose the GitHub issues URL",
);
assert(
  pkg.homepage === "https://github.com/410979729/scope-recall-openclaw#readme",
  "package.json must expose the GitHub README homepage",
);
assert(pkg.openclaw?.compat?.pluginApi === ">=2026.6.2", "package.json must declare openclaw.compat.pluginApi");
assert(pkg.openclaw?.compat?.minGatewayVersion === "2026.6.2", "package.json must declare openclaw.compat.minGatewayVersion");
assert(pkg.openclaw?.build?.openclawVersion === "2026.6.2", "package.json must declare openclaw.build.openclawVersion");
assert(pkg.openclaw?.build?.pluginSdkVersion === "2026.6.2", "package.json must declare openclaw.build.pluginSdkVersion");
assert(pkg.openclaw?.release?.publishToClawHub === true, "package.json must opt into ClawHub publishing metadata");
for (const requiredDoc of ["DESIGN.md", "CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md"]) {
  await readFile(path.join(root, requiredDoc), "utf8");
}

const distIndex = await readFile(path.join(root, "dist/index.js"), "utf8");
assert(distIndex.includes("../index.ts"), "dist/index.js must load ../index.ts");
assert(distIndex.includes("createJiti"), "dist/index.js must use jiti");

const schemaProps = manifest.configSchema?.properties ?? {};
const uiHints = manifest.uiHints ?? {};
assert(schemaProps.autoRecallTimeoutMs, "configSchema is missing autoRecallTimeoutMs");
assert(schemaProps.recallMode, "configSchema is missing recallMode");
assert(uiHints.autoRecallTimeoutMs, "uiHints is missing autoRecallTimeoutMs");
assert(uiHints.recallMode, "uiHints is missing recallMode");

const distModule = await import(pathToFileURL(path.join(root, "dist/index.js")).href);
const pluginEntry = distModule.default;
assert(pluginEntry?.register, "dist/index.js must export a plugin entry with register()");

const { createJiti } = require("jiti");
const jiti = createJiti(path.join(root, "scripts", "release-gate.mjs"), {
  interopDefault: true,
  moduleCache: false,
});
const { parsePluginConfig } = jiti(path.join(root, "index.ts"));
const { evaluateCaptureSafety } = jiti(path.join(root, "src", "capture-safety.ts"));

function assertParserBehavior() {
  const base = {
    embedding: {
      apiKey: "release-gate-test-key",
    },
  };
  const adaptive = parsePluginConfig({
    ...base,
    autoRecall: true,
    recallMode: "adaptive",
    autoRecallTimeoutMs: "12345",
  });
  assert(adaptive.recallMode === "adaptive", "parsePluginConfig must preserve recallMode=adaptive");
  assert(adaptive.autoRecallTimeoutMs === 12345, "parsePluginConfig must preserve autoRecallTimeoutMs");

  const off = parsePluginConfig({
    ...base,
    autoRecall: true,
    recallMode: "off",
    autoRecallTimeoutMs: 6789,
  });
  assert(off.recallMode === "off", "parsePluginConfig must preserve recallMode=off");
  assert(off.autoRecallTimeoutMs === 6789, "parsePluginConfig must preserve numeric autoRecallTimeoutMs");
}

function assertCaptureBlocked(text, pattern) {
  const decision = evaluateCaptureSafety(text);
  assert(decision.allowed === false, `capture safety should block: ${text}`);
  assert(decision.reason === "secret", `capture safety should classify as secret: ${text}`);
  assert(decision.pattern === pattern, `capture safety expected ${pattern}, got ${decision.pattern ?? "none"}`);
}

function assertCaptureSafetyProbes() {
  assertCaptureBlocked(
    "Authorization: Bearer abcDEF1234567890._-abcDEF1234567890",
    "authorization-bearer",
  );
  assertCaptureBlocked(
    "DATABASE_URL=postgres://app_user:p%40ssw0rd!@db.example.com:5432/app",
    "credentialed-url",
  );
  assertCaptureBlocked(
    "password=\"p@$$w0rd!#\"",
    "password-assignment-quoted-special",
  );
  assertCaptureBlocked(
    "password=p@$$w0rd!#",
    "password-assignment-unquoted-special",
  );

  const benign = evaluateCaptureSafety("Remember that I use a password manager for personal accounts.");
  assert(benign.allowed === true, "capture safety should allow benign non-secret password-manager text");
}

async function assertCliRegistrationSmoke() {
  const smokeRoot = await mkdtemp(path.join(tmpdir(), "scope-recall-gate-"));
  let registeredCli = false;
  try {
    pluginEntry.register({
      pluginConfig: {
        embedding: {
          apiKey: "release-gate-test-key",
        },
        dbPath: path.join(smokeRoot, "memory"),
      },
      registrationMode: "cli-metadata",
      resolvePath: (value) => value,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
      registerCli(cli, options) {
        registeredCli =
          Boolean(cli) &&
          Array.isArray(options?.commands) &&
          options.commands.includes("scope-recall") &&
          options.commands.includes("memory-pro");
      },
    });
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }
  assert(registeredCli, "plugin register must register the scope-recall/memory-pro CLI");
}

assertParserBehavior();
assertCaptureSafetyProbes();
await assertCliRegistrationSmoke();

run(process.execPath, ["scripts/smoke-vector-repair.mjs"]);
run(process.execPath, ["--test", "tests/package-quality.test.mjs"]);

const packRaw = run("npm", ["pack", "--dry-run", "--json"]);
const pack = JSON.parse(packRaw)[0];
const files = (pack?.files ?? []).map((file) => file.path);
assert(files.length > 0, "npm pack produced an empty file list");
assert(!files.some((file) => file.includes("node_modules/")), "npm pack includes node_modules");
assert(files.includes("openclaw.plugin.json"), "npm pack is missing openclaw.plugin.json");
assert(files.includes("dist/index.js"), "npm pack is missing dist/index.js");
for (const requiredPackFile of [
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "DESIGN.md",
  "SECURITY.md",
  "docs/github-actions-ci-template.yml",
  "docs/parity-roadmap.md",
  "tests/package-quality.test.mjs",
]) {
  assert(files.includes(requiredPackFile), `npm pack is missing ${requiredPackFile}`);
}

console.log("release:gate ok");
