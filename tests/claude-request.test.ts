import assert from "node:assert/strict";
import test from "node:test";
import { buildClaudeRequest, createClaudeHeaders } from "../src/claude-request.ts";
import { makeSyntheticProfile, makeTool } from "./helpers.ts";

const model = {
  id: "claude-fable-5",
  api: "anyrouter-messages",
  provider: "anyrouter",
  maxTokens: 128_000,
  reasoning: true,
} as any;

function context(messages: any[]) {
  return {
    systemPrompt: "PI SYSTEM INSTRUCTIONS",
    messages,
    tools: [
      makeTool("read"),
      makeTool("bash"),
      makeTool("edit"),
      makeTool("write"),
      makeTool("web_search"),
      makeTool("fetch_content"),
      makeTool("todo", { action: { type: "string" } }, ["action"]),
    ],
  } as any;
}

test("builds profile-driven headers, system, scaffold, tools, and defaults", () => {
  const profile = makeSyntheticProfile();
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const { body } = buildClaudeRequest(
    profile,
    model,
    context([{ role: "user", content: "Reply with exactly OK" }]),
    { reasoning: "low", maxTokens: 100_000 } as any,
    sessionId,
  );
  const headers = createClaudeHeaders(profile, "private-test-key", sessionId);

  assert.deepEqual(Object.keys(body), [
    "model", "messages", "system", "tools", "metadata", "max_tokens", "thinking", "context_management", "output_config", "stream",
  ]);
  assert.equal(body.max_tokens, 64_000);
  assert.equal(body.output_config.effort, "low");
  assert.equal(body.stream, true);
  assert.equal(body.system.length, 3);
  assert.match(body.system[2].text, /PI SYSTEM INSTRUCTIONS/);
  assert.match(body.system[2].text, /claude-fable-5/);
  assert.doesNotMatch(JSON.stringify(body.system), /\{\{[^}]+\}\}/);
  assert.equal(body.messages[0].role, "user");
  assert.match(body.messages[0].content[0].text, /Today's date is \d{4}-\d{2}-\d{2}/);
  assert.equal(body.messages[0].content[1].text, "Reply with exactly OK");
  assert.deepEqual(body.tools.map((tool: any) => tool.name), [
    "Bash", "Edit", "Read", "WebFetch", "WebSearch", "Write", "mcp__pi__todo_602fae58",
  ]);
  assert.equal(JSON.parse(body.metadata.user_id).device_id, "a".repeat(64));
  assert.equal(JSON.parse(body.metadata.user_id).session_id, sessionId);
  assert.equal(headers.authorization, "Bearer private-test-key");
  assert.equal(headers["x-claude-code-session-id"], sessionId);
  assert.match(headers["user-agent"], /2\.1\.220/);
});

test("can build a text-only diagnostic request with the full official catalog", () => {
  const profile = makeSyntheticProfile();
  const { body, registry } = buildClaudeRequest(
    profile,
    model,
    context([{ role: "user", content: "Reply with exactly OK" }]),
    undefined,
    "00000000-0000-4000-8000-000000000005",
    "full-official",
  );
  assert.deepEqual(body.tools.map((tool: any) => tool.name), profile.request.defaultToolNames);
  assert.equal(body.tools.some((tool: any) => tool.name.startsWith("mcp__pi__")), false);
  assert.deepEqual(body.messages.map((message: any) => message.role), ["user", "system"]);
  assert.match(body.system[1].text, /default identity/);
  assert.doesNotMatch(JSON.stringify(body.system), /PI SYSTEM INSTRUCTIONS/);
  const headers = createClaudeHeaders(profile, "key", "00000000-0000-4000-8000-000000000005", "full-official");
  assert.equal(headers["x-stainless-timeout"], "120");
  assert.throws(() => registry.getPiName("Agent"), /diagnostic-only/);

  const subset = buildClaudeRequest(
    profile,
    model,
    context([{ role: "user", content: "Reply with exactly OK" }]),
    undefined,
    "00000000-0000-4000-8000-000000000006",
    "full-official",
    ["Write", "Agent", "Read"],
  );
  assert.deepEqual(subset.body.tools.map((tool: any) => tool.name), ["Agent", "Read", "Write"]);
});

test("compatible-core uses the accepted default envelope with only mapped core tools", () => {
  const profile = makeSyntheticProfile();
  const { body } = buildClaudeRequest(
    profile,
    model,
    context([{ role: "user", content: "Reply with exactly OK" }]),
    undefined,
    "00000000-0000-4000-8000-000000000007",
    "compatible-core",
  );
  assert.deepEqual(body.tools.map((tool: any) => tool.name), profile.request.coreToolNames);
  assert.deepEqual(body.messages.map((message: any) => message.role), ["user", "system"]);
  assert.match(body.system[1].text, /default identity/);
  assert.doesNotMatch(JSON.stringify(body.system), /PI SYSTEM INSTRUCTIONS/);
  const headers = createClaudeHeaders(profile, "key", "00000000-0000-4000-8000-000000000007", "compatible-core");
  assert.equal(headers["x-stainless-timeout"], "120");

  const reminded = buildClaudeRequest(
    profile,
    model,
    { ...context([{ role: "user", content: "Reply with exactly OK" }]), systemPrompt: "PI_SENTINEL_123" },
    undefined,
    "00000000-0000-4000-8000-000000000008",
    "compatible-core",
    undefined,
    "user-reminder",
  );
  assert.equal(reminded.body.messages[0].content.length, 2);
  assert.match(reminded.body.messages[0].content[1].text, /^<system-reminder>/);
  assert.match(reminded.body.messages[0].content[1].text, /PI_SENTINEL_123/);
  assert.match(reminded.body.messages[0].content[1].text, /Reply with exactly OK/);
  assert.doesNotMatch(JSON.stringify(reminded.body.system), /PI_SENTINEL_123/);
});

test("replays MCP/core tool calls and groups tool results", () => {
  const profile = makeSyntheticProfile();
  const messages = [
    { role: "user", content: "do work" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private thought", thinkingSignature: "signature" },
        { type: "toolCall", id: "toolu_1", name: "todo", arguments: { action: "list" } },
        { type: "toolCall", id: "toolu_2", name: "read", arguments: { path: "/tmp/a", offset: 1 } },
      ],
    },
    { role: "toolResult", toolCallId: "toolu_1", toolName: "todo", content: [{ type: "text", text: "one" }], isError: false },
    { role: "toolResult", toolCallId: "toolu_2", toolName: "read", content: [{ type: "text", text: "two" }], isError: false },
    { role: "user", content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] },
  ];
  const { body } = buildClaudeRequest(profile, model, context(messages), undefined, "00000000-0000-4000-8000-000000000002");
  const assistant = body.messages[1];
  assert.deepEqual(assistant.content.map((block: any) => block.type), ["thinking", "tool_use", "tool_use"]);
  assert.equal(assistant.content[1].name, "mcp__pi__todo_602fae58");
  assert.deepEqual(assistant.content[2].input, { file_path: "/tmp/a", offset: 1 });
  assert.equal(body.messages[2].content.length, 2);
  assert.equal(body.messages[2].content[0].tool_use_id, "toolu_1");
  assert.equal(body.messages[3].content[0].type, "image");
});

test("requires a user turn and rejects unsupported historical edits", () => {
  const profile = makeSyntheticProfile();
  assert.throws(
    () => buildClaudeRequest(profile, model, context([]), undefined, "00000000-0000-4000-8000-000000000003"),
    /at least one user message/,
  );
  assert.throws(
    () => buildClaudeRequest(profile, model, context([
      { role: "user", content: "x" },
      { role: "assistant", content: [{ type: "toolCall", id: "1", name: "edit", arguments: { path: "a", edits: [{ oldText: "x", newText: "y" }, { oldText: "z", newText: "q" }] } }] },
    ]), undefined, "00000000-0000-4000-8000-000000000004"),
    /exactly one pi edit entry/,
  );
});
