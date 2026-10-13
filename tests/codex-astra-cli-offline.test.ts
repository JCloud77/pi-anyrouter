import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getAstraCodexVersion } from "../src/codex-client.ts";

const piBin = process.env.PI_ANYROUTER_TEST_PI_BIN;

test("Pi CLI -> Astra Codex SSE -> Bash -> result -> final; disabled tools fail closed", {
  skip: !piBin, timeout: 90_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-astra-offline-"));
  const requests: any[] = [];
  const failures: unknown[] = [];
  let disabled = false;
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      assert.equal(req.url, "/v1/responses");
      assert.equal(req.method, "POST");
      assert.equal(req.headers.authorization, "Bearer dummy-offline-key");
      assert.ok(req.headers["user-agent"]?.startsWith(`codex_exec/${getAstraCodexVersion()} (`));
      assert.equal(body.model, "gpt-6-astra");
      assert.equal(body.max_output_tokens, undefined);
      const metadata = body.client_metadata;
      const turnMetadata = JSON.parse(String(req.headers["x-codex-turn-metadata"]));
      assert.equal(req.headers["session-id"], metadata.session_id);
      assert.equal(metadata.session_id, metadata.thread_id);
      assert.equal(metadata.session_id, turnMetadata.session_id);
      assert.equal(metadata.turn_id, turnMetadata.turn_id);
      assert.equal(metadata.root_turn_id, turnMetadata.root_turn_id);
      assert.equal(body.prompt_cache_key, metadata.session_id);
      assert.ok(body.input.some((item: any) => item.role === "developer"
        && JSON.stringify(item.content).includes("PROJECT_SENTINEL_OFFLINE")));
      assert.deepEqual(body.tools?.map((tool: any) => tool.name) ?? [], disabled ? [] : ["bash"]);
      assert.ok(requests.length <= (disabled ? 1 : 2), "unexpected retry");
      const finishing = !disabled && requests.length === 2;
      if (finishing) {
        assert.ok(body.input.some((item: any) => item.type === "function_call" && item.name === "bash"));
        assert.ok(body.input.some((item: any) => item.type === "function_call_output"
          && item.call_id === "call_offline" && String(item.output).includes("ASTRA_BASH_OK")));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (payload: any) => res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
      emit({ type: "response.created", response: { id: "resp_offline" } });
      if (finishing) {
        emit({ type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant", id: "msg_offline" } });
        emit({ type: "response.output_text.delta", output_index: 0, delta: "ASTRA_LOOP_OK" });
        emit({ type: "response.output_item.done", output_index: 0,
          item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ASTRA_LOOP_OK" }] } });
      } else {
        const item = { type: "function_call", id: "fc_offline", call_id: "call_offline", name: "bash",
          arguments: JSON.stringify({ command: "printf ASTRA_BASH_OK" }) };
        emit({ type: "response.output_item.added", output_index: 0, item });
        emit({ type: "response.output_item.done", output_index: 0, item });
      }
      emit({ type: "response.completed", response: { id: "resp_offline", usage: {
        input_tokens: 12, output_tokens: 4, total_tokens: 16,
      } } });
      res.end();
    } catch (error) {
      failures.push(error);
      res.writeHead(500).end("Offline assertion failed");
    }
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
    const config = join(root, "config.json");
    await writeFile(config, JSON.stringify({ baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
      apiKey: "dummy-offline-key", models: [{ id: "gpt-6-astra", name: "Offline Astra", maxTokens: 2048 }],
    }), { mode: 0o600 });
    const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
    const run = (args: string[]) => new Promise<{ error: any; stdout: string; stderr: string }>((resolve) => {
      execFile(piBin!, ["--offline", "--no-extensions", "--extension", extension, "--no-skills",
        "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--no-session",
        "--mode", "json", "--model", "anyrouter/gpt-6-astra", "--thinking", "low",
        "--system-prompt", "PROJECT_SENTINEL_OFFLINE", ...args, "Run the Astra offline test",
      ], { cwd: root, timeout: 35_000, maxBuffer: 2_000_000, env: {
        PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_ANYROUTER_CC_CONFIG: config,
        PI_ANYROUTER_CC_MAX_RETRIES: "0",
        HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost",
      } }, (error, stdout, stderr) => resolve({ error, stdout, stderr })).stdin?.end();
    });
    const success = await run(["--tools", "bash"]);
    assert.deepEqual(failures, []);
    assert.equal(success.error, null, success.stderr || success.stdout);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].client_metadata.session_id, requests[1].client_metadata.session_id,
      "tool continuation must use one stable Pi session id");
    assert.notEqual(requests[0].client_metadata.turn_id, requests[1].client_metadata.turn_id);
    assert.equal(requests[0].client_metadata.root_turn_id, requests[0].client_metadata.turn_id);
    assert.equal(requests[1].client_metadata.root_turn_id, requests[0].client_metadata.root_turn_id);
    assert.match(success.stdout, /ASTRA_LOOP_OK/);
    assert.match(success.stdout, /tool_execution_end/);
    requests.length = 0;
    disabled = true;
    const reject = await run(["--no-tools"]);
    assert.deepEqual(failures, []);
    assert.equal(requests.length, 1);
    assert.match(reject.stdout + reject.stderr, /unadvertised tool bash/);
    assert.doesNotMatch(reject.stdout, /tool_execution_start|tool_execution_end/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
