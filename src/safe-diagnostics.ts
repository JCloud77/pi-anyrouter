import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir, hostname, platform, release } from "node:os";
import { basename, resolve } from "node:path";

export const TESTED_PROFILE_BASELINE = {
  schemaVersion: 1,
  claudeVersion: "2.1.220",
  billingVersion: "2.1.220.f7c",
  defaultToolCount: 24,
  coreToolNames: ["Bash", "Edit", "Read", "WebFetch", "WebSearch", "Write"],
  normalizedBlocks: {
    systemTemplate: [
      "b5951d361ff752d57fcad9d69f3322cb3a2f4ffcecbdc5d7717cb58f77afd5cc",
      "6c1afcd9232947a1d8f7c44a79316f8fe08d06dcdc6e7453f09e2d78fa858e5e",
      "db90b1cea0a32e80334cfd6347be086b337fdbaf836927c669db463f4e346847",
    ],
    defaultSystemTemplate: [
      "b5951d361ff752d57fcad9d69f3322cb3a2f4ffcecbdc5d7717cb58f77afd5cc",
      "0d7062851dd7bd7e66d4be4f12ac4951e3d2f587ec408295333a49963bd3f6b7",
      "a4710ca57ceb129555b530c3b4f067df3d7f0d90cc9ca98f5c02b318167aa4fa",
    ],
  },
} as const;

function sha256(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

export function safePath(value: string) {
  if (!value) return "";
  const home = homedir();
  let result = value === home ? "~" : value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value;
  result = result.replace(/\/home\/[^/\s]+/g, "~");
  result = result.replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, "~");
  return result;
}

export function redactSensitive(text: string, secrets: string[] = []) {
  let result = text;
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[REDACTED]");
  }
  result = result
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ghp|github_pat)-?[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\/home\/[^/\s]+/g, "~")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, "~");
  const host = hostname();
  if (host) result = result.split(host).join("{{HOSTNAME}}");
  return result;
}

function normalizedBlockSummary(blocks: any[], field: keyof typeof TESTED_PROFILE_BASELINE.normalizedBlocks) {
  const kernel = release();
  const expected = TESTED_PROFILE_BASELINE.normalizedBlocks[field];
  return (Array.isArray(blocks) ? blocks : []).map((block, index) => {
    const original = String(block?.text || "");
    const normalized = original.split(kernel).join("{{KERNEL_RELEASE}}");
    const normalizedSha256 = sha256(normalized);
    return {
      index,
      type: block?.type,
      cacheControl: block?.cache_control?.type,
      containsCurrentKernel: Boolean(kernel && original.includes(kernel)),
      normalizedLength: normalized.length,
      normalizedSha256,
      matchesTestedBaseline: normalizedSha256 === expected[index],
    };
  });
}

export function summarizeProfile(profile: any) {
  const request = profile?.request || {};
  const coreToolNames = Array.isArray(request.coreToolNames) ? request.coreToolNames.map(String) : [];
  const defaultToolNames = Array.isArray(request.defaultToolNames) ? request.defaultToolNames.map(String) : [];
  const systemTemplate = normalizedBlockSummary(request.systemTemplate, "systemTemplate");
  const defaultSystemTemplate = normalizedBlockSummary(request.defaultSystemTemplate, "defaultSystemTemplate");
  const baseline = {
    schemaVersion: profile?.schemaVersion === TESTED_PROFILE_BASELINE.schemaVersion,
    claudeVersion: profile?.claudeCode?.version === TESTED_PROFILE_BASELINE.claudeVersion,
    billingVersion: profile?.claudeCode?.billingVersion === TESTED_PROFILE_BASELINE.billingVersion,
    defaultToolCount: defaultToolNames.length === TESTED_PROFILE_BASELINE.defaultToolCount,
    coreToolNames: JSON.stringify(coreToolNames) === JSON.stringify(TESTED_PROFILE_BASELINE.coreToolNames),
    normalizedSystemBlocks: [...systemTemplate, ...defaultSystemTemplate].every((block) => block.matchesTestedBaseline),
  };
  return {
    schemaVersion: profile?.schemaVersion,
    claudeVersion: profile?.claudeCode?.version,
    billingVersion: profile?.claudeCode?.billingVersion,
    executable: safePath(String(profile?.claudeCode?.executable || "")),
    defaultToolCount: defaultToolNames.length,
    defaultToolNames,
    coreToolNames,
    defaultMessageRoles: Array.isArray(request.defaultMessageScaffold)
      ? request.defaultMessageScaffold.map((message: any) => message?.role)
      : [],
    hashes: profile?.hashes || {},
    blocks: { systemTemplate, defaultSystemTemplate },
    testedBaseline: { ...baseline, all: Object.values(baseline).every(Boolean) },
  };
}

export function summarizeApiKey(config: any, env: NodeJS.ProcessEnv = process.env) {
  const configured = String(config?.apiKey || "");
  const override = String(env.PI_ANYROUTER_CC_API_KEY || "");
  const referenced = configured ? String(env[configured] || "") : "";
  const effective = override || referenced || configured;
  const source = override
    ? "PI_ANYROUTER_CC_API_KEY"
    : referenced
      ? "config-env-reference"
      : configured.startsWith("sk-")
        ? "config-literal"
        : configured
          ? "config-unresolved-literal"
          : "missing";
  return {
    configured: Boolean(effective),
    source,
    configHasOuterWhitespace: configured !== configured.trim(),
    effectiveLooksCredentialShaped: /^(?:sk|ghp|github_pat)-?[A-Za-z0-9_-]{12,}$/.test(effective),
    overridePresent: Boolean(override),
  };
}

function summarizeMetadata(metadata: any) {
  const result: Record<string, any> = { keys: metadata && typeof metadata === "object" ? Object.keys(metadata).sort() : [] };
  if (typeof metadata?.user_id !== "string") return result;
  try {
    const parsed = JSON.parse(metadata.user_id);
    const deviceId = String(parsed.device_id || "");
    const sessionId = String(parsed.session_id || "");
    const accountUuid = String(parsed.account_uuid || "");
    result.userId = {
      keys: Object.keys(parsed).sort(),
      deviceIdLength: deviceId.length,
      deviceIdIsHex64: /^[0-9a-f]{64}$/i.test(deviceId),
      sessionIdIsUuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId),
      accountUuidEmpty: accountUuid.length === 0,
      accountUuidPresent: accountUuid.length > 0,
    };
  } catch {
    result.userId = { validJson: false };
  }
  return result;
}

export function summarizeDebugRequest(payload: any, fileName = "request.json") {
  const body = payload?.body || {};
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const headers = payload?.headers && typeof payload.headers === "object" ? payload.headers : {};
  return {
    file: basename(fileName),
    model: body.model,
    transport: payload?.transport,
    headerKeys: Object.keys(headers).map((key) => key.toLowerCase()).sort(),
    bodyKeys: Object.keys(body).sort(),
    toolCount: tools.length,
    toolNames: tools.map((tool: any) => tool?.name),
    system: normalizedBlockSummary(body.system, "defaultSystemTemplate"),
    messages: messages.map((message: any, index: number) => ({
      index,
      role: message?.role,
      contentShape: Array.isArray(message?.content)
        ? message.content.map((block: any) => block?.type || typeof block)
        : typeof message?.content,
    })),
    defaults: {
      output_config: body.output_config,
      thinking: body.thinking,
      max_tokens: body.max_tokens,
      stream: body.stream,
      context_management: body.context_management,
    },
    metadata: summarizeMetadata(body.metadata),
  };
}

export function summarizeDebugResult(payload: any, fileName: string, secrets: string[] = []) {
  const error = payload?.body?.error;
  return {
    file: basename(fileName),
    kind: fileName.endsWith("-error.json") ? "error" : "response",
    status: payload?.status,
    requestId: payload?.requestId,
    transport: payload?.transport,
    retryAttempt: payload?.retryAttempt,
    stopReason: payload?.body?.stopReason,
    contentBlocks: payload?.body?.contentBlocks,
    errorType: error?.type,
    errorMessage: error?.message ? redactSensitive(String(error.message), secrets).slice(0, 240) : undefined,
  };
}

export function inspectDebugDirectory(directory: string, secrets: string[] = []) {
  if (!directory || !existsSync(directory)) return { exists: false, requests: [], results: [] };
  const entries = readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ name, path: resolve(directory, name), mtime: statSync(resolve(directory, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);
  const requests: any[] = [];
  const results: any[] = [];
  for (const entry of entries) {
    try {
      const parsed = JSON.parse(readFileSync(entry.path, "utf8"));
      if (entry.name.endsWith("-request.json") && requests.length < 10) {
        requests.push(summarizeDebugRequest(parsed, entry.name));
      } else if ((entry.name.endsWith("-response.json") || entry.name.endsWith("-error.json")) && results.length < 10) {
        results.push(summarizeDebugResult(parsed, entry.name, secrets));
      }
    } catch {
      // A malformed private debug file is reported only as a count-free omission.
    }
  }
  return { exists: true, requests, results };
}

export function selectReplayRequest(directory: string, explicitPath?: string) {
  if (explicitPath) return resolve(explicitPath);
  if (!directory || !existsSync(directory)) return undefined;
  const candidates = readdirSync(directory)
    .filter((name) => name.endsWith("-request.json"))
    .map((name) => {
      const path = resolve(directory, name);
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        return {
          path,
          name,
          toolCount: Array.isArray(parsed?.body?.tools) ? parsed.body.tools.length : 0,
          mtime: statSync(path).mtimeMs,
        };
      } catch {
        return undefined;
      }
    })
    .filter(Boolean) as Array<{ path: string; name: string; toolCount: number; mtime: number }>;
  candidates.sort((left, right) => right.toolCount - left.toolCount || right.mtime - left.mtime);
  return candidates[0]?.path;
}

export function safeJson(value: any, secrets: string[] = []) {
  return redactSensitive(`${JSON.stringify(value, null, 2)}\n`, secrets);
}

export function environmentSummary(env: NodeJS.ProcessEnv = process.env) {
  return {
    node: process.version,
    platform: platform(),
    arch: process.arch,
    kernelReleaseLength: release().length,
    kernelReleaseSha256: sha256(release()),
    proxy: {
      HTTP_PROXY: Boolean(env.HTTP_PROXY || env.http_proxy),
      HTTPS_PROXY: Boolean(env.HTTPS_PROXY || env.https_proxy),
      ALL_PROXY: Boolean(env.ALL_PROXY || env.all_proxy),
      NO_PROXY: Boolean(env.NO_PROXY || env.no_proxy),
    },
  };
}
