# pi-anyrouter

An unofficial pi provider extension for AnyRouter's Claude Code and Codex Responses Lite routes.

The Claude adapter uses a **locally generated, versioned Claude Code profile** instead of a static header snapshot. The private profile contains the exact system/tool templates captured from the Claude Code installation on the same machine; those proprietary templates are never included in this repository or npm package.

> Current development status (2026-08-04): AnyRouter accepted the minimal mapped core set `Bash/Edit/Read/WebFetch/WebSearch/Write`; Fable Read/Bash call-result loops and an Opus pi-instruction sentinel all completed successfully. Adding `Agent` alone made the same envelope return 429, showing that AnyRouter validates allowed tool combinations rather than merely requiring a minimum count. `compatible-core` + `user-reminder` is now the default Claude mode in this development checkout; activation still requires a backed-up package/config switch.

## Scope

- Registers only provider `anyrouter` with private API ID `anyrouter-messages`.
- Reads dedicated config `~/.pi/agent/anyrouter.json`.
- Keeps normal pi `/model` selection.
- Leaves other pi providers and global request handling untouched.
- Preserves the v0.3.2 Codex Responses Lite request path.
- First profile/capture implementation targets Linux/WSL.

## Claude compatibility design

For Claude models the extension:

1. Loads a mode-`0600` local Claude Code profile.
2. Reproduces the captured version, beta/header set, system block order, message scaffold, request defaults, and official executable tool definitions.
3. Keeps the accepted official default system envelope unchanged and, in compatible mode, carries pi/project instructions in an official-style user reminder.
4. Maps executable core pi tools to captured Claude Code built-ins:
   - `read` ↔ `Read`
   - `bash` ↔ `Bash`
   - `edit` ↔ `Edit`
   - `write` ↔ `Write`
   - `web_search` ↔ `WebSearch`
   - `fetch_content` ↔ `WebFetch`
5. Advertises every other active pi tool using a deterministic `mcp__pi__<name>_<hash>` wire name, then maps returned calls back to the original tool.
6. Replays the same mapping for historical tool calls in multi-turn conversations.
7. Provides `compatible-core`, which uses the accepted official default envelope with the six safely mapped core tools.
8. Provides an opt-in `full-official` diagnostic profile that reproduces the captured default Claude Code headers, system blocks, startup messages, request defaults, and exact tool catalog ordering.

Unsupported built-in semantics fail safely rather than being silently changed. Examples include Claude `Edit.replace_all`, background Bash, and PDF page-specific Read calls.

## Install

Install the pinned Git prerelease through pi's package manager:

```bash
pi install git:github.com/JCloud77/pi-anyrouter@v0.4.0-alpha.2
```

Pi packages execute with full user permissions. Review the source before installation. This package does not include a Claude Code profile, API key, or generated request captures; each user must create those privately on their own machine.

For source development:

```bash
git clone https://github.com/JCloud77/pi-anyrouter.git
cd pi-anyrouter
npm install
```

Test the checkout without installing it:

```bash
PI_OFFLINE=1 pi --no-extensions --extension ./index.ts --list-models
```

## Configuration

Create `~/.pi/agent/anyrouter.json` with permissions `0600`:

```json
{
  "baseUrl": "https://anyrouter.top",
  "apiKey": "ANYROUTER_API_KEY_ENV_NAME",
  "claudeProfile": "~/.pi/agent/anyrouter-profiles/claude-code-active.json",
  "claudeToolProfile": "compatible-core",
  "claudePiInstructions": "user-reminder",
  "models": [
    {
      "id": "claude-fable-5",
      "name": "Claude Fable 5",
      "reasoning": true,
      "input": ["text", "image"],
      "contextWindow": 1000000,
      "maxTokens": 128000
    },
    {
      "id": "claude-opus-5",
      "name": "Claude Opus 5",
      "reasoning": true,
      "input": ["text", "image"],
      "contextWindow": 1000000,
      "maxTokens": 128000
    }
  ]
}
```

`apiKey` may be a literal key or the name of an environment variable. Shell-command values such as `"!command"` are intentionally rejected.

Supported overrides:

- `PI_ANYROUTER_CC_CONFIG`
- `PI_ANYROUTER_CC_BASE_URL`
- `PI_ANYROUTER_CC_API_KEY`
- `PI_ANYROUTER_CC_PROFILE`
- `PI_ANYROUTER_CC_TOOL_PROFILE` (`compatible-core` default, legacy `executable`, or diagnostic-only `full-official`)
- `PI_ANYROUTER_CC_OFFICIAL_TOOLS` (optional comma-separated subset for controlled minimum-set diagnosis)
- `PI_ANYROUTER_CC_PI_INSTRUCTIONS` (`user-reminder` default with compatible-core, or `omit`)
- `PI_ANYROUTER_CC_MAX_RETRIES` (runtime default: `10`; use `0` for controlled probes)
- `PI_ANYROUTER_CC_STREAM_MODE` (`force`, `auto`, or `off`; default: `force`)
- `PI_ANYROUTER_CC_DEBUG`
- `PI_ANYROUTER_CC_DEBUG_DIR`

Fetch/Undici remains the only enabled Claude runtime transport. A controlled same-body comparison returned the same 429 through Fetch and `curl --http2`, so curl is not implemented as a runtime fallback.

## Generate the private Claude Code profile

Requirements:

- A local `claude` executable.
- No AnyRouter access is required.
- The capture script uses a loopback HTTP server and a dummy credential.

Run:

```bash
cd /path/to/pi-anyrouter
npm run capture:profile
```

The script captures default tools, the core-tool subset, and an append-system marker. It writes:

- `~/.pi/agent/anyrouter-profiles/claude-code-<version>.json`
- `~/.pi/agent/anyrouter-profiles/claude-code-active.json`

The directory is mode `0700`; profiles are mode `0600`. Captured authorization, host/content-length, literal user prompt, cwd, and account/session/device IDs are removed or replaced with placeholders. A new stable local device ID is generated for the private profile.

Do not commit, publish, or share generated profiles. They contain locally captured proprietary Claude Code system/tool text.

## Offline verification

```bash
npm test
npm run typecheck
npm run pack:dry-run
```

Deep-compare two captured/generated requests:

```bash
npm run diagnose -- official-request.json candidate-request.json
```

The comparator normalizes credentials and dynamic IDs, then reports header/body keys, system block hashes, message/cache layout, tool description/schema hashes, metadata, thinking, context management, output config, and stream differences.

The package dry run must not include generated profiles, captures, debug dumps, tests, or secrets.

## Accepted compatible core mode

The smallest confirmed-safe request catalog is:

```text
Bash, Edit, Read, WebFetch, WebSearch, Write
```

Enable its official default envelope with:

```bash
PI_ANYROUTER_CC_TOOL_PROFILE=compatible-core
```

Every advertised tool has an existing pi argument/response mapping when the corresponding pi tools are active. Pi-only/MCP tools are omitted. Read and Bash call/result/final-answer loops have passed against AnyRouter.

The accepted official default system envelope cannot be replaced by pi's append-system variant. To carry pi/project instructions without altering that envelope, an opt-in mode prepends them to the ordinary user-prompt block as an official-style reminder:

```bash
PI_ANYROUTER_CC_TOOL_PROFILE=compatible-core \
PI_ANYROUTER_CC_PI_INSTRUCTIONS=user-reminder
```

This keeps the captured system/startup blocks unchanged, but the instructions have user-message rather than API system precedence. AnyRouter acceptance and instruction visibility were verified with a private sentinel test; the sentinel and request capture are not included in this repository.

## Full official envelope diagnostic

After an exact 24-tool catalog alone still returned 429, `full-official` was expanded to reproduce the complete locally captured default envelope: default headers, system identity, startup `role: system` message, request defaults, and all official tools. Pi's appended system prompt and MCP tools are intentionally omitted in this diagnostic mode:

```bash
PI_ANYROUTER_CC_TOOL_PROFILE=full-official \
PI_ANYROUTER_CC_PI_INSTRUCTIONS=omit \
PI_ANYROUTER_CC_MAX_RETRIES=0 \
pi --no-extensions \
  --extension ./index.ts \
  --model anyrouter/claude-opus-5 \
  --no-session --tools read,bash,edit,write \
  -p "Reply with exactly OK. Do not call tools."
```

This mode is for a text-only acceptance probe. It advertises captured official tools even when no pi handler exists. If Claude calls one of those diagnostic-only tools, the adapter fails closed before pi executes anything. Do not use this mode for normal agent sessions until every required tool has a safe handler.

For approved minimum-set experiments, select names without changing their captured ordering or schemas:

```bash
PI_ANYROUTER_CC_TOOL_PROFILE=full-official \
PI_ANYROUTER_CC_OFFICIAL_TOOLS=Agent,Bash,Edit,Read,Skill,TaskCreate,TaskGet,TaskList,TaskUpdate,WebFetch,WebSearch,Write \
# ...same pi command...
```

Unknown/duplicate/empty selections fail before any request.

## Privacy-safe environment diagnostic

Generate an offline report from the local configuration, private profile, runtime, and existing debug directory:

```bash
npm run diagnose:environment -- \
  --debug-dir /tmp/pi-anyrouter-debug \
  --output /tmp/pi-anyrouter-safe-report.json
```

The report is mode `0600` and intentionally excludes API keys, proxy URLs, hostnames, request bodies, prompts, raw device/session IDs, and system/tool template text. It contains only structural names, counts, lengths, hashes, booleans, statuses, and request IDs. Review it before sharing anyway. Never share the underlying profile or `*-request.json` files.

An explicitly gated live matrix can compare three paths using the same local key and selected private debug request:

1. official Claude Code with default tools and empty setting sources;
2. exact debug request replay through Fetch/Undici;
3. the same replay through curl HTTP/2, when supported.

```bash
PI_ANYROUTER_CC_ALLOW_LIVE=1 \
npm run diagnose:environment -- \
  --debug-dir /tmp/pi-anyrouter-debug \
  --live-matrix \
  --model claude-opus-5 \
  --output /tmp/pi-anyrouter-live-safe-report.json
```

The live matrix makes three real requests (two when curl lacks HTTP/2). Fetch/curl replays are zero-retry; the official Claude CLI controls its own internal retry behavior. Without `PI_ANYROUTER_CC_ALLOW_LIVE=1`, live mode refuses to run.

## Controlled live probes

Live probes are intentionally double-gated and must be run only after explicit approval for that exact batch:

```bash
PI_ANYROUTER_CC_ALLOW_LIVE=1 \
PI_ANYROUTER_CC_MAX_RETRIES=0 \
npm run probe -- --live --request candidate-request.json
```

Without both `--live` and `PI_ANYROUTER_CC_ALLOW_LIVE=1`, the probe refuses to send anything. It prints only status, request ID, latency, structural request hash, response size, and a redacted/truncated error.

Recommended acceptance order:

1. Official Claude Code default/core/core+MCP control matrix.
2. Candidate Fetch request with the accepted body shape.
3. Text streaming for each configured Claude model.
4. Full `Read`, `Bash`, and one MCP-mapped tool call/result/final-answer loop.
5. Multi-turn replay, reasoning, cancellation, and sanitized error handling.

## Debugging and privacy

Runtime debug dumps are disabled by default:

```bash
PI_ANYROUTER_CC_DEBUG=1 \
PI_ANYROUTER_CC_DEBUG_DIR=/tmp/anyrouter-private-debug \
pi --model anyrouter/claude-fable-5
```

Authorization headers are redacted and newly created files use mode `0600`, but request bodies can still contain user prompts, images, tool schemas, paths, and tool results. Treat the entire debug directory as private and delete it when no longer needed.

The profile loader fails before a Claude request when:

- the profile is missing;
- permissions allow group/other access;
- version, billing attribution, user-agent, or structural hashes disagree;
- credential-like fields are present;
- required core tools/placeholders are missing.

Codex models do not require a Claude profile.

## Activation and rollback

After approved acceptance:

1. Back up `~/.pi/agent/settings.json` and `~/.pi/agent/anyrouter.json`.
2. Install the pinned Git package with `pi install git:github.com/JCloud77/pi-anyrouter@v0.4.0-alpha.2`.
3. Add `claudeProfile` to `anyrouter.json`.
4. Run `/reload` and verify `/model`.

Rollback is immediate: restore both backups, reload pi, and the original managed v0.3.2 checkout is active again.

## Upstream attribution

This repository is a fork of [xifan2333/pi-anyrouter](https://github.com/xifan2333/pi-anyrouter), which is based on [phy-zhangzl/pi-anyrouter-cc](https://github.com/phy-zhangzl/pi-anyrouter-cc) by zhenliangzhang. The original MIT copyright and permission notices are preserved unchanged in [LICENSE](LICENSE).

The profile-driven Claude compatibility layer and its tests are modifications in this fork. This is an unofficial community project and is not affiliated with Anthropic, OpenAI, or AnyRouter.

## License

Distributed under the MIT License. See [LICENSE](LICENSE).
