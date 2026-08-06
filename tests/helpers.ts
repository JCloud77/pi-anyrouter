import {
  PROFILE_CURRENT_DATE_PLACEHOLDER,
  PROFILE_CWD_PLACEHOLDER,
  PROFILE_HOME_PLACEHOLDER,
  PROFILE_MODEL_PLACEHOLDER,
  PROFILE_SCHEMA_VERSION,
  PROFILE_SYSTEM_PROMPT_PLACEHOLDER,
  PROFILE_USER_PROMPT_PLACEHOLDER,
  structuralHash,
  validateClaudeProfile,
  type ClaudeCodeProfile,
} from "../src/claude-profile.ts";

function tool(name: string, properties: Record<string, any>, required: string[]) {
  return {
    name,
    description: `Synthetic ${name} tool fixture`,
    input_schema: { type: "object", properties, required, additionalProperties: false },
  };
}

export function makeSyntheticProfile(): ClaudeCodeProfile {
  const toolCatalog = {
    Agent: tool("Agent", { prompt: { type: "string" } }, ["prompt"]),
    Bash: tool("Bash", { command: { type: "string" }, timeout: { type: "number" }, run_in_background: { type: "boolean" }, dangerouslyDisableSandbox: { type: "boolean" } }, ["command"]),
    Edit: tool("Edit", { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean", default: false } }, ["file_path", "old_string", "new_string"]),
    Read: tool("Read", { file_path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" }, pages: { type: "string" } }, ["file_path"]),
    TaskCreate: tool("TaskCreate", { subject: { type: "string" } }, ["subject"]),
    WebFetch: tool("WebFetch", { url: { type: "string" }, prompt: { type: "string" } }, ["url", "prompt"]),
    WebSearch: tool("WebSearch", { query: { type: "string" }, allowed_domains: { type: "array" }, blocked_domains: { type: "array" } }, ["query"]),
    Write: tool("Write", { file_path: { type: "string" }, content: { type: "string" } }, ["file_path", "content"]),
  };
  const systemTemplate = [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.220.test; cc_entrypoint=sdk-cli;" },
    { type: "text", text: "Synthetic SDK identity", cache_control: { type: "ephemeral" } },
    { type: "text", text: `Synthetic base for ${PROFILE_MODEL_PLACEHOLDER} in ${PROFILE_CWD_PLACEHOLDER} (${PROFILE_HOME_PLACEHOLDER})\n${PROFILE_SYSTEM_PROMPT_PLACEHOLDER}`, cache_control: { type: "ephemeral" } },
  ];
  const messageScaffold = [{
    role: "user",
    content: [
      { type: "text", text: `Today's date is ${PROFILE_CURRENT_DATE_PLACEHOLDER}.` },
      { type: "text", text: PROFILE_USER_PROMPT_PLACEHOLDER },
    ],
  }];
  const bodyDefaults = {
    max_tokens: 64_000,
    thinking: { type: "adaptive", display: "omitted" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    output_config: { effort: "high" },
    stream: true,
  };
  const defaultHeaders = {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": "claude-cli/2.1.220 (external, sdk-cli)",
    "anthropic-beta": "claude-code-20250219,context-1m-2025-08-07",
    "anthropic-version": "2023-06-01",
    "x-stainless-retry-count": "0",
    "x-stainless-timeout": "120",
  };
  const defaultBodyDefaults = structuredClone(bodyDefaults);
  const defaultSystemTemplate = [
    { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.220.test; cc_entrypoint=sdk-cli;" },
    { type: "text", text: "Synthetic default identity", cache_control: { type: "ephemeral" } },
    { type: "text", text: `Synthetic default for ${PROFILE_MODEL_PLACEHOLDER} in ${PROFILE_CWD_PLACEHOLDER}`, cache_control: { type: "ephemeral" } },
  ];
  const defaultMessageScaffold = [
    ...structuredClone(messageScaffold),
    { role: "system", content: [{ type: "text", text: "Synthetic agent types", cache_control: { type: "ephemeral" } }] },
  ];
  const profile: ClaudeCodeProfile = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    capturedAt: "2026-08-03T00:00:00.000Z",
    claudeCode: { version: "2.1.220", billingVersion: "2.1.220.test", executable: "claude" },
    request: {
      method: "POST",
      urlPath: "/v1/messages?beta=true",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "claude-cli/2.1.220 (external, sdk-cli)",
        "anthropic-beta": "claude-code-20250219,context-1m-2025-08-07",
        "anthropic-version": "2023-06-01",
        "x-stainless-retry-count": "0",
      },
      bodyDefaults,
      systemTemplate,
      messageScaffold,
      defaultHeaders,
      defaultBodyDefaults,
      defaultSystemTemplate,
      defaultMessageScaffold,
      toolCatalog,
      defaultToolNames: ["Agent", "Bash", "Edit", "Read", "TaskCreate", "WebFetch", "WebSearch", "Write"],
      coreToolNames: ["Bash", "Edit", "Read", "WebFetch", "WebSearch", "Write"],
    },
    local: { deviceId: "a".repeat(64) },
    hashes: {
      system: structuralHash(systemTemplate),
      messages: structuralHash(messageScaffold),
      tools: structuralHash(toolCatalog),
      requestDefaults: structuralHash(bodyDefaults),
      defaultHeaders: structuralHash(defaultHeaders),
      defaultSystem: structuralHash(defaultSystemTemplate),
      defaultMessages: structuralHash(defaultMessageScaffold),
      defaultRequestDefaults: structuralHash(defaultBodyDefaults),
    },
  };
  return validateClaudeProfile(profile);
}

export function makeTool(name: string, properties: Record<string, any> = {}, required: string[] = []) {
  return {
    name,
    description: `Pi ${name} fixture`,
    parameters: { type: "object", properties, required, additionalProperties: false },
  } as any;
}
