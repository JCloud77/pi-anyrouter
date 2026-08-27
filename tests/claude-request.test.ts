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
      provider: "anyrouter",
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
  assert.equal(body.messages[2].content.length, 3);
  assert.equal(body.messages[2].content[0].tool_use_id, "toolu_1");
  assert.equal(body.messages[2].content[2].type, "image");
});

test("removes adapter retry artifacts and restores valid Claude history ordering", () => {
  const profile = makeSyntheticProfile();
  const messages = [
    { role: "user", content: "start" },
    {
      role: "assistant",
      provider: "anyrouter",
      errorMessage: "[anyrouter] terminated",
      content: [
        { type: "text", text: "⏳ 429 — retrying (1/10)…" },
        { type: "text", text: "⏳ incomplete stream — retrying (2/10)…" },
        { type: "thinking", thinking: "valid private thought", thinkingSignature: "valid-signature" },
        { type: "text", text: "model-authored text" },
        { type: "toolCall", id: "toolu_retry_1", name: "read", arguments: { path: "/tmp/a" } },
        { type: "text", text: "[anyrouter] terminated" },
      ],
    },
    { role: "toolResult", toolCallId: "toolu_retry_1", toolName: "read", content: [{ type: "text", text: "read result" }], isError: false },
    {
      role: "assistant",
      provider: "anyrouter",
      content: [
        { type: "text", text: "⏳ 429 — retrying (1/10)…" },
        { type: "text", text: "⏳ 429 — retrying (2/10)…" },
      ],
    },
    { role: "user", content: "continue" },
  ];

  const { body } = buildClaudeRequest(
    profile,
    model,
    context(messages),
    undefined,
    "00000000-0000-4000-8000-000000000010",
    "compatible-core",
  );

  assert.deepEqual(body.messages.map((message: any) => message.role), ["user", "system", "assistant", "user"]);
  assert.deepEqual(body.messages[2].content.map((block: any) => block.type), ["thinking", "text", "tool_use"]);
  assert.equal(body.messages[2].content[0].signature, "valid-signature");
  assert.deepEqual(body.messages[3].content.map((block: any) => block.type), ["tool_result", "text"]);
  assert.equal(body.messages[3].content[1].text, "continue");
  assert.doesNotMatch(JSON.stringify(body.messages), /retrying|\[anyrouter\] terminated/);
});

test("requires a user turn and safely transcribes incompatible historical tool calls", () => {
  const profile = makeSyntheticProfile();
  assert.throws(
    () => buildClaudeRequest(profile, model, context([]), undefined, "00000000-0000-4000-8000-000000000003"),
    /at least one user message/,
  );

  const calls = [
    { type: "toolCall", id: "toolu_edit_1", name: "edit", arguments: { path: "a", edits: [{ oldText: "x", newText: "y" }, { oldText: "z", newText: "q" }] } },
    { type: "toolCall", id: "toolu_search_1", name: "web_search", arguments: { queries: ["one", "two"] } },
    { type: "toolCall", id: "toolu_fetch_1", name: "fetch_content", arguments: { urls: ["https://a", "https://b"] } },
    { type: "toolCall", id: "toolu_todo_1", name: "todo", arguments: { action: "list" } },
    { type: "toolCall", id: "toolu_read_1", name: "read", arguments: { path: "/tmp/a" } },
  ];
  const results = calls.map((call) => ({
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: `${call.name} completed` }],
    isError: false,
  }));
  const { body } = buildClaudeRequest(profile, model, context([
    { role: "user", content: "continue prior work" },
    { role: "assistant", provider: "anyrouter", content: calls },
    ...results,
  ]), undefined, "00000000-0000-4000-8000-000000000004", "compatible-core");

  const assistant = body.messages[2];
  assert.equal(assistant.content.filter((block: any) => block.type === "tool_use").length, 1);
  assert.equal(assistant.content.find((block: any) => block.type === "tool_use").name, "Read");
  const transcript = assistant.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
  assert.match(transcript, /Tool: edit/);
  assert.match(transcript, /Tool: web_search/);
  assert.match(transcript, /Tool: fetch_content/);
  assert.match(transcript, /Tool: todo/);
  assert.match(transcript, /must not be executed again/);

  const resultMessage = body.messages[3];
  assert.equal(resultMessage.content[0].type, "tool_result");
  assert.equal(resultMessage.content[0].tool_use_id, "toolu_read_1");
  assert.equal(resultMessage.content.filter((block: any) => block.type === "tool_result").length, 1);
  const resultTranscript = resultMessage.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join("\n");
  assert.match(resultTranscript, /Tool: edit/);
  assert.match(resultTranscript, /edit completed/);
  assert.match(resultTranscript, /Tool: todo/);
});

test("drops foreign reasoning signatures and transcribes foreign tool protocols", () => {
  const profile = makeSyntheticProfile();
  const { body } = buildClaudeRequest(profile, model, context([
    { role: "user", content: "continue cross-provider work" },
    {
      role: "assistant",
      provider: "openai-codex",
      content: [
        { type: "thinking", thinking: "foreign private reasoning", thinkingSignature: "foreign-encrypted-signature" },
        { type: "toolCall", id: "call_openai_123", name: "read", arguments: { path: "/tmp/a" } },
      ],
    },
    { role: "toolResult", toolCallId: "call_openai_123", toolName: "read", content: [{ type: "text", text: "old result" }], isError: false },
  ]), undefined, "00000000-0000-4000-8000-000000000009", "compatible-core");

  const assistant = body.messages[2];
  assert.deepEqual(assistant.content.map((block: any) => block.type), ["text"]);
  assert.match(assistant.content[0].text, /provider openai-codex/);
  assert.doesNotMatch(JSON.stringify(body.messages), /foreign private reasoning|foreign-encrypted-signature/);
  assert.equal(body.messages[3].content.some((block: any) => block.type === "tool_result"), false);
  assert.match(body.messages[3].content[0].text, /Historical pi tool result replayed as text/);
});
