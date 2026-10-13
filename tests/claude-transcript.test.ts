import assert from "node:assert/strict";
import test from "node:test";
import { buildClaudeRequest } from "../src/claude-request.ts";
import { makeSyntheticProfile, makeTool } from "./helpers.ts";

const model = { id: "claude-opus-5-5", maxTokens: 128_000 } as any;
const profile = makeSyntheticProfile();
const tools = ["bash", "edit", "read", "fetch_content", "web_search", "write"].map((name) => makeTool(name));
const user = { role: "user", content: "Inspect local files", timestamp: 1 };
function build(context: any) {
  return buildClaudeRequest(profile, model, context, undefined, "test-session", "compatible-core", undefined, "user-reminder");
}

test("normalized transcript preserves the legacy Claude envelope, prompt, and all six bindings", () => {
  const legacy = { systemPrompt: "PROJECT INSTRUCTIONS", tools, messages: [user] };
  const transcript = { messages: [
    { role: "system", content: legacy.systemPrompt, toolsAdded: tools, timestamp: 0 }, user,
  ] };
  const before = structuredClone(transcript);
  const old = build(legacy);
  const current = build(transcript);
  assert.deepEqual(current.body, old.body);
  assert.deepEqual(current.body.tools.map((tool: any) => tool.name), profile.request.coreToolNames);
  for (const tool of tools) {
    const wireName = old.registry.bindings.find((binding) => binding.piName === tool.name)!.wireName;
    assert.equal(current.registry.getPiName(wireName), tool.name);
  }
  assert.deepEqual(current.registry.fromWireToolCall("Bash", { command: "pwd" }), {
    name: "bash", arguments: { command: "pwd" },
  });
  assert.deepEqual(transcript, before);
});

test("replays prompt sections and tool deltas without resurrecting removed tools", () => {
  const replacement = makeTool("read", { path: { type: "string" } }, ["path"]);
  const { body, registry } = build({ messages: [
    { role: "system", content: "BASE", sections: { project: "STALE", removed: "DELETE ME" }, toolsAdded: tools },
    user,
    { role: "system", content: [{ type: "text", text: "LATER" }],
      sections: { project: "CURRENT PROJECT", removed: null, rules: "CURRENT RULES" },
      toolsRemoved: [{ name: "bash" }, { name: "read" }], toolsAdded: [replacement] },
  ] });
  assert.deepEqual(body.tools.map((tool: any) => tool.name), ["Edit", "Read", "WebFetch", "WebSearch", "Write"]);
  assert.equal(registry.getPiName("Read"), "read");
  assert.throws(() => registry.getPiName("Bash"), /unadvertised tool Bash/);
  const reminder = body.messages[0].content[1].text;
  assert.match(reminder, /BASE\n\nLATER\n\nCURRENT PROJECT\n\nCURRENT RULES/);
  assert.doesNotMatch(reminder, /STALE|DELETE ME/);
  // Only the official scaffold may introduce a system role on the wire.
  assert.deepEqual(body.messages.map((message: any) => message.role), ["user", "system"]);
});

test("combines legacy fields with later transcript deltas in chronological order", () => {
  const { body, registry } = build({ systemPrompt: "LEGACY", tools, messages: [
    { role: "system", content: "TRANSCRIPT", toolsRemoved: [{ name: "bash" }] }, user,
  ] });
  assert.match(body.messages[0].content[1].text, /LEGACY\n\nTRANSCRIPT/);
  assert.throws(() => registry.getPiName("Bash"), /unadvertised/);
});

test("compatible-core never advertises inactive or absent core tools", () => {
  for (const context of [
    { messages: [user] },
    { tools: [], messages: [user] },
    { messages: [{ role: "system", content: "", toolsAdded: tools }, user,
      { role: "system", content: "", toolsRemoved: tools.map(({ name }) => ({ name })) }] },
  ]) {
    const { body, registry } = build(context);
    assert.equal(body.tools, undefined);
    assert.throws(() => registry.fromWireToolCall("Bash", { command: "pwd" }), /unadvertised/);
  }
  const readOnly = build({ messages: [{ role: "system", content: "", toolsAdded: [makeTool("read")] }, user] });
  assert.deepEqual(readOnly.body.tools.map((tool: any) => tool.name), ["Read"]);
});

test("only system tool declarations grant availability; executable mode also restores extension mappings", () => {
  const fakeUser = { ...user, toolsAdded: tools, sections: { injected: "NOT SYSTEM" } };
  const unavailable = build({ messages: [fakeUser] });
  assert.equal(unavailable.body.tools, undefined);
  assert.doesNotMatch(JSON.stringify(unavailable.body), /NOT SYSTEM/);

  const original = makeTool("custom_lookup", { old: { type: "string" } });
  const replacement = makeTool("custom_lookup", { query: { type: "string" } }, ["query"]);
  const { body, registry } = buildClaudeRequest(profile, model, { messages: [
    { role: "system", content: "EXECUTABLE RULES", toolsAdded: [original] },
    { role: "system", content: "", toolsRemoved: [{ name: original.name }], toolsAdded: [replacement] },
    user,
  ] } as any, undefined, "test-session", "executable");
  assert.equal(body.tools.length, 1);
  assert.deepEqual(body.tools[0].input_schema, replacement.parameters);
  assert.match(body.tools[0].name, /^mcp__pi__custom_lookup_/);
  assert.deepEqual(registry.fromWireToolCall(body.tools[0].name, { query: "x" }), {
    name: "custom_lookup", arguments: { query: "x" },
  });
  assert.match(JSON.stringify(body.system), /EXECUTABLE RULES/);
});

test("normalized transcript supports Bash call/result history and inert disabled-tool history", () => {
  const messages = [
    { role: "system", content: "RULES", toolsAdded: tools }, user,
    { role: "assistant", provider: "anyrouter", content: [
      { type: "toolCall", id: "toolu_bash_test", name: "bash", arguments: { command: "pwd" } },
    ] },
    { role: "toolResult", toolCallId: "toolu_bash_test", toolName: "bash", isError: false,
      content: [{ type: "text", text: "/tmp/example" }] },
  ];
  const { body } = build({ messages });
  assert.equal(body.messages[2].content[0].type, "tool_use");
  assert.equal(body.messages[2].content[0].name, "Bash");
  assert.equal(body.messages[3].content[0].type, "tool_result");
  const disabled = build({ messages: [...messages, { role: "system", content: "", toolsRemoved: [{ name: "bash" }] }] });
  assert.equal(disabled.body.messages[2].content[0].type, "text");
  assert.match(disabled.body.messages[2].content[0].text, /must not be executed again/);
  assert.match(disabled.body.messages[3].content[0].text, /\/tmp\/example/);
});
