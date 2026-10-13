import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../index.ts";
import { getAstraCodexVersion, validateAstraCodexVersion } from "../src/codex-client.ts";
import { makeTool } from "./helpers.ts";

const metadata = { windowId: "session:0", turnMetadata: "{}", clientMetadata: { session_id: "session" } } as any;
const model = { id: "gpt-6-astra", maxTokens: 32768 } as any;

test("Astra requires the real installed stable Codex CLI >= 0.153.0", () => {
  for (const version of ["codex-cli 0.152.9", "codex-cli 0.153.0-beta.1", "codex-cli garbage", "0.154.0"]) {
    assert.throws(() => validateAstraCodexVersion(version), /Codex CLI >= 0\.153\.0/);
  }
  assert.equal(validateAstraCodexVersion("codex-cli 0.153.0"), "0.153.0");
  assert.equal(validateAstraCodexVersion("codex-cli 0.154.0"), "0.154.0");
  const installedVersion = getAstraCodexVersion();
  assert.match(installedVersion, /^\d+\.\d+\.\d+$/);
  const headers = __testing.createCodexHeaders("dummy", "session", metadata, installedVersion);
  assert.ok(headers["user-agent"].startsWith(`codex_exec/${installedVersion} (`));
  assert.equal(headers.originator, "codex_exec");
});

test("Astra replays Pi transcript system sections and only active tool schemas", () => {
  const tools = [makeTool("bash", { command: { type: "string" } }, ["command"]), makeTool("read")];
  const context = { messages: [
    { role: "system", content: "BASE_INSTRUCTION", sections: { project: "PROJECT_INSTRUCTION" }, toolsAdded: tools },
    { role: "user", content: "hello" },
    { role: "system", content: "LATER_INSTRUCTION", toolsRemoved: [{ name: "read" }] },
  ] } as any;
  const snapshot = structuredClone(context);
  const body = __testing.buildCodexRequestBody(model, context, { reasoning: "low" } as any, "session", metadata, true);
  assert.deepEqual(body.input.map((message: any) => message.role), ["developer", "user"]);
  assert.match(body.input[0].content[0].text, /BASE_INSTRUCTION\n\nLATER_INSTRUCTION\n\nPROJECT_INSTRUCTION/);
  assert.deepEqual(body.tools.map((tool: any) => tool.name), ["bash"]);
  assert.equal(body.tools[0].type, "function");
  assert.equal(body.max_output_tokens, undefined);
  assert.deepEqual(context, snapshot);
});

test("Astra rejects unadvertised model tool calls before Pi can execute", () => {
  const output = { content: [] } as any;
  const events: any[] = [];
  const stream = { push: (event: any) => events.push(event) } as any;
  const item = { type: "function_call", id: "item_1", call_id: "call_1", name: "Agent", arguments: "{}" };
  assert.throws(() => __testing.applyCodexSsePayload({ type: "response.output_item.added", output_index: 0, item }, output, stream, model, new Map(), new Set(["bash"])), /unadvertised tool Agent/);
  assert.deepEqual(output.content, []);
  assert.deepEqual(events, []);
  const allowed = { ...item, name: "bash" };
  __testing.applyCodexSsePayload({ type: "response.output_item.added", output_index: 0, item: allowed }, output, stream, model, new Map(), new Set(["bash"]));
  assert.equal(output.content[0].name, "bash");
});

test("Astra metadata links tool continuations, then starts a new root for the next user turn", () => {
  const sessionId = "astra-session-metadata-test";
  const first = { messages: [{ role: "user", content: "first", timestamp: 100 }] } as any;
  const continuation = { messages: [first.messages[0], { role: "assistant", content: [] },
    { role: "toolResult", content: [{ type: "text", text: "result" }] }] } as any;
  const second = { messages: [...continuation.messages, { role: "user", content: "second", timestamp: 200 }] } as any;
  assert.equal(__testing.getAstraRootTurnId(sessionId, first, "first-turn"), "first-turn");
  assert.equal(__testing.getAstraRootTurnId(sessionId, continuation, "tool-turn"), "first-turn");
  assert.equal(__testing.getAstraRootTurnId(sessionId, second, "next-turn"), "next-turn");
  assert.equal(__testing.getAstraRootTurnId("different-session", first, "other-turn"), "other-turn");
  const current = __testing.createCodexMetadata(sessionId, "tool-turn", "first-turn");
  assert.equal(current.clientMetadata.session_id, sessionId);
  assert.equal(current.clientMetadata.turn_id, "tool-turn");
  assert.equal(current.clientMetadata.root_turn_id, "first-turn");
  assert.equal(JSON.parse(current.turnMetadata).root_turn_id, "first-turn");
  assert.equal(__testing.createCodexMetadata(sessionId, "old-turn").clientMetadata.root_turn_id, undefined);
});

test("Astra doesn't inherit legacy Codex changes and no-tool mode sends no false tools", () => {
  const context = { messages: [{ role: "user", content: "hello" }] } as any;
  const astra = __testing.buildCodexRequestBody(model, context, undefined, "session", metadata, true);
  assert.equal(astra.tools, undefined);
  const old = __testing.buildCodexRequestBody({ ...model, id: "gpt-5-test" }, context, undefined, "session", metadata);
  assert.equal(old.max_output_tokens, model.maxTokens);
  assert.equal(__testing.createCodexHeaders("dummy", "session", metadata)["user-agent"], "codex_exec/0.144.1 (Linux; x86_64) (codex_exec; 0.144.1)");
});
