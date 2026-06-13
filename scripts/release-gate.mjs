import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const requiredFiles = [
  "README.md",
  "SECURITY.md",
  "openclaw.plugin.json",
  "tsconfig.json",
  "index.ts",
  "src/embedder.ts",
  "src/types/openclaw-plugin-sdk.d.ts",
  "scripts/smoke-vector-repair.mjs",
];

for (const file of requiredFiles) {
  if (!(await exists(file))) {
    throw new Error(`release gate failed: missing required file ${file}`);
  }
}

const testFiles = (await exists("tests"))
  ? (await readdir("tests")).filter((name) => name.endsWith(".test.mjs"))
  : [];
if (testFiles.length === 0) {
  throw new Error("release gate failed: no tests/*.test.mjs files found");
}

for (const file of packageJson.files ?? []) {
  if (file.endsWith("/")) continue;
  if (!(await exists(file))) {
    throw new Error(`release gate failed: package.json files entry does not exist: ${file}`);
  }
}

run("npm", ["test"]);
run("npm", ["run", "typecheck"]);
run("npm", ["run", "smoke:vector-repair"]);
run("npm", ["run", "build"]);
run("npm", ["pack", "--dry-run"]);
