import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { __testing } from "../index.ts";
import { makeSyntheticProfile } from "./helpers.ts";

test("explicit CC Messages routing wins over the gpt Codex prefix", () => {
  assert.equal(__testing.isCodexModel("gpt-6-astra", undefined), true);
  assert.equal(__testing.isCodexModel("gpt-6-astra-cc-format", "anthropic-messages"), false);
  assert.equal(__testing.isCodexModel("gpt-6-astra-cc-format", "openai-codex-responses"), true);
  assert.throws(() => __testing.isCodexModel("gpt-6-astra-cc-format", "unknown-api"), /Unsupported AnyRouter model api/);
});

const piBin = process.env.PI_ANYROUTER_TEST_PI_BIN;
test("Pi CLI: cc-format sends an Anthropic Messages envelope, never Responses", {
  skip: !piBin, timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-astra-cc-messages-"));
  const requests: any[] = [];
  const errors: unknown[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      requests.push(body);
      assert.equal(req.url, "/v1/messages?beta=true");
      assert.equal(req.headers.authorization, "Bearer dummy-offline-key");
      assert.equal(body.model, "gpt-6-astra-cc-format");
      assert.ok(Array.isArray(body.messages));
      assert.ok(Array.isArray(body.system));
      assert.equal(body.input, undefined);
      assert.equal(body.client_metadata, undefined);
      assert.deepEqual(body.tools?.map((tool: any) => tool.name) ?? [], ["Bash"]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const payload of [
        { type: "message_start", message: { id: "msg_offline_cc", type: "message", role: "assistant",
          model: body.model, content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "CC_MESSAGES_OK" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ]) res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
      res.end();
    } catch (error) {
      errors.push(error);
      res.writeHead(500).end("Offline mock rejected request");
    }
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
    const profile = join(root, "synthetic-profile.json");
    await writeFile(profile, JSON.stringify(makeSyntheticProfile()), { mode: 0o600 });
    const config = join(root, "anyrouter.json");
    await writeFile(config, JSON.stringify({ baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
      apiKey: "dummy-offline-key", claudeProfile: profile, claudeToolProfile: "compatible-core",
      claudePiInstructions: "user-reminder", models: [{ id: "gpt-6-astra-cc-format",
        api: "anthropic-messages", maxTokens: 2048 }],
    }), { mode: 0o600 });
    const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
    const result = await new Promise<{ error: any; stdout: string; stderr: string }>((resolve) => {
      execFile(piBin!, ["--offline", "--no-extensions", "--extension", extension, "--no-skills",
        "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
        "--no-session", "--mode", "json", "--model", "anyrouter/gpt-6-astra-cc-format",
        "--thinking", "off", "--tools", "bash", "Reply exactly CC_MESSAGES_OK",
      ], { cwd: root, timeout: 30_000, maxBuffer: 2_000_000, env: {
        PATH: process.env.PATH, HOME: root, PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
        PI_ANYROUTER_CC_CONFIG: config, PI_ANYROUTER_CC_MAX_RETRIES: "0",
        PI_ANYROUTER_CC_STREAM_MODE: "force", HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost",
      } }, (error, stdout, stderr) => resolve({ error, stdout, stderr })).stdin?.end();
    });
    assert.deepEqual(errors, []);
    assert.equal(result.error, null, result.stderr || result.stdout);
    assert.equal(requests.length, 1);
    assert.match(result.stdout, /CC_MESSAGES_OK/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
