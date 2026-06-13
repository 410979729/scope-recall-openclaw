import { readFile } from "node:fs/promises";
export async function readOAuthSessionFile(authPath) {
    return readFile(authPath, "utf8");
}
