import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../index.ts";
import { makeTool } from "./helpers.ts";

test("keeps the v0.3.2 Codex request and header shape unchanged", () => {
  const model = { id: "gpt-test", maxTokens: 32_000 } as any;
  const context = {
    systemPrompt: "system",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: [
        { type: "text", text: "working" },
        { type: "toolCall", id: "call_1|item_1", name: "read", arguments: { path: "a" } },
      ] },
      { role: "toolResult", toolCallId: "call_1|item_1", toolName: "read", content: [{ type: "text", text: "result" }], isError: false },
    ],
    tools: [makeTool("read", { path: { type: "string" } }, ["path"])],
  } as any;
  const metadata = {
    windowId: "session:0",
    turnMetadata: "{\"fixed\":true}",
    clientMetadata: { session_id: "session", turn_id: "turn" },
  } as any;
  const body = __testing.buildCodexRequestBody(model, context, { reasoning: "medium" } as any, "session", metadata);
  assert.deepEqual(body, {
    model: "gpt-test",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "system" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "working", annotations: [] }] },
      { type: "function_call", id: "item_1", call_id: "call_1", name: "read", arguments: '{"path":"a"}' },
      { type: "function_call_output", call_id: "call_1", output: "result" },
    ],
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "medium", context: "all_turns" },
    store: false,
    stream: true,
    text: { verbosity: "low" },
    max_output_tokens: 32_000,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "session",
    client_metadata: metadata.clientMetadata,
    tools: [{
      type: "function",
      name: "read",
      description: "Pi read fixture",
      parameters: context.tools[0].parameters,
      strict: false,
    }],
  });

  const headers = __testing.createCodexHeaders("key", "session", metadata);
  assert.equal(headers.authorization, "Bearer key");
  assert.equal(headers["user-agent"], "codex_exec/0.144.1 (Linux; x86_64) (codex_exec; 0.144.1)");
  assert.equal(headers["x-openai-internal-codex-responses-lite"], "true");
  assert.equal(headers["x-codex-window-id"], "session:0");
});
