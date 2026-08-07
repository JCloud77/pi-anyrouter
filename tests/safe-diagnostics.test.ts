import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inspectDebugDirectory,
  redactSensitive,
  safeJson,
  selectReplayRequest,
  summarizeApiKey,
  summarizeDebugRequest,
  summarizeProfile,
} from "../src/safe-diagnostics.ts";

const SECRET_KEY = "sk-test-secret-value-123456789";
const PRIVATE_PROMPT = "PRIVATE_PROMPT_SHOULD_NEVER_APPEAR";
const PRIVATE_TEMPLATE = "PRIVATE_PROPRIETARY_TEMPLATE_SHOULD_NEVER_APPEAR";

test("safe diagnostics summarize profiles without exposing template text", () => {
  const profile = {
    schemaVersion: 1,
    claudeCode: { version: "2.1.220", billingVersion: "2.1.220.f7c", executable: "/home/private/bin/claude" },
    request: {
      coreToolNames: ["Bash", "Edit", "Read", "WebFetch", "WebSearch", "Write"],
      defaultToolNames: Array.from({ length: 24 }, (_, index) => `Tool${index}`),
      defaultMessageScaffold: [{ role: "user" }, { role: "system" }],
      systemTemplate: [{ type: "text", text: PRIVATE_TEMPLATE }],
      defaultSystemTemplate: [{ type: "text", text: PRIVATE_TEMPLATE }],
    },
    hashes: { defaultSystem: "hash-only" },
  };
  const serialized = JSON.stringify(summarizeProfile(profile));
  assert.doesNotMatch(serialized, /PRIVATE_PROPRIETARY/);
  assert.doesNotMatch(serialized, /\/home\/private/);
  assert.match(serialized, /normalizedSha256/);
});

test("safe diagnostics omit prompts, schemas, header values, ids, and credentials", () => {
  const request = {
    transport: "sse",
    headers: { authorization: `Bearer ${SECRET_KEY}`, "x-api-key": SECRET_KEY, "user-agent": "safe-agent" },
    body: {
      model: "claude-opus-5",
      system: [{ type: "text", text: PRIVATE_TEMPLATE }],
      messages: [{ role: "user", content: [{ type: "text", text: PRIVATE_PROMPT }] }],
      tools: [{ name: "Read", description: PRIVATE_TEMPLATE, input_schema: { secret: PRIVATE_PROMPT } }],
      metadata: { user_id: JSON.stringify({ device_id: "a".repeat(64), account_uuid: "", session_id: "00000000-0000-4000-8000-000000000001" }) },
      output_config: { effort: "high" },
      thinking: { type: "adaptive", display: "omitted" },
      max_tokens: 64000,
      stream: true,
    },
  };
  const serialized = JSON.stringify(summarizeDebugRequest(request));
  for (const forbidden of [SECRET_KEY, PRIVATE_PROMPT, PRIVATE_TEMPLATE, "00000000-0000-4000-8000-000000000001", "a".repeat(64), "safe-agent"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.match(serialized, /"toolNames":\["Read"\]/);
  assert.match(serialized, /"deviceIdIsHex64":true/);
});

test("safe reports redact exact and credential-shaped secrets", () => {
  const value = { message: `Bearer ${SECRET_KEY}`, nested: SECRET_KEY, path: "/home/private/project" };
  const serialized = safeJson(value, [SECRET_KEY]);
  assert.doesNotMatch(serialized, /sk-test-secret/);
  assert.doesNotMatch(serialized, /\/home\/private/);
  assert.match(serialized, /REDACTED/);
  assert.equal(redactSensitive(`token=${SECRET_KEY}`, [SECRET_KEY]).includes(SECRET_KEY), false);
});

test("API key diagnostics report source without returning the value", () => {
  const literal = summarizeApiKey({ apiKey: SECRET_KEY }, {});
  const referenced = summarizeApiKey({ apiKey: "ANYROUTER_KEY" }, { ANYROUTER_KEY: SECRET_KEY });
  assert.equal(JSON.stringify(literal).includes(SECRET_KEY), false);
  assert.equal(JSON.stringify(referenced).includes(SECRET_KEY), false);
  assert.equal(literal.source, "config-literal");
  assert.equal(referenced.source, "config-env-reference");
});

test("debug directory inspection stays structural and replay selects the full catalog", () => {
  const directory = mkdtempSync(join(tmpdir(), "safe-diagnostics-test-"));
  try {
    const makeRequest = (count: number) => ({
      headers: { authorization: `Bearer ${SECRET_KEY}` },
      body: {
        model: "claude-opus-5",
        messages: [{ role: "user", content: [{ type: "text", text: PRIVATE_PROMPT }] }],
        system: [{ type: "text", text: PRIVATE_TEMPLATE }],
        tools: Array.from({ length: count }, (_, index) => ({ name: `Tool${index}`, description: PRIVATE_TEMPLATE })),
        metadata: {},
      },
    });
    const corePath = join(directory, "001-request.json");
    const fullPath = join(directory, "002-request.json");
    writeFileSync(corePath, JSON.stringify(makeRequest(6)));
    writeFileSync(fullPath, JSON.stringify(makeRequest(24)));
    writeFileSync(join(directory, "003-error.json"), JSON.stringify({ status: 429, requestId: "safe-request-id", body: { error: { type: "error", message: `Service Unavailable ${SECRET_KEY}` } } }));

    const report = inspectDebugDirectory(directory, [SECRET_KEY]);
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(SECRET_KEY), false);
    assert.equal(serialized.includes(PRIVATE_PROMPT), false);
    assert.equal(serialized.includes(PRIVATE_TEMPLATE), false);
    assert.equal(selectReplayRequest(directory), fullPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
