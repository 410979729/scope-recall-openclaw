import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexSource = await readFile(new URL("../index.ts", import.meta.url), "utf8");
const embedderSource = await readFile(new URL("../src/embedder.ts", import.meta.url), "utf8");

test("MiniMax embedding.groupId is parsed, forwarded, and sent as GroupId", () => {
  assert.match(indexSource, /groupId:\s*config\.embedding\.groupId/);
  assert.match(indexSource, /groupId:\s*\n\s*typeof embedding\.groupId === "string"\s*\n\s*\? resolveConfigString\(embedding\.groupId\)/);
  assert.match(embedderSource, /this\._groupId = config\.groupId/);
  assert.match(embedderSource, /endpoint\.searchParams\.set\("GroupId", this\._groupId\)/);
});
