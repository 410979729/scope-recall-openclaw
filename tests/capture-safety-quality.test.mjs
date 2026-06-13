import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});

const { evaluateCaptureSafety } = jiti("../src/capture-safety.ts");
const { isNoise } = jiti("../src/noise-filter.ts");

test("capture safety blocks Chinese credential assignments", () => {
  const decision = evaluateCaptureSafety("远程登录密码是 CorrectHorse77!");
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "secret");
  assert.equal(decision.pattern, "chinese-password-assignment");
});

test("capture safety blocks credential pairs", () => {
  const decision = evaluateCaptureSafety("用户名是 deploy，密码是 CorrectHorse77!");
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "secret");
  assert.equal(decision.pattern, "credential-pair-with-password");
});

test("capture safety treats redacted credential placeholders as non-secret", () => {
  const decision = evaluateCaptureSafety("用户名是 [REDACTED]，密码是 [REDACTED]");
  assert.equal(decision.allowed, true);
});

test("capture safety blocks operational trace wrappers", () => {
  const decision = evaluateCaptureSafety(
    "Command hints:\n- inspect logs\nFiles:\n/tmp/x.log\nResult: Command completed | status=completed",
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "operational-trace");
});

test("noise filter rejects raw user task prompts", () => {
  assert.equal(isNoise("你去检查一下天姬记忆库，看看 SQL 记忆质量"), true);
});

test("high-signal distilled memory remains admissible", () => {
  const text = "天姬记忆治理经验：Scope Recall 需要先审计 SQLite/FTS/LanceDB 一致性，再做高密度蒸馏并同步向量库。";
  assert.equal(evaluateCaptureSafety(text).allowed, true);
  assert.equal(isNoise(text), false);
});
