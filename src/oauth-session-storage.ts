import { readFile } from "node:fs/promises";

export async function readOAuthSessionFile(authPath: string): Promise<string> {
  return readFile(authPath, "utf8");
}
