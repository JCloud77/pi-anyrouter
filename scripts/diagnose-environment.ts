#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  environmentSummary,
  inspectDebugDirectory,
  redactSensitive,
  safeJson,
  safePath,
  selectReplayRequest,
  summarizeApiKey,
  summarizeProfile,
} from "../src/safe-diagnostics.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function expandHome(value: string) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return resolve(value);
}

function commandResult(command: string, args: string[], secrets: string[] = []) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  return {
    available: !result.error || (result.error as NodeJS.ErrnoException).code !== "ENOENT",
    exitCode: result.status,
    summary: redactSensitive(combined, secrets).split(/\r?\n/).filter(Boolean).slice(0, 4),
  };
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function configOrigin(baseUrl: unknown) {
  try {
    return new URL(String(baseUrl || "")).origin;
  } catch {
    return "invalid";
  }
}

function inspectSettings(agentDirectory: string) {
  const path = join(agentDirectory, "settings.json");
  if (!existsSync(path)) return { path: safePath(path), exists: false };
  const settings = readJson(path);
  const packageSources = (Array.isArray(settings.packages) ? settings.packages : [])
    .map((entry: any) => typeof entry === "string" ? entry : entry?.source)
    .filter((source: any) => typeof source === "string" && source.toLowerCase().includes("anyrouter"))
    .map((source: string) => safePath(source));
  const extensionSources = (Array.isArray(settings.extensions) ? settings.extensions : [])
    .filter((source: any) => typeof source === "string" && source.toLowerCase().includes("anyrouter"))
    .map((source: string) => safePath(source));
  const enabledModels = (Array.isArray(settings.enabledModels) ? settings.enabledModels : [])
    .filter((model: any) => typeof model === "string" && model.startsWith("anyrouter/"));
  return {
    path: safePath(path),
    exists: true,
    anyrouterPackageSources: packageSources,
    anyrouterExtensionSources: extensionSources,
    duplicateAnyrouterSources: packageSources.length + extensionSources.length > 1,
    enabledModels,
    staleEnabledModels: enabledModels.filter((model: string) => !["anyrouter/claude-opus-5", "anyrouter/claude-fable-5"].includes(model)),
    defaultThinkingLevel: settings.defaultThinkingLevel,
  };
}

function gitSummary() {
  const commit = spawnSync("git", ["-C", PACKAGE_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" });
  const tag = spawnSync("git", ["-C", PACKAGE_ROOT, "describe", "--tags", "--exact-match"], { encoding: "utf8" });
  const status = spawnSync("git", ["-C", PACKAGE_ROOT, "status", "--short"], { encoding: "utf8" });
  return {
    commit: String(commit.stdout || "").trim() || undefined,
    exactTag: String(tag.stdout || "").trim() || undefined,
    clean: String(status.stdout || "").trim().length === 0,
  };
}

function parseProbeOutput(stdout: string, stderr: string, secrets: string[]) {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return {
      parseFailed: true,
      stderrPresent: Boolean(stderr.trim()),
      errorSummary: redactSensitive(stderr, secrets).split(/\r?\n/).filter(Boolean).slice(-3),
    };
  }
}

function runProbe(requestPath: string, transport: "fetch" | "curl-http2", secrets: string[]) {
  const result = spawnSync(process.execPath, [
    join(PACKAGE_ROOT, "scripts", "probe-anyrouter.ts"),
    "--live",
    "--request", requestPath,
    "--transport", transport,
    "--timeout-ms", "120000",
  ], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, PI_ANYROUTER_CC_ALLOW_LIVE: "1", PI_ANYROUTER_CC_MAX_RETRIES: "0" },
    encoding: "utf8",
    timeout: 150_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { exitCode: result.status, ...parseProbeOutput(String(result.stdout || ""), String(result.stderr || ""), secrets) };
}

function runOfficialControl(options: { apiKey: string; baseUrl: string; model: string; claudeExecutable: string }, secrets: string[]) {
  const cliModel = options.model.endsWith("[1m]") ? options.model : `${options.model}[1m]`;
  const result = spawnSync(options.claudeExecutable, [
    "-p", "Reply with exactly OK. Do not call tools.",
    "--model", cliModel,
    "--tools", "default",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--mcp-config", JSON.stringify({ mcpServers: {} }),
    "--no-session-persistence",
    "--max-turns", "1",
    "--output-format", "json",
  ], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: options.baseUrl,
      ANTHROPIC_AUTH_TOKEN: options.apiKey,
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
    },
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  let resultExactlyOk = false;
  try {
    const parsed = JSON.parse(String(result.stdout || "").trim());
    resultExactlyOk = String(parsed?.result || parsed?.content || "").trim() === "OK";
  } catch {
    resultExactlyOk = String(result.stdout || "").trim() === "OK";
  }
  const stderr = redactSensitive(String(result.stderr || ""), secrets);
  return {
    exitCode: result.status,
    signal: result.signal,
    resultExactlyOk,
    stderrPresent: Boolean(stderr.trim()),
    errorSummary: stderr.split(/\r?\n/).filter(Boolean).slice(-3).map((line) => line.slice(0, 240)),
  };
}

function resolveApiKey(config: any) {
  const configured = String(config?.apiKey || "");
  return String(process.env.PI_ANYROUTER_CC_API_KEY || process.env[configured] || configured);
}

function findClaudeExecutable(profile: any) {
  const explicit = arg("--claude") || process.env.CLAUDE_CODE_EXECUTABLE;
  if (explicit) return explicit;
  const captured = String(profile?.claudeCode?.executable || "");
  if (captured && (captured === "claude" || existsSync(expandHome(captured)))) return captured;
  return "claude";
}

function main() {
  const agentDirectory = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const configPath = expandHome(process.env.PI_ANYROUTER_CC_CONFIG || join(agentDirectory, "anyrouter.json"));
  const debugDirectory = expandHome(arg("--debug-dir") || process.env.PI_ANYROUTER_CC_DEBUG_DIR || "/tmp/pi-anyrouter-debug");
  const outputPath = arg("--output") ? expandHome(String(arg("--output"))) : undefined;
  const config = readJson(configPath);
  const apiKey = resolveApiKey(config);
  const secrets = [apiKey, String(config.apiKey || ""), String(process.env.PI_ANYROUTER_CC_API_KEY || "")].filter(Boolean);
  const profilePath = expandHome(process.env.PI_ANYROUTER_CC_PROFILE || config.claudeProfile || join(agentDirectory, "anyrouter-profiles", "claude-code-active.json"));
  const profile = readJson(profilePath);
  const debug = inspectDebugDirectory(debugDirectory, secrets);
  const whichClaude = spawnSync("which", [findClaudeExecutable(profile)], { encoding: "utf8" });
  const claudePath = String(whichClaude.stdout || "").trim();
  const report: Record<string, any> = {
    safeToShare: true,
    generatedAt: new Date().toISOString(),
    warning: "This report intentionally excludes API keys, proxy URLs, hostnames, request bodies, prompts, and system/tool template text. Never share the underlying profile or debug JSON files.",
    package: {
      name: "@jcloud77/pi-anyrouter",
      root: safePath(PACKAGE_ROOT),
      ...gitSummary(),
    },
    runtime: {
      ...environmentSummary(),
      pi: commandResult("pi", ["--version"], secrets),
      claude: commandResult(findClaudeExecutable(profile), ["--version"], secrets),
      claudeExecutable: safePath(claudePath || findClaudeExecutable(profile)),
      claudeFile: claudePath ? commandResult("file", [claudePath], secrets) : { available: false },
      curl: commandResult("curl", ["--version"], secrets),
    },
    settings: inspectSettings(agentDirectory),
    config: {
      path: safePath(configPath),
      mode: (statSync(configPath).mode & 0o777).toString(8).padStart(3, "0"),
      baseUrlOrigin: configOrigin(process.env.PI_ANYROUTER_CC_BASE_URL || config.baseUrl),
      apiKey: summarizeApiKey(config),
      modelIds: Array.isArray(config.models) ? config.models.map((model: any) => model?.id).filter(Boolean) : [],
      claudeProfile: safePath(profilePath),
      claudeToolProfile: process.env.PI_ANYROUTER_CC_TOOL_PROFILE || config.claudeToolProfile || "compatible-core",
      claudePiInstructions: process.env.PI_ANYROUTER_CC_PI_INSTRUCTIONS || config.claudePiInstructions || "user-reminder",
      overrides: {
        config: Boolean(process.env.PI_ANYROUTER_CC_CONFIG),
        baseUrl: Boolean(process.env.PI_ANYROUTER_CC_BASE_URL),
        apiKey: Boolean(process.env.PI_ANYROUTER_CC_API_KEY),
        profile: Boolean(process.env.PI_ANYROUTER_CC_PROFILE),
        toolProfile: Boolean(process.env.PI_ANYROUTER_CC_TOOL_PROFILE),
        piInstructions: Boolean(process.env.PI_ANYROUTER_CC_PI_INSTRUCTIONS),
      },
    },
    profile: {
      path: safePath(profilePath),
      mode: (statSync(profilePath).mode & 0o777).toString(8).padStart(3, "0"),
      ...summarizeProfile(profile),
    },
    debug: {
      directory: safePath(debugDirectory),
      ...debug,
    },
  };

  if (process.argv.includes("--live-matrix")) {
    if (process.env.PI_ANYROUTER_CC_ALLOW_LIVE !== "1") {
      throw new Error("Live matrix refused. Set PI_ANYROUTER_CC_ALLOW_LIVE=1 only after approving three real AnyRouter requests (official, Fetch replay, curl HTTP/2 replay).");
    }
    const requestPath = selectReplayRequest(debugDirectory, arg("--request"));
    if (!requestPath) throw new Error(`No private debug request found in ${safePath(debugDirectory)}; pass --request explicitly.`);
    const model = arg("--model") || "claude-opus-5";
    const curlText = commandResult("curl", ["--version"], secrets).summary.join("\n");
    const curlHasHttp2 = /\bHTTP2\b/i.test(curlText);
    report.liveMatrix = {
      safeToShare: true,
      realRequestCount: curlHasHttp2 ? 3 : 2,
      selectedRequestFile: basename(requestPath),
      selectedRequestToolCount: (() => {
        try { return JSON.parse(readFileSync(requestPath, "utf8"))?.body?.tools?.length || 0; } catch { return undefined; }
      })(),
      model,
      official: runOfficialControl({
        apiKey,
        baseUrl: String(process.env.PI_ANYROUTER_CC_BASE_URL || config.baseUrl).replace(/\/+$/, ""),
        model,
        claudeExecutable: findClaudeExecutable(profile),
      }, secrets),
      fetchReplay: runProbe(requestPath, "fetch", secrets),
      curlHttp2Replay: curlHasHttp2 ? runProbe(requestPath, "curl-http2", secrets) : { skipped: true, reason: "curl does not advertise HTTP2 support" },
    };
  }

  const serialized = safeJson(report, secrets);
  process.stdout.write(serialized);
  if (outputPath) {
    writeFileSync(outputPath, serialized, { encoding: "utf8", mode: 0o600 });
    chmodSync(outputPath, 0o600);
  }
}

try {
  main();
} catch (error) {
  const message = redactSensitive(error instanceof Error ? error.message : String(error));
  console.error(`[diagnose:environment] ${message}`);
  process.exitCode = 1;
}
