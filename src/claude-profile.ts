import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const PROFILE_SCHEMA_VERSION = 1;
export const PROFILE_SYSTEM_PROMPT_PLACEHOLDER = "{{PI_SYSTEM_PROMPT}}";
export const PROFILE_USER_PROMPT_PLACEHOLDER = "{{USER_PROMPT}}";
export const PROFILE_MODEL_PLACEHOLDER = "{{MODEL}}";
export const PROFILE_CURRENT_DATE_PLACEHOLDER = "{{CURRENT_DATE}}";
export const PROFILE_HOME_PLACEHOLDER = "{{HOME}}";
export const PROFILE_CWD_PLACEHOLDER = "{{CWD}}";
export const PROFILE_CWD_SLUG_PLACEHOLDER = "{{CWD_SLUG}}";

export const DEFAULT_PROFILE_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "anyrouter-profiles",
  "claude-code-active.json",
);

export type JsonObject = Record<string, any>;

export type ClaudeCodeProfile = {
  schemaVersion: 1;
  capturedAt: string;
  claudeCode: {
    version: string;
    billingVersion: string;
    executable: string;
  };
  request: {
    method: "POST";
    urlPath: string;
    headers: Record<string, string>;
    bodyDefaults: JsonObject;
    systemTemplate: JsonObject[];
    messageScaffold: JsonObject[];
    defaultHeaders: Record<string, string>;
    defaultBodyDefaults: JsonObject;
    defaultSystemTemplate: JsonObject[];
    defaultMessageScaffold: JsonObject[];
    toolCatalog: Record<string, JsonObject>;
    defaultToolNames: string[];
    coreToolNames: string[];
  };
  local: {
    deviceId: string;
  };
  hashes: {
    system: string;
    messages: string;
    tools: string;
    requestDefaults: string;
    defaultHeaders: string;
    defaultSystem: string;
    defaultMessages: string;
    defaultRequestDefaults: string;
  };
};

function sortJson(value: any): any {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

export function canonicalJson(value: any) {
  return JSON.stringify(sortJson(value));
}

export function structuralHash(value: any) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function expandHomePath(path: string) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

function assertObject(value: any, label: string): asserts value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function findForbiddenData(value: any, path = "$", findings: string[] = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenData(item, `${path}[${index}]`, findings));
    return findings;
  }
  if (!value || typeof value !== "object") return findings;

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const normalized = key.toLowerCase().replace(/[_-]/g, "");
    if (["authorization", "xapikey", "apikey", "cookie", "setcookie", "contentlength", "host"].includes(normalized)) {
      findings.push(childPath);
    }
    findForbiddenData(child, childPath, findings);
  }
  return findings;
}

export function validateClaudeProfile(value: any): ClaudeCodeProfile {
  assertObject(value, "Claude profile");
  if (value.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    throw new Error(`Unsupported Claude profile schemaVersion: ${String(value.schemaVersion)}`);
  }
  assertObject(value.claudeCode, "claudeCode");
  assertObject(value.request, "request");
  assertObject(value.local, "local");
  assertObject(value.hashes, "hashes");

  const version = String(value.claudeCode.version || "");
  const billingVersion = String(value.claudeCode.billingVersion || "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("claudeCode.version must use x.y.z format");
  if (!billingVersion.startsWith(`${version}.`)) {
    throw new Error(`billing version ${billingVersion || "<missing>"} does not match Claude Code ${version}`);
  }

  if (value.request.method !== "POST") throw new Error("request.method must be POST");
  if (value.request.urlPath !== "/v1/messages?beta=true") {
    throw new Error(`Unsupported Claude request path: ${String(value.request.urlPath)}`);
  }
  assertObject(value.request.headers, "request.headers");
  assertObject(value.request.bodyDefaults, "request.bodyDefaults");
  assertObject(value.request.defaultHeaders, "request.defaultHeaders");
  assertObject(value.request.defaultBodyDefaults, "request.defaultBodyDefaults");
  assertObject(value.request.toolCatalog, "request.toolCatalog");
  if (!Array.isArray(value.request.systemTemplate) || value.request.systemTemplate.length < 2) {
    throw new Error("request.systemTemplate must contain the captured Claude Code system blocks");
  }
  if (!canonicalJson(value.request.systemTemplate).includes(PROFILE_SYSTEM_PROMPT_PLACEHOLDER)) {
    throw new Error(`request.systemTemplate is missing ${PROFILE_SYSTEM_PROMPT_PLACEHOLDER}`);
  }
  if (!Array.isArray(value.request.messageScaffold)) throw new Error("request.messageScaffold must be an array");
  if (!canonicalJson(value.request.messageScaffold).includes(PROFILE_USER_PROMPT_PLACEHOLDER)) {
    throw new Error(`request.messageScaffold is missing ${PROFILE_USER_PROMPT_PLACEHOLDER}`);
  }
  if (!Array.isArray(value.request.defaultSystemTemplate) || value.request.defaultSystemTemplate.length < 2) {
    throw new Error("request.defaultSystemTemplate must contain the captured default system blocks");
  }
  if (!Array.isArray(value.request.defaultMessageScaffold)) throw new Error("request.defaultMessageScaffold must be an array");
  if (!canonicalJson(value.request.defaultMessageScaffold).includes(PROFILE_USER_PROMPT_PLACEHOLDER)) {
    throw new Error(`request.defaultMessageScaffold is missing ${PROFILE_USER_PROMPT_PLACEHOLDER}`);
  }
  if (value.request.defaultToolNames === undefined) {
    value.request.defaultToolNames = Object.keys(value.request.toolCatalog);
  }
  if (!Array.isArray(value.request.defaultToolNames) || value.request.defaultToolNames.length === 0) {
    throw new Error("request.defaultToolNames must be a non-empty array");
  }
  if (new Set(value.request.defaultToolNames).size !== value.request.defaultToolNames.length) {
    throw new Error("request.defaultToolNames must not contain duplicates");
  }
  for (const name of value.request.defaultToolNames) {
    const tool = value.request.toolCatalog[name];
    if (!tool) throw new Error(`Captured tool catalog is missing default tool ${name}`);
    if (tool.name !== name) throw new Error(`Captured default tool ${name} has mismatched wire name ${String(tool.name)}`);
  }
  if (!Array.isArray(value.request.coreToolNames) || value.request.coreToolNames.length === 0) {
    throw new Error("request.coreToolNames must be a non-empty array");
  }
  for (const name of value.request.coreToolNames) {
    if (!value.request.toolCatalog[name]) throw new Error(`Captured tool catalog is missing core tool ${name}`);
  }

  const userAgent = String(value.request.headers["user-agent"] || "");
  if (!userAgent.startsWith(`claude-cli/${version} `)) {
    throw new Error(`user-agent does not match Claude Code ${version}`);
  }
  const beta = String(value.request.headers["anthropic-beta"] || "");
  if (!beta.includes("claude-code-20250219")) throw new Error("anthropic-beta is missing claude-code-20250219");
  if (!/^[a-f0-9]{64}$/.test(String(value.local.deviceId || ""))) {
    throw new Error("local.deviceId must be a stable 64-character lowercase hex value");
  }

  const forbidden = findForbiddenData(value);
  if (forbidden.length) throw new Error(`Claude profile contains forbidden request/credential fields: ${forbidden.join(", ")}`);

  const expectedHashes = {
    system: structuralHash(value.request.systemTemplate),
    messages: structuralHash(value.request.messageScaffold),
    tools: structuralHash(value.request.toolCatalog),
    requestDefaults: structuralHash(value.request.bodyDefaults),
    defaultHeaders: structuralHash(value.request.defaultHeaders),
    defaultSystem: structuralHash(value.request.defaultSystemTemplate),
    defaultMessages: structuralHash(value.request.defaultMessageScaffold),
    defaultRequestDefaults: structuralHash(value.request.defaultBodyDefaults),
  };
  for (const [name, expected] of Object.entries(expectedHashes)) {
    if (value.hashes[name] !== expected) throw new Error(`Claude profile ${name} hash does not match its content`);
  }

  return value as ClaudeCodeProfile;
}

export function readClaudeProfile(path = process.env.PI_ANYROUTER_CC_PROFILE || DEFAULT_PROFILE_PATH) {
  const resolvedPath = expandHomePath(path);
  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch (error) {
    throw new Error(
      `Claude Code profile not found at ${resolvedPath}. Run npm run capture:profile in the pi-anyrouter development checkout.`,
      { cause: error },
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in Claude Code profile ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const profile = validateClaudeProfile(parsed);
  const mode = statSync(resolvedPath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`Claude Code profile ${resolvedPath} must not be accessible by group/other users (run chmod 600)`);
  }
  return { path: resolvedPath, profile };
}

export function writeClaudeProfile(path: string, profileInput: Omit<ClaudeCodeProfile, "local" | "hashes"> & {
  local?: Partial<ClaudeCodeProfile["local"]>;
  hashes?: Partial<ClaudeCodeProfile["hashes"]>;
}) {
  const resolvedPath = expandHomePath(path);
  const request = profileInput.request;
  const profile: ClaudeCodeProfile = {
    ...profileInput,
    schemaVersion: PROFILE_SCHEMA_VERSION,
    local: {
      deviceId: profileInput.local?.deviceId || randomBytes(32).toString("hex"),
    },
    hashes: {
      system: structuralHash(request.systemTemplate),
      messages: structuralHash(request.messageScaffold),
      tools: structuralHash(request.toolCatalog),
      requestDefaults: structuralHash(request.bodyDefaults),
      defaultHeaders: structuralHash(request.defaultHeaders),
      defaultSystem: structuralHash(request.defaultSystemTemplate),
      defaultMessages: structuralHash(request.defaultMessageScaffold),
      defaultRequestDefaults: structuralHash(request.defaultBodyDefaults),
    },
  } as ClaudeCodeProfile;
  validateClaudeProfile(profile);
  mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(resolvedPath), 0o700);
  writeFileSync(resolvedPath, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(resolvedPath, 0o600);
  return { path: resolvedPath, profile };
}
