import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const jiti = createJiti(__filename, {
  interopDefault: true,
  moduleCache: true,
});

const loaded = jiti(path.resolve(__dirname, "../index.ts"));
const entry = loaded?.default ?? loaded;

export default entry;
