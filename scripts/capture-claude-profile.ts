#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_PROFILE_PATH,
  PROFILE_CURRENT_DATE_PLACEHOLDER,
  PROFILE_CWD_PLACEHOLDER,
  PROFILE_CWD_SLUG_PLACEHOLDER,
  PROFILE_HOME_PLACEHOLDER,
  PROFILE_MODEL_PLACEHOLDER,
  PROFILE_SCHEMA_VERSION,
  PROFILE_SYSTEM_PROMPT_PLACEHOLDER,
  PROFILE_USER_PROMPT_PLACEHOLDER,
  writeClaudeProfile,
  type ClaudeCodeProfile,
} from "../src/claude-profile.ts";

const CORE_TOOL_NAMES = ["Read", "Bash", "Edit", "Write", "WebSearch", "WebFetch"];
const CAPTURE_USER_PROMPT = `PI_PROFILE_USER_PROMPT_${randomUUID()}`;
const APPEND_MARKER = `PI_PROFILE_SYSTEM_PROMPT_${randomUUID()}`;
const DUMMY_AUTH = `pi-profile-capture-${randomUUID()}`;
const MODEL = process.env.PI_ANYROUTER_CC_CAPTURE_MODEL || "claude-fable-5[1m]";
const TIMEOUT_MS = 45_000;

type Capture = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, any>;
};

function getArg(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function minimalSse(model: string) {
  const events = [
    {
      type: "message_start",
      message: {
        id: `msg_profile_${randomUUID().replace(/-/g, "")}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "PROFILE_CAPTURE_OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

async function runCapture(options: { name: string; tools: string; appendSystem?: string; claudeExecutable: string; workspace: string }) {
  let resolveCapture!: (capture: Capture) => void;
  let rejectCapture!: (error: Error) => void;
  const captured = new Promise<Capture>((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
  });
  let settled = false;

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        rejectCapture(error);
      }
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, any>;
      try {
        body = JSON.parse(raw);
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "capture body was not JSON" } }));
        if (!settled) {
          settled = true;
          rejectCapture(new Error(`${options.name}: Claude Code sent a non-JSON request`));
        }
        return;
      }

      if (!settled && request.method === "POST" && request.url?.startsWith("/v1/messages")) {
        settled = true;
        resolveCapture({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body,
        });
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "close",
      });
      response.end(minimalSse(String(body.model || MODEL).replace(/\[1m\]$/i, "")));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("capture server did not allocate a TCP port");

  const args = [
    "-p",
    CAPTURE_USER_PROMPT,
    "--model",
    MODEL,
    "--tools",
    options.tools,
    "--output-format",
    "json",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
    "--no-session-persistence",
    "--max-turns",
    "1",
  ];
  if (options.appendSystem) args.push("--append-system-prompt", options.appendSystem);

  const child = spawn(options.claudeExecutable, args, {
    cwd: options.workspace,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      ANTHROPIC_AUTH_TOKEN: DUMMY_AUTH,
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    if (!settled) {
      settled = true;
      rejectCapture(new Error(`${options.name}: timed out waiting for Claude Code request`));
    }
  }, TIMEOUT_MS);

  try {
    const result = await captured;
    await new Promise<void>((resolve) => {
      if (child.exitCode != null || child.signalCode != null) return resolve();
      child.once("exit", () => resolve());
      setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
        resolve();
      }, 5_000).unref();
    });
    if (!result.body || !Array.isArray(result.body.system) || !Array.isArray(result.body.tools)) {
      throw new Error(`${options.name}: request did not contain expected system/tools arrays`);
    }
    return result;
  } catch (error) {
    const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n").slice(-2000);
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `\nClaude output:\n${detail}` : ""}`);
  } finally {
    clearTimeout(timer);
    server.close();
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
  }
}

function replaceInValue(value: any, replacements: Array<[string | RegExp, string]>): any {
  if (Array.isArray(value)) return value.map((item) => replaceInValue(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceInValue(item, replacements)]));
  }
  if (typeof value !== "string") return value;
  return replacements.reduce((text, [pattern, replacement]) => text.replaceAll(pattern as any, replacement), value);
}

function retainedHeaders(headers: Capture["headers"]) {
  const blocked = new Set([
    "authorization",
    "x-api-key",
    "cookie",
    "set-cookie",
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "x-claude-code-session-id",
  ]);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (blocked.has(lower) || value == null) continue;
    result[lower] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return result;
}

function getClaudeVersion(headers: Record<string, string>, executable: string) {
  const match = headers["user-agent"]?.match(/^claude-cli\/(\d+\.\d+\.\d+)\b/);
  if (!match) throw new Error(`Could not extract Claude Code version from user-agent: ${headers["user-agent"] || "<missing>"}`);
  return { version: match[1], executable };
}

function getBillingVersion(system: any[]) {
  const text = String(system[0]?.text || "");
  const match = text.match(/\bcc_version=([^;\s]+)/);
  if (!match) throw new Error("Could not extract cc_version from first billing system block");
  return match[1];
}

function bodyDefaults(body: Record<string, any>) {
  const excluded = new Set(["model", "messages", "system", "tools", "metadata"]);
  return Object.fromEntries(Object.entries(body).filter(([key]) => !excluded.has(key)));
}

async function main() {
  const claudeExecutable = getArg("--claude") || process.env.CLAUDE_CODE_EXECUTABLE || "claude";
  const requestedOutput = getArg("--output");
  const workspace = mkdtempSync(join(tmpdir(), "pi-anyrouter-profile-"));
  try {
    const defaultCapture = await runCapture({
      name: "default-tools",
      tools: "default",
      claudeExecutable,
      workspace,
    });
    const coreCapture = await runCapture({
      name: "core-tools",
      tools: CORE_TOOL_NAMES.join(","),
      claudeExecutable,
      workspace,
    });
    const appendCapture = await runCapture({
      name: "append-system",
      tools: CORE_TOOL_NAMES.join(","),
      appendSystem: APPEND_MARKER,
      claudeExecutable,
      workspace,
    });

    const headers = retainedHeaders(coreCapture.headers);
    const defaultHeaders = retainedHeaders(defaultCapture.headers);
    const claudeCode = getClaudeVersion(headers, claudeExecutable);
    const billingVersion = getBillingVersion(appendCapture.body.system);
    const plainModel = String(coreCapture.body.model || MODEL).replace(/\[1m\]$/i, "");
    const replacements: Array<[string | RegExp, string]> = [
      [APPEND_MARKER, PROFILE_SYSTEM_PROMPT_PLACEHOLDER],
      [CAPTURE_USER_PROMPT, PROFILE_USER_PROMPT_PLACEHOLDER],
      [workspace, PROFILE_CWD_PLACEHOLDER],
      [workspace.replaceAll("/", "-"), PROFILE_CWD_SLUG_PLACEHOLDER],
      [homedir(), PROFILE_HOME_PLACEHOLDER],
      [plainModel, PROFILE_MODEL_PLACEHOLDER],
      [/Today'?s date is \d{4}-\d{2}-\d{2}/g, `Today's date is ${PROFILE_CURRENT_DATE_PLACEHOLDER}`],
      [/"device_id":"[^"]*"/g, '"device_id":"{{DEVICE_ID}}"'],
      [/"session_id":"[^"]*"/g, '"session_id":"{{SESSION_ID}}"'],
      [/"account_uuid":"[^"]*"/g, '"account_uuid":"{{ACCOUNT_UUID}}"'],
    ];

    const toolCatalog = Object.fromEntries(
      defaultCapture.body.tools.map((tool: Record<string, any>) => [String(tool.name), replaceInValue(tool, replacements)]),
    );
    for (const name of CORE_TOOL_NAMES) {
      if (!toolCatalog[name]) throw new Error(`Official default tool capture did not include ${name}`);
    }

    const profileInput: Omit<ClaudeCodeProfile, "local" | "hashes"> = {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      capturedAt: new Date().toISOString(),
      claudeCode: {
        ...claudeCode,
        billingVersion,
      },
      request: {
        method: "POST",
        urlPath: coreCapture.url,
        headers,
        bodyDefaults: replaceInValue(bodyDefaults(coreCapture.body), replacements),
        systemTemplate: replaceInValue(appendCapture.body.system, replacements),
        messageScaffold: replaceInValue(coreCapture.body.messages, replacements),
        defaultHeaders,
        defaultBodyDefaults: replaceInValue(bodyDefaults(defaultCapture.body), replacements),
        defaultSystemTemplate: replaceInValue(defaultCapture.body.system, replacements),
        defaultMessageScaffold: replaceInValue(defaultCapture.body.messages, replacements),
        toolCatalog,
        defaultToolNames: defaultCapture.body.tools.map((tool: Record<string, any>) => String(tool.name)),
        coreToolNames: coreCapture.body.tools.map((tool: Record<string, any>) => String(tool.name)),
      },
    };

    const versionedPath = requestedOutput || join(dirname(DEFAULT_PROFILE_PATH), `claude-code-${claudeCode.version}.json`);
    const written = writeClaudeProfile(versionedPath, profileInput);
    if (!requestedOutput) {
      writeClaudeProfile(DEFAULT_PROFILE_PATH, { ...profileInput, local: written.profile.local });
    }

    const captureDirectory = getArg("--capture-dir");
    if (captureDirectory) {
      mkdirSync(captureDirectory, { recursive: true, mode: 0o700 });
      chmodSync(captureDirectory, 0o700);
      for (const [name, capture] of [["default", defaultCapture], ["core", coreCapture], ["append", appendCapture]] as const) {
        const path = join(captureDirectory, `${name}.json`);
        const sanitized = {
          method: capture.method,
          url: capture.url,
          headers: retainedHeaders(capture.headers),
          body: replaceInValue(capture.body, replacements),
        };
        writeFileSync(path, `${JSON.stringify(sanitized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        chmodSync(path, 0o600);
      }
    }

    console.log(`Captured Claude Code ${claudeCode.version} profile without contacting AnyRouter.`);
    console.log(`Versioned profile: ${written.path}`);
    if (!requestedOutput) console.log(`Active profile: ${DEFAULT_PROFILE_PATH}`);
    console.log(`Core tools: ${CORE_TOOL_NAMES.join(", ")}`);
    console.log(`System hash: ${written.profile.hashes.system}`);
    console.log(`Tool catalog hash: ${written.profile.hashes.tools}`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[capture:profile] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
