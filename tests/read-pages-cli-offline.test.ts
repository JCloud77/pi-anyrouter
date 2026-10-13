import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeSyntheticProfile } from "./helpers.ts";

// Only loopback traffic, dummy credentials, a synthetic profile, and a temporary
// fixture. The negative case must fail before Pi starts any tool execution.
const piBin = process.env.PI_ANYROUTER_TEST_PI_BIN;
test("Pi CLI: CC Read with empty pages executes and replays; real page selection never executes", {
  skip: !piBin, timeout: 90_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-read-pages-test-"));
  const fixture = join(root, "cases.json");
  const requests: any[] = [];
  const failures: unknown[] = [];
  let pages = "";
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      assert.equal(req.url, "/v1/messages?beta=true");
      assert.equal(req.headers.authorization, "Bearer dummy-offline-key");
      assert.equal(body.model, "gpt-6-astra-cc-format");
      assert.deepEqual(body.tools.map((tool: any) => tool.name), ["Read"]);
      assert.ok(requests.length <= (pages === "" ? 2 : 1), "unexpected extra request/retry");
      const finishing = requests.length === 2;
      if (finishing) {
        const blocks = body.messages.flatMap((message: any) => message.content);
        const call = blocks.find((block: any) => block.type === "tool_use" && block.id === "toolu_offline_read");
        const result = blocks.find((block: any) => block.type === "tool_result" && block.tool_use_id === "toolu_offline_read");
        assert.deepEqual(call?.input, { file_path: fixture, offset: 0, limit: 300 });
        assert.ok(result && !result.is_error, "read should complete successfully");
        assert.match(JSON.stringify(result.content), /READ_PAGES_FIXTURE_OK/);
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (data: any) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
      event({ type: "message_start", message: { id: "msg_read_pages", type: "message", role: "assistant",
        model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      event({ type: "content_block_start", index: 0, content_block: finishing
        ? { type: "text", text: "" }
        : { type: "tool_use", id: "toolu_offline_read", name: "Read", input: {} } });
      if (finishing) {
        event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "READ_PAGES_LOOP_OK" } });
      } else {
        const args = JSON.stringify({ file_path: fixture, limit: 300, offset: 0, pages });
        // Exercise the incremental SSE argument parser, including the empty field.
        const split = args.indexOf('"pages"') + 4;
        for (const part of [args.slice(0, split), args.slice(split)]) {
          event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: part } });
        }
      }
      event({ type: "content_block_stop", index: 0 });
      event({ type: "message_delta", delta: { stop_reason: finishing ? "end_turn" : "tool_use" }, usage: { output_tokens: 5 } });
      event({ type: "message_stop" });
      res.end();
    } catch (error) {
      failures.push(error);
      res.writeHead(500).end("Offline test assertion failed");
    }
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    await writeFile(fixture, '{"sentinel":"READ_PAGES_FIXTURE_OK"}\n');
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
    const profilePath = join(root, "synthetic-profile.json");
    await writeFile(profilePath, JSON.stringify(makeSyntheticProfile()), { mode: 0o600 });
    const configPath = join(root, "anyrouter.json");
    await writeFile(configPath, JSON.stringify({
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      apiKey: "dummy-offline-key", claudeProfile: profilePath,
      claudeToolProfile: "compatible-core", claudePiInstructions: "user-reminder",
      models: [{ id: "gpt-6-astra-cc-format", api: "anthropic-messages", maxTokens: 2048 }],
    }), { mode: 0o600 });
    const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
    const run = () => new Promise<{ error: any; stdout: string; stderr: string }>((resolve) => {
      execFile(piBin!, [
        "--offline", "--no-extensions", "--extension", extension, "--no-skills", "--no-prompt-templates",
        "--no-themes", "--no-context-files", "--no-approve", "--no-session", "--mode", "json",
        "--model", "anyrouter/gpt-6-astra-cc-format", "--thinking", "off", "--tools", "read",
        "Read the offline fixture",
      ], { cwd: root, timeout: 35_000, maxBuffer: 2_000_000, env: {
        PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
        PI_ANYROUTER_CC_CONFIG: configPath, PI_ANYROUTER_CC_MAX_RETRIES: "0",
        PI_ANYROUTER_CC_STREAM_MODE: "force", HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost",
      } }, (error, stdout, stderr) => resolve({ error, stdout, stderr })).stdin?.end();
    });
    const success = await run();
    assert.deepEqual(failures, []);
    assert.equal(success.error, null, success.stderr || success.stdout);
    assert.equal(requests.length, 2);
    assert.match(success.stdout, /READ_PAGES_LOOP_OK/);
    const events = success.stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
    const start = events.find((event) => event.type === "tool_execution_start");
    assert.equal(start?.toolName, "read");
    assert.deepEqual(start?.args, { path: fixture, offset: 0, limit: 300 });
    assert.ok(events.some((event) => event.type === "tool_execution_end" && !event.isError));

    requests.length = 0;
    pages = "1-2";
    const rejected = await run();
    assert.deepEqual(failures, []);
    assert.equal(requests.length, 1);
    assert.match(rejected.stdout + rejected.stderr, /Claude Read pages is not supported by pi read/);
    assert.doesNotMatch(rejected.stdout, /tool_execution_start|tool_execution_end/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
