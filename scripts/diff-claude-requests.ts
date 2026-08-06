#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { canonicalJson, structuralHash } from "../src/claude-profile.ts";

type JsonObject = Record<string, any>;

function usage() {
  console.error("Usage: npm run diagnose -- <official-capture.json> <candidate-request.json> [--json]");
  process.exitCode = 2;
}

function readRequest(path: string) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const request = parsed.request && typeof parsed.request === "object" ? parsed.request : parsed;
  const body = request.body && typeof request.body === "string" ? JSON.parse(request.body) : request.body;
  if (!body || typeof body !== "object") throw new Error(`${path} does not contain an object body`);
  const headers = Object.fromEntries(
    Object.entries(request.headers || {}).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value)]),
  );
  return {
    method: String(request.method || "POST").toUpperCase(),
    url: String(request.url || request.urlPath || "/v1/messages?beta=true"),
    headers,
    body,
  };
}

function normalizeString(value: string) {
  return value
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer {{REDACTED}}")
    .replace(/\b[0-9a-f]{64}\b/gi, "{{DEVICE_ID}}")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "{{UUID}}")
    .replace(/Today'?s date is \d{4}-\d{2}-\d{2}/g, "Today's date is {{CURRENT_DATE}}")
    .replace(/"session_id":"[^"]*"/g, '"session_id":"{{SESSION_ID}}"')
    .replace(/"device_id":"[^"]*"/g, '"device_id":"{{DEVICE_ID}}"')
    .replace(/"account_uuid":"[^"]*"/g, '"account_uuid":"{{ACCOUNT_UUID}}"');
}

function normalize(value: any, path = "$body"): any {
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${path}[${index}]`));
  if (value && typeof value === "object") {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (["authorization", "x-api-key", "cookie", "set-cookie", "content-length", "host", "connection", "accept-encoding"].includes(lower)) continue;
      if (["x-claude-code-session-id"].includes(lower)) {
        out[key] = "{{SESSION_ID}}";
      } else if (key === "user_id" && typeof item === "string") {
        try {
          const metadata = JSON.parse(item);
          out[key] = canonicalJson({ ...metadata, device_id: "{{DEVICE_ID}}", session_id: "{{SESSION_ID}}", account_uuid: "{{ACCOUNT_UUID}}" });
        } catch {
          out[key] = normalizeString(item);
        }
      } else {
        out[key] = normalize(item, `${path}.${key}`);
      }
    }
    return out;
  }
  return typeof value === "string" ? normalizeString(value) : value;
}

function differences(left: any, right: any, path = "$", output: string[] = []) {
  if (Object.is(left, right)) return output;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      output.push(`${path}: type ${Array.isArray(left) ? "array" : typeof left} != ${Array.isArray(right) ? "array" : typeof right}`);
      return output;
    }
    if (left.length !== right.length) output.push(`${path}.length: ${left.length} != ${right.length}`);
    for (let index = 0; index < Math.min(left.length, right.length); index++) differences(left[index], right[index], `${path}[${index}]`, output);
    return output;
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      if (!(key in left)) output.push(`${path}.${key}: missing on left`);
      else if (!(key in right)) output.push(`${path}.${key}: missing on right`);
      else differences(left[key], right[key], `${path}.${key}`, output);
    }
    return output;
  }
  const leftText = typeof left === "string" && left.length > 160 ? `${left.slice(0, 157)}...` : JSON.stringify(left);
  const rightText = typeof right === "string" && right.length > 160 ? `${right.slice(0, 157)}...` : JSON.stringify(right);
  output.push(`${path}: ${leftText} != ${rightText}`);
  return output;
}

function toolSummary(body: JsonObject) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.map((tool: any) => ({
    name: tool.name,
    descriptionHash: structuralHash(String(tool.description || "")),
    schemaHash: structuralHash(tool.input_schema || tool.parameters || {}),
  }));
}

function systemSummary(body: JsonObject) {
  const blocks = Array.isArray(body.system) ? body.system : [];
  return blocks.map((block: any, index: number) => ({
    index,
    type: block?.type,
    cache: block?.cache_control?.type,
    textLength: String(block?.text || "").length,
    hash: structuralHash(normalizeString(String(block?.text || ""))),
  }));
}

function messageSummary(body: JsonObject) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages.map((message: any, index: number) => ({
    index,
    role: message?.role,
    blocks: Array.isArray(message?.content) ? message.content.map((block: any) => block?.type) : typeof message?.content,
    cache: Array.isArray(message?.content) ? message.content.map((block: any) => block?.cache_control?.type || null) : [],
  }));
}

function main() {
  const paths = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  if (paths.length !== 2) return usage();
  const left = readRequest(paths[0]);
  const right = readRequest(paths[1]);
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  const diff = differences(normalizedLeft, normalizedRight);
  const report = {
    equal: diff.length === 0,
    differenceCount: diff.length,
    differences: diff,
    left: {
      requestHash: structuralHash(normalizedLeft),
      headers: Object.keys(normalizedLeft.headers).sort(),
      bodyKeys: Object.keys(normalizedLeft.body).sort(),
      system: systemSummary(normalizedLeft.body),
      messages: messageSummary(normalizedLeft.body),
      tools: toolSummary(normalizedLeft.body),
    },
    right: {
      requestHash: structuralHash(normalizedRight),
      headers: Object.keys(normalizedRight.headers).sort(),
      bodyKeys: Object.keys(normalizedRight.body).sort(),
      system: systemSummary(normalizedRight.body),
      messages: messageSummary(normalizedRight.body),
      tools: toolSummary(normalizedRight.body),
    },
  };

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Normalized requests equal: ${report.equal}`);
    console.log(`Differences: ${report.differenceCount}`);
    console.log(`Left hash:  ${report.left.requestHash}`);
    console.log(`Right hash: ${report.right.requestHash}`);
    console.log(`System blocks: ${report.left.system.length} vs ${report.right.system.length}`);
    console.log(`Tools: ${report.left.tools.length} vs ${report.right.tools.length}`);
    for (const line of diff.slice(0, 100)) console.log(`- ${line}`);
    if (diff.length > 100) console.log(`- ... ${diff.length - 100} more differences (use --json)`);
  }
  if (diff.length) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`[diagnose] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
