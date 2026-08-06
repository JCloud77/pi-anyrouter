#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { structuralHash } from "../src/claude-profile.ts";

function arg(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function resolveConfigValue(value?: string) {
  if (!value) return "";
  if (value.startsWith("!")) throw new Error("Shell-command API keys are not supported by the probe");
  return process.env[value] || value;
}

function proxyFor(url: string) {
  const parsed = new URL(url);
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((item) => item.trim().toLowerCase());
  const bypass = noProxy.some((pattern) => pattern === "*" || pattern === parsed.hostname.toLowerCase() || (pattern.startsWith(".") && parsed.hostname.toLowerCase().endsWith(pattern)));
  if (bypass) return undefined;
  const proxy = parsed.protocol === "https:"
    ? process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
    : process.env.HTTP_PROXY || process.env.http_proxy;
  return proxy ? new ProxyAgent(proxy) : undefined;
}

function redactText(text: string, apiKey: string) {
  return text
    .split(apiKey).join("***")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer ***")
    .replace(/\b[0-9a-f]{64}\b/gi, "{{ID}}")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "{{UUID}}");
}

type ProbeResponse = { status: number; body: string; requestId?: string };

async function runFetchProbe(url: string, headers: Record<string, string>, bodyText: string, timeoutMs: number): Promise<ProbeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await undiciFetch(url, {
      method: "POST",
      headers,
      body: bodyText,
      signal: controller.signal,
      dispatcher: proxyFor(url),
    });
    return {
      status: response.status,
      body: await response.text(),
      requestId: response.headers.get("x-oneapi-request-id") || undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

function splitCurlIncludedResponse(raw: string) {
  let offset = 0;
  let responseHeaders = "";
  while (raw.startsWith("HTTP/", offset)) {
    const dos = raw.indexOf("\r\n\r\n", offset);
    const unix = raw.indexOf("\n\n", offset);
    const boundary = dos >= 0 && (unix < 0 || dos < unix) ? dos : unix;
    if (boundary < 0) break;
    const separatorLength = boundary === dos ? 4 : 2;
    responseHeaders = raw.slice(offset, boundary);
    offset = boundary + separatorLength;
  }
  const status = Number(responseHeaders.match(/^HTTP\/\S+\s+(\d{3})/mi)?.[1] || 0);
  const requestId = responseHeaders.match(/^x-oneapi-request-id:\s*(.+)$/mi)?.[1]?.trim();
  return { status, requestId, body: raw.slice(offset) };
}

async function runCurlProbe(url: string, headers: Record<string, string>, bodyText: string, timeoutMs: number): Promise<ProbeResponse> {
  const directory = mkdtempSync(join(tmpdir(), "pi-anyrouter-curl-probe-"));
  chmodSync(directory, 0o700);
  const bodyPath = join(directory, "request.json");
  writeFileSync(bodyPath, bodyText, { encoding: "utf8", mode: 0o600 });
  try {
    return await new Promise<ProbeResponse>((resolve, reject) => {
      const child = spawn("curl", [
        "--config", "-",
        "--silent",
        "--show-error",
        "--no-buffer",
        "--http2",
        "--include",
        "--request", "POST",
        "--data-binary", `@${bodyPath}`,
        "--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1000))),
        url,
      ], {
        shell: false,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let pipeError = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdin.on("error", (error) => { pipeError ||= String(error); });
      child.once("error", reject);
      child.once("close", (code) => {
        const parsed = splitCurlIncludedResponse(stdout);
        if (code !== 0 && !parsed.status) return reject(new Error(stderr.trim() || pipeError || `curl exited with ${code}`));
        resolve(parsed);
      });
      const config = Object.entries(headers).map(([name, value]) => {
        if (/[\r\n]/.test(value)) throw new Error(`Invalid newline in curl header ${name}`);
        const escaped = `${name}: ${value}`.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
        return `header = "${escaped}"`;
      }).join("\n");
      child.stdin.end(`${config}\n`);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  if (!process.argv.includes("--live") || process.env.PI_ANYROUTER_CC_ALLOW_LIVE !== "1") {
    throw new Error("Live probe refused. It requires both --live and PI_ANYROUTER_CC_ALLOW_LIVE=1 after explicit user approval.");
  }
  const requestPath = arg("--request");
  if (!requestPath) throw new Error("Usage: npm run probe -- --live --request <candidate.json> [--output <redacted-result.json>]");
  const transport = arg("--transport") || "fetch";
  if (transport !== "fetch" && transport !== "curl-http2") {
    throw new Error(`Unsupported transport ${transport}; expected fetch or curl-http2`);
  }

  const configPath = process.env.PI_ANYROUTER_CC_CONFIG || join(homedir(), ".pi", "agent", "anyrouter.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const baseUrl = process.env.PI_ANYROUTER_CC_BASE_URL || config.baseUrl;
  const apiKey = process.env.PI_ANYROUTER_CC_API_KEY || resolveConfigValue(config.apiKey);
  if (!baseUrl || !apiKey) throw new Error(`Missing baseUrl/apiKey in ${configPath}`);

  const candidate = JSON.parse(readFileSync(requestPath, "utf8"));
  const request = candidate.request && typeof candidate.request === "object" ? candidate.request : candidate;
  const body = typeof request.body === "string" ? JSON.parse(request.body) : request.body;
  if (!body || typeof body !== "object") throw new Error("Candidate request body must be an object");
  const candidateHeaders = Object.fromEntries(
    Object.entries(request.headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
  for (const name of ["authorization", "x-api-key", "host", "content-length", "connection", "accept-encoding"]) delete candidateHeaders[name];
  const headers = { ...candidateHeaders, authorization: `Bearer ${apiKey}` };
  const url = `${String(baseUrl).replace(/\/+$/, "")}/v1/messages?beta=true`;
  const timeoutMs = Number(arg("--timeout-ms") || 120_000);
  const started = performance.now();
  const response = transport === "fetch"
    ? await runFetchProbe(url, headers, JSON.stringify(body), timeoutMs)
    : await runCurlProbe(url, headers, JSON.stringify(body), timeoutMs);
  const status = response.status;
  const responseText = response.body;
  let requestId = response.requestId;
  if (!requestId) {
    try {
      const parsed = JSON.parse(responseText);
      requestId = parsed?.error?.message?.match(/request id:\s*([^\)]+)/i)?.[1];
    } catch {
      // The redacted summary below does not require a JSON response.
    }
  }
  const latencyMs = Math.round(performance.now() - started);
  const safeBody = redactText(responseText, apiKey);
  let error: unknown;
  try {
    const parsed = JSON.parse(safeBody);
    error = parsed?.error ? { type: parsed.error.type, message: String(parsed.error.message || "").slice(0, 500) } : undefined;
  } catch {
    error = status >= 400 ? safeBody.slice(0, 500) : undefined;
  }
  const result = {
    live: true,
    transport,
    status,
    ok: status >= 200 && status < 300,
    requestId,
    latencyMs,
    requestHash: structuralHash({ headers: candidateHeaders, body }),
    responseBytes: Buffer.byteLength(responseText),
    error,
  };
  console.log(JSON.stringify(result, null, 2));
  const output = arg("--output");
  if (output) writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[probe] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
