import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { makeSyntheticProfile } from "./helpers.ts";

// Opt in with an installed Pi executable. Uses an isolated home, dummy key,
// synthetic (non-private) profile, loopback endpoint, and read-only printf.
const piBin = process.env.PI_ANYROUTER_TEST_PI_BIN;

test("real Pi CLI: normalized context -> Bash -> tool result -> answer, and inactive Bash rejection", {
  skip: !piBin, timeout: 90_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-anyrouter-cli-test-"));
  const requests: any[] = [];
  const failures: unknown[] = [];
  let disabled = false;
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      assert.equal(req.url, "/v1/messages?beta=true");
      assert.equal(req.headers.authorization, "Bearer dummy-offline-key");
      assert.equal(body.model, "claude-opus-5-5");
      assert.match(JSON.stringify(body.messages), /PROJECT_SENTINEL_OFFLINE/);
      assert.doesNotMatch(JSON.stringify(body.system), /PROJECT_SENTINEL_OFFLINE/);
      assert.deepEqual(body.tools?.map((tool: any) => tool.name) ?? [], disabled ? [] : ["Bash"]);
      assert.ok(requests.length <= (disabled ? 1 : 2), "unexpected extra request/retry");
      const finishing = !disabled && requests.length === 2;
      if (finishing) {
        const blocks = body.messages.flatMap((message: any) => message.content);
        assert.ok(blocks.some((block: any) => block.type === "tool_use" && block.name === "Bash"));
        assert.ok(blocks.some((block: any) => block.type === "tool_result"
          && block.tool_use_id === "toolu_offline_bash"
          && JSON.stringify(block.content).includes("ANYROUTER_BASH_OK") && !block.is_error));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (data: any) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
      event({ type: "message_start", message: { id: "msg_offline", type: "message", role: "assistant",
        model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      event({ type: "content_block_start", index: 0, content_block: finishing
        ? { type: "text", text: "" }
        : { type: "tool_use", id: "toolu_offline_bash", name: "Bash", input: {} } });
      event({ type: "content_block_delta", index: 0, delta: finishing
        ? { type: "text_delta", text: "OFFLINE_LOOP_OK" }
        : { type: "input_json_delta", partial_json: JSON.stringify({ command: "printf ANYROUTER_BASH_OK" }) } });
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
    const port = (server.address() as { port: number }).port;
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
    const profilePath = join(root, "synthetic-profile.json");
    await writeFile(profilePath, JSON.stringify(makeSyntheticProfile()), { mode: 0o600 });
    const configPath = join(root, "anyrouter.json");
    await writeFile(configPath, JSON.stringify({
      baseUrl: `http://127.0.0.1:${port}`, apiKey: "dummy-offline-key", claudeProfile: profilePath,
      claudeToolProfile: "compatible-core", claudePiInstructions: "user-reminder",
      models: [{ id: "claude-opus-5-5", name: "Offline test", contextWindow: 1000000, maxTokens: 2048 }],
    }), { mode: 0o600 });
    const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
    const run = (tools: string[]) => new Promise<{ error: any; stdout: string; stderr: string }>((resolve) => {
      execFile(piBin!, [
        "--offline", "--no-extensions", "--extension", extension, "--no-skills", "--no-prompt-templates",
        "--no-themes", "--no-context-files", "--no-approve", "--no-session", "--mode", "json",
        "--model", "anyrouter/claude-opus-5-5", "--thinking", "off",
        "--system-prompt", "PROJECT_SENTINEL_OFFLINE", ...tools, "Run the offline test",
      ], { cwd: root, timeout: 35_000, maxBuffer: 2_000_000,
        env: {
          PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir,
          PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
          PI_ANYROUTER_CC_CONFIG: configPath, PI_ANYROUTER_CC_MAX_RETRIES: "0", PI_ANYROUTER_CC_STREAM_MODE: "force",
        },
      }, (error, stdout, stderr) => resolve({ error, stdout, stderr })).stdin?.end();
    });
    const success = await run(["--tools", "bash"]);
    assert.deepEqual(failures, []);
    assert.equal(success.error, null, success.stderr || success.stdout);
    assert.equal(requests.length, 2);
    assert.match(success.stdout, /OFFLINE_LOOP_OK/);
    assert.match(success.stdout, /tool_execution_end/);
    assert.doesNotMatch(success.stdout, /diagnostic-only|no active pi handler/);

    requests.length = 0;
    disabled = true;
    const rejected = await run(["--no-tools"]);
    assert.deepEqual(failures, []);
    assert.equal(requests.length, 1);
    assert.match(rejected.stdout + rejected.stderr, /unadvertised tool Bash/);
    assert.doesNotMatch(rejected.stdout, /tool_execution_start|tool_execution_end/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
