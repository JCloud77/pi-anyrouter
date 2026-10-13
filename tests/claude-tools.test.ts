import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeToolRegistry } from "../src/claude-tools.ts";
import { makeSyntheticProfile, makeTool } from "./helpers.ts";

function registry() {
  const tools = [
    makeTool("write"),
    makeTool("read"),
    makeTool("bash"),
    makeTool("edit"),
    makeTool("web_search"),
    makeTool("fetch_content"),
    makeTool("todo", { action: { type: "string" } }, ["action"]),
  ];
  return new ClaudeToolRegistry(tools, makeSyntheticProfile());
}

test("orders captured built-ins before MCP tools", () => {
  const value = registry();
  assert.deepEqual(value.tools.map((tool) => tool.name), [
    "Bash", "Edit", "Read", "WebFetch", "WebSearch", "Write", "mcp__pi__todo_602fae58",
  ]);
  assert.equal(value.getPiName("WebFetch"), "fetch_content");
  assert.equal(value.getPiName("mcp__pi__todo_602fae58"), "todo");
});

test("maps core arguments in both directions", () => {
  const value = registry();
  assert.deepEqual(value.toWireToolCall("read", { path: "/tmp/a", offset: 2, limit: 4 }), {
    name: "Read", input: { file_path: "/tmp/a", offset: 2, limit: 4 },
  });
  assert.deepEqual(value.fromWireToolCall("Read", { file_path: "/tmp/a", offset: 2 }), {
    name: "read", arguments: { path: "/tmp/a", offset: 2 },
  });
  assert.deepEqual(value.fromWireToolCall("Bash", { command: "pwd", timeout: 1_500 }), {
    name: "bash", arguments: { command: "pwd", timeout: 2 },
  });
  assert.deepEqual(value.toWireToolCall("bash", { command: "pwd", timeout: 3 }), {
    name: "Bash", input: { command: "pwd", timeout: 3_000 },
  });
  assert.deepEqual(value.fromWireToolCall("Edit", { file_path: "a", old_string: "x", new_string: "y" }), {
    name: "edit", arguments: { path: "a", edits: [{ oldText: "x", newText: "y" }] },
  });
  assert.deepEqual(value.toWireToolCall("edit", { path: "a", edits: [{ oldText: "x", newText: "y" }] }), {
    name: "Edit", input: { file_path: "a", old_string: "x", new_string: "y" },
  });
  assert.deepEqual(value.fromWireToolCall("Write", { file_path: "a", content: "z" }), {
    name: "write", arguments: { path: "a", content: "z" },
  });
  assert.deepEqual(value.fromWireToolCall("WebSearch", { query: "q", allowed_domains: ["a.test"], blocked_domains: ["b.test"] }), {
    name: "web_search", arguments: { query: "q", domainFilter: ["a.test", "-b.test"] },
  });
  assert.deepEqual(value.fromWireToolCall("WebFetch", { url: "https://example.test", prompt: "summarize" }), {
    name: "fetch_content", arguments: { url: "https://example.test", prompt: "summarize", mode: "answer" },
  });
});

test("Read treats empty pages as omitted without changing file or line arguments", () => {
  const profile = makeSyntheticProfile();
  for (const mode of ["executable", "compatible-core", "full-official"] as const) {
    const value = new ClaudeToolRegistry([makeTool("read")], profile, mode);
    const input = { file_path: "/tmp/cases.json", offset: 0, limit: 300, pages: "" };
    const mapped = value.fromWireToolCall("Read", input);
    assert.deepEqual(mapped, {
      name: "read", arguments: { path: input.file_path, offset: 0, limit: 300 },
    }, mode);
    assert.deepEqual(mapped, value.fromWireToolCall("Read", {
      file_path: input.file_path, offset: 0, limit: 300,
    }));
    assert.deepEqual(value.fromWireToolCall("Read", { file_path: input.file_path, pages: "" }), {
      name: "read", arguments: { path: input.file_path },
    });
    assert.deepEqual(value.toWireToolCall(mapped.name, mapped.arguments), {
      name: "Read", input: { file_path: input.file_path, offset: 0, limit: 300 },
    });
    assert.equal(input.pages, "", "mapping must not mutate the original arguments");
  }
});

test("Read still rejects nonempty pages and invalid types instead of silently reading everything", () => {
  const value = registry();
  for (const file_path of ["/tmp/cases.json", "/tmp/document.pdf"]) {
    for (const pages of ["1", "1-2", " ", "\t", "invalid", null, false, 0, [], {}]) {
      assert.throws(() => value.fromWireToolCall("Read", { file_path, pages }), /pages is not supported/);
    }
  }
});

test("MCP mappings are deterministic, collision-safe, and schema preserving", () => {
  const tools = [
    makeTool("A B", { value: { type: "string" } }, ["value"]),
    makeTool("a_b", { count: { type: "number" } }),
  ];
  const value = new ClaudeToolRegistry(tools, makeSyntheticProfile());
  const names = value.tools.map((tool) => tool.name);
  assert.equal(new Set(names).size, 2);
  assert.ok(names.every((name) => /^mcp__pi__[a-z0-9_-]+_[a-f0-9]{8}$/.test(name)));
  assert.deepEqual(value.fromWireToolCall(names[0], { value: "x" }), { name: "A B", arguments: { value: "x" } });
  assert.deepEqual(value.toWireToolCall("A B", { value: "x" }), { name: names[0], input: { value: "x" } });
  assert.deepEqual(value.tools[0].input_schema, tools[0].parameters);
});

test("full-official mode advertises the exact captured catalog and fails closed for unhandled tools", () => {
  const profile = makeSyntheticProfile();
  const value = new ClaudeToolRegistry([
    makeTool("read"),
    makeTool("todo", { action: { type: "string" } }, ["action"]),
  ], profile, "full-official");
  assert.deepEqual(value.tools.map((tool) => tool.name), profile.request.defaultToolNames);
  assert.deepEqual(value.tools[0], profile.request.toolCatalog.Agent);
  assert.equal(value.getPiName("Read"), "read");
  assert.throws(() => value.getPiName("Agent"), /diagnostic-only official tool Agent/);
  assert.throws(() => value.fromWireToolCall("TaskCreate", { subject: "x" }), /no active pi handler/);
  assert.throws(() => value.toWireToolCall("todo", { action: "list" }), /not advertised by the full-official/);
});

test("compatible-core advertises only the captured executable core catalog", () => {
  const profile = makeSyntheticProfile();
  const value = new ClaudeToolRegistry([
    makeTool("write"), makeTool("read"), makeTool("bash"), makeTool("edit"),
    makeTool("web_search"), makeTool("fetch_content"), makeTool("todo"),
  ], profile, "compatible-core");
  assert.deepEqual(value.tools.map((tool) => tool.name), profile.request.coreToolNames);
  assert.equal(value.tools.some((tool) => tool.name.startsWith("mcp__")), false);
  assert.equal(value.getPiName("WebFetch"), "fetch_content");
  assert.throws(() => value.toWireToolCall("todo", { action: "list" }), /not advertised/);
});

test("full-official subset preserves captured order and validates names", () => {
  const profile = makeSyntheticProfile();
  const value = new ClaudeToolRegistry(
    [makeTool("read"), makeTool("write")],
    profile,
    "full-official",
    ["Write", "Agent", "Read"],
  );
  assert.deepEqual(value.tools.map((tool) => tool.name), ["Agent", "Read", "Write"]);
  assert.equal(value.getPiName("Read"), "read");
  assert.throws(
    () => new ClaudeToolRegistry([], profile, "full-official", ["MissingTool"]),
    /not present in the Claude profile/,
  );
});

test("rejects unsupported built-in semantics before execution", () => {
  const value = registry();
  assert.throws(() => value.fromWireToolCall("Edit", { file_path: "a", old_string: "x", new_string: "y", replace_all: true }), /no file was modified/);
  assert.throws(() => value.fromWireToolCall("Bash", { command: "x", run_in_background: true }), /background execution/);
  assert.throws(() => value.fromWireToolCall("Read", { file_path: "a.pdf", pages: "1-2" }), /pages is not supported/);
  assert.throws(() => value.toWireToolCall("edit", { path: "a", edits: [] }), /exactly one/);
  assert.throws(() => value.getPiName("Agent"), /unadvertised tool/);
});
