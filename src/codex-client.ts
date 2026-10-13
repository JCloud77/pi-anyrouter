import { execFileSync } from "node:child_process";

const MIN_ASTRA_VERSION = [0, 153, 0] as const;

export function validateAstraCodexVersion(output: string): string {
  const match = /^codex-cli\s+(\d+)\.(\d+)\.(\d+)\s*$/i.exec(output);
  if (!match) throw new Error("gpt-6-astra requires an installed Codex CLI >= 0.153.0 (stable)");
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < 3; index++) {
    if (actual[index] > MIN_ASTRA_VERSION[index]) break;
    if (actual[index] < MIN_ASTRA_VERSION[index]) throw new Error("gpt-6-astra requires Codex CLI >= 0.153.0");
  }
  return actual.join(".");
}

let cachedClientVersion: string | undefined;
export function getAstraCodexVersion(): string {
  if (cachedClientVersion) return cachedClientVersion;
  let version: string;
  try {
    version = execFileSync("codex", ["--version"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    throw new Error("gpt-6-astra requires Codex CLI >= 0.153.0 installed on PATH");
  }
  cachedClientVersion = validateAstraCodexVersion(version.trim());
  return cachedClientVersion;
}
