import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const jiti = createJiti(__filename, { interopDefault: true, moduleCache: true });

// Load TypeScript source via jiti
const { sanitizeCaptureText, isTrivial, evaluateCaptureSafety } = jiti(
  path.resolve(__dirname, "../src/capture-safety.ts"),
);

describe("sanitizeCaptureText", () => {
  it("removes full-line image attachment markers", () => {
    const text = `现在要我扫码，我去哪扫啊

[Image attached at: /tmp/hermes-home/image_cache/img_ccf883cb57da.jpg]
[inline image/jpeg data omitted]
[screenshot]`;

    const result = sanitizeCaptureText(text);
    assert.equal(result, "现在要我扫码，我去哪扫啊");
  });

  it("removes inline attachment markers preserving surrounding text", () => {
    const text =
      "Question before [Image attached at: /tmp/hermes-home/image_cache/img_ccf883cb57da.jpg] after";

    const result = sanitizeCaptureText(text);
    assert.equal(result, "Question before after");
    assert.ok(!result.includes("image_cache"));
  });

  it("removes local image_cache paths", () => {
    const text =
      "Look at this /home/user/.hermes/image_cache/img_abc123.jpg and tell me";

    const result = sanitizeCaptureText(text);
    assert.ok(!result.includes("image_cache"));
    assert.ok(result.includes("Look at this"));
    assert.ok(result.includes("and tell me"));
  });

  it("returns empty for attachment-only payload", () => {
    const text = `[Image attached at: /tmp/hermes-home/image_cache/img_ccf883cb57da.jpg]
[inline image/jpeg data omitted]
[screenshot]`;

    const result = sanitizeCaptureText(text);
    assert.equal(result, "");
  });

  it("handles null and undefined", () => {
    assert.equal(sanitizeCaptureText(null), "");
    assert.equal(sanitizeCaptureText(undefined), "");
    assert.equal(sanitizeCaptureText(""), "");
  });

  it("collapses excessive blank lines", () => {
    const text = "line1\n\n\n\n\nline2";
    const result = sanitizeCaptureText(text);
    assert.equal(result, "line1\n\nline2");
  });
});

describe("isTrivial", () => {
  it("rejects short English acknowledgements", () => {
    assert.ok(isTrivial("Understood."));
    assert.ok(isTrivial("Noted."));
    assert.ok(isTrivial("Acknowledged."));
    assert.ok(isTrivial("Done."));
    assert.ok(isTrivial("ok"));
    assert.ok(isTrivial("thanks"));
    assert.ok(isTrivial("got it"));
  });

  it("rejects short Chinese acknowledgements", () => {
    assert.ok(isTrivial("明白了。"));
    assert.ok(isTrivial("了解。"));
    assert.ok(isTrivial("好的。"));
    assert.ok(isTrivial("收到"));
    assert.ok(isTrivial("好"));
  });

  it("allows substantive text", () => {
    assert.ok(!isTrivial("Joy prefers read-only SQLite viewers."));
    assert.ok(!isTrivial("The meeting is at 3pm tomorrow."));
    assert.ok(!isTrivial("如何配置 OpenClaw 的模型路由？"));
  });

  it("handles whitespace", () => {
    assert.ok(isTrivial("  ok  "));
    assert.ok(isTrivial("\nnoted\n"));
  });
});

describe("evaluateCaptureSafety with sanitization and trivial", () => {
  it("rejects attachment-only payload as empty", () => {
    const text = `[Image attached at: /tmp/hermes-home/image_cache/img_ccf883cb57da.jpg]
[inline image/jpeg data omitted]`;

    const result = evaluateCaptureSafety(text);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "empty");
  });

  it("rejects trivial acknowledgements", () => {
    const result = evaluateCaptureSafety("Understood.");
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "trivial");
  });

  it("rejects Chinese trivial acknowledgements", () => {
    const result = evaluateCaptureSafety("好的。");
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "trivial");
  });

  it("allows text with inline attachment markers after sanitization", () => {
    const text =
      "现在要我扫码，我去哪扫啊\n[Image attached at: /tmp/image_cache/img_xxx.jpg]";

    const result = evaluateCaptureSafety(text);
    assert.equal(result.allowed, true);
  });

  it("allows ordinary memory facts", () => {
    const result = evaluateCaptureSafety(
      "Joy prefers read-only SQLite viewers for inspecting live memory databases.",
    );
    assert.equal(result.allowed, true);
  });

  it("still rejects secrets", () => {
    const result = evaluateCaptureSafety(
      "The api_key = sk-abcdefghijklmnopqrstuvwxyz should not be stored",
    );
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "secret");
  });

  it("still rejects injected context", () => {
    const result = evaluateCaptureSafety(
      "<relevant-memories>some memories</relevant-memories>",
    );
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "injected-context");
  });
});
