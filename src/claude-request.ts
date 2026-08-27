import { homedir } from "node:os";
import type {
  Api,
  Context,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  PROFILE_CURRENT_DATE_PLACEHOLDER,
  PROFILE_CWD_PLACEHOLDER,
  PROFILE_CWD_SLUG_PLACEHOLDER,
  PROFILE_HOME_PLACEHOLDER,
  PROFILE_MODEL_PLACEHOLDER,
  PROFILE_SYSTEM_PROMPT_PLACEHOLDER,
  PROFILE_USER_PROMPT_PLACEHOLDER,
  type ClaudeCodeProfile,
  type JsonObject,
} from "./claude-profile.ts";
import { ClaudeToolRegistry, type ClaudeToolProfile } from "./claude-tools.ts";

export type PiInstructionMode = "omit" | "user-reminder";

export function sanitizeText(text: string) {
  return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function mapReasoningEffort(level?: SimpleStreamOptions["reasoning"]) {
  switch (level) {
    case "minimal":
    case "low": return "low";
    case "medium": return "medium";
    case "high": return "high";
    case "xhigh": return "xhigh";
    default: return undefined;
  }
}

function currentDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function renderString(value: string, replacements: Record<string, string>) {
  let rendered = value;
  for (const [placeholder, replacement] of Object.entries(replacements)) rendered = rendered.split(placeholder).join(replacement);
  return rendered;
}

function renderValue(value: any, replacements: Record<string, string>): any {
  if (Array.isArray(value)) return value.map((item) => renderValue(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderValue(item, replacements)]));
  }
  return typeof value === "string" ? renderString(value, replacements) : value;
}

function runtimeReplacements(modelId: string, systemPrompt: string) {
  return {
    [PROFILE_CURRENT_DATE_PLACEHOLDER]: currentDate(),
    [PROFILE_CWD_PLACEHOLDER]: process.cwd(),
    [PROFILE_CWD_SLUG_PLACEHOLDER]: process.cwd().replaceAll("/", "-"),
    [PROFILE_HOME_PLACEHOLDER]: homedir(),
    [PROFILE_MODEL_PLACEHOLDER]: modelId,
    [PROFILE_SYSTEM_PROMPT_PLACEHOLDER]: sanitizeText(systemPrompt),
  };
}

function convertContentBlocks(content: (TextContent | ImageContent)[]) {
  const hasImages = content.some((block) => block.type === "image");
  if (!hasImages) return sanitizeText(content.map((block) => (block as TextContent).text).join("\n"));
  const blocks: JsonObject[] = content.map((block) => block.type === "text"
    ? { type: "text", text: sanitizeText(block.text) }
    : { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
  if (!blocks.some((block) => block.type === "text")) blocks.unshift({ type: "text", text: "(see attached image)" });
  return blocks;
}

function userContentBlocks(message: Extract<Message, { role: "user" }>) {
  if (typeof message.content === "string") {
    const text = sanitizeText(message.content);
    return text.trim() ? [{ type: "text", text }] : [];
  }
  return message.content.map((item) => item.type === "text"
    ? { type: "text", text: sanitizeText(item.text) }
    : { type: "image", source: { type: "base64", media_type: item.mimeType, data: item.data } });
}

function transcriptJson(value: any) {
  try {
    return sanitizeText(JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    return "[arguments could not be serialized]";
  }
}

function compatibilityReason(error: unknown) {
  return sanitizeText(error instanceof Error ? error.message : String(error));
}

function historicalToolCallBlock(block: any, reason: string): JsonObject {
  return {
    type: "text",
    text: [
      "[Historical pi tool call replayed as text; it has already occurred and must not be executed again.]",
      `Tool: ${sanitizeText(String(block.name || "unknown"))}`,
      `Arguments:\n${transcriptJson(block.arguments)}`,
      `Compatibility note: ${reason}`,
    ].join("\n"),
  };
}

function historicalToolResultBlocks(toolMessage: ToolResultMessage, toolName: string): JsonObject[] {
  const prefix = [
    "[Historical pi tool result replayed as text; it is context only.]",
    `Tool: ${sanitizeText(toolName)}`,
    `Status: ${toolMessage.isError ? "error" : "success"}`,
  ].join("\n");
  const converted = convertContentBlocks(toolMessage.content);
  if (typeof converted === "string") {
    return [{ type: "text", text: converted ? `${prefix}\nResult:\n${converted}` : prefix }];
  }
  return [{ type: "text", text: prefix }, ...converted];
}

const RETRY_FEEDBACK_PATTERN = /^⏳ .+ — retrying \(\d+\/\d+\)…$/u;

function isAdapterGeneratedAssistantText(message: Extract<Message, { role: "assistant" }>, text: string) {
  const trimmed = text.trim();
  if (RETRY_FEEDBACK_PATTERN.test(trimmed)) return true;
  const errorMessage = typeof (message as any).errorMessage === "string" ? (message as any).errorMessage.trim() : "";
  return Boolean(errorMessage && trimmed === errorMessage && trimmed.startsWith("[anyrouter]"));
}

function appendConvertedMessage(params: JsonObject[], role: "user" | "assistant", content: JsonObject[]) {
  if (!content.length) return;
  const previous = params.at(-1);
  if (role === "user" && previous?.role === "user" && Array.isArray(previous.content)) {
    previous.content.push(...content);
    return;
  }
  params.push({ role, content });
}

export function convertClaudeMessages(messages: Message[], registry: ClaudeToolRegistry) {
  const params: JsonObject[] = [];
  const resultIds = new Set(messages
    .filter((message): message is ToolResultMessage => message.role === "toolResult")
    .map((message) => message.toolCallId));
  const wireToolCallIds = new Set<string>();
  const transcriptToolCalls = new Map<string, { name: string; reason: string }>();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "user") {
      const content = userContentBlocks(message as Extract<Message, { role: "user" }>);
      appendConvertedMessage(params, "user", content);
      continue;
    }

    if (message.role === "assistant") {
      const content: JsonObject[] = [];
      const assistantMessage = message as Extract<Message, { role: "assistant" }>;
      const isAnyRouterHistory = message.provider === "anyrouter";
      let emittedNonThinkingBlock = false;
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) {
          if (isAnyRouterHistory && isAdapterGeneratedAssistantText(assistantMessage, block.text)) continue;
          content.push({ type: "text", text: sanitizeText(block.text) });
          emittedNonThinkingBlock = true;
        } else if (block.type === "thinking" && block.thinking.trim()) {
          const thinking = block as ThinkingContent;
          // Reasoning signatures are provider-specific cryptographic payloads. Replaying
          // Codex or another provider's signature as Claude thinking makes the request invalid.
          // Claude thinking must also remain before ordinary content; omit a late block
          // rather than replaying a malformed assistant message.
          if (isAnyRouterHistory && thinking.thinkingSignature && !emittedNonThinkingBlock) {
            content.push({ type: "thinking", thinking: sanitizeText(thinking.thinking), signature: thinking.thinkingSignature });
          }
        } else if (block.type === "toolCall") {
          try {
            if (!isAnyRouterHistory) {
              throw new Error(`tool protocol belongs to provider ${message.provider || "unknown"}, not AnyRouter Claude`);
            }
            if (!resultIds.has(block.id)) throw new Error("historical tool call has no matching result");
            if (!String(block.id).startsWith("toolu_")) throw new Error("historical tool call id is not a Claude toolu_ id");
            const wire = registry.toWireToolCall(block.name, block.arguments);
            wireToolCallIds.add(block.id);
            content.push({ type: "tool_use", id: block.id, name: wire.name, input: wire.input });
          } catch (error) {
            const reason = compatibilityReason(error);
            transcriptToolCalls.set(block.id, { name: block.name, reason });
            content.push(historicalToolCallBlock(block, reason));
          }
          emittedNonThinkingBlock = true;
        }
      }
      appendConvertedMessage(params, "assistant", content);
      continue;
    }

    if (message.role === "toolResult") {
      const toolResults: JsonObject[] = [];
      const transcriptResults: JsonObject[] = [];
      const addToolResult = (toolMessage: ToolResultMessage) => {
        if (wireToolCallIds.has(toolMessage.toolCallId)) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolMessage.toolCallId,
            content: convertContentBlocks(toolMessage.content),
            is_error: toolMessage.isError,
          });
          return;
        }
        const transcript = transcriptToolCalls.get(toolMessage.toolCallId);
        const toolName = transcript?.name || toolMessage.toolName || "unknown";
        transcriptResults.push(...historicalToolResultBlocks(toolMessage, toolName));
      };
      addToolResult(message as ToolResultMessage);
      let next = index + 1;
      while (next < messages.length && messages[next].role === "toolResult") {
        addToolResult(messages[next] as ToolResultMessage);
        next++;
      }
      index = next - 1;
      appendConvertedMessage(params, "user", [...toolResults, ...transcriptResults]);
    }
  }
  return params;
}

function injectMessageScaffold(
  messages: JsonObject[],
  messageScaffold: JsonObject[],
  replacements: Record<string, string>,
  userReminder?: string,
) {
  const firstUserIndex = messages.findIndex((message) => message.role === "user");
  if (firstUserIndex < 0) throw new Error("Claude request requires at least one user message");
  const firstUser = messages[firstUserIndex];
  const originalContent = clone(Array.isArray(firstUser.content) ? firstUser.content : [{ type: "text", text: String(firstUser.content || "") }]);
  if (userReminder) {
    const firstText = originalContent.find((block: JsonObject) => block.type === "text");
    if (firstText) firstText.text = `${userReminder}${String(firstText.text || "")}`;
    else originalContent.unshift({ type: "text", text: userReminder.trimEnd() });
  }
  const marker = `__PI_USER_BLOCK_${Date.now()}__`;
  const scaffold = renderValue(messageScaffold, {
    ...replacements,
    [PROFILE_USER_PROMPT_PLACEHOLDER]: marker,
  }) as JsonObject[];
  let replaced = false;
  for (const message of scaffold) {
    if (!Array.isArray(message.content)) continue;
    const expanded: JsonObject[] = [];
    for (const block of message.content) {
      if (block?.type === "text" && block.text === marker) {
        expanded.push(...clone(originalContent));
        replaced = true;
      } else {
        expanded.push(block);
      }
    }
    message.content = expanded;
  }
  if (!replaced) throw new Error("Claude profile message scaffold did not expose the user prompt placeholder as a text block");
  return [...messages.slice(0, firstUserIndex), ...scaffold, ...messages.slice(firstUserIndex + 1)];
}

export function createClaudeHeaders(
  profile: ClaudeCodeProfile,
  apiKey: string,
  sessionId: string,
  toolProfile: ClaudeToolProfile = "executable",
): Record<string, string> {
  const headerTemplate = toolProfile === "executable" ? profile.request.headers : profile.request.defaultHeaders;
  return {
    ...clone(headerTemplate),
    authorization: `Bearer ${apiKey}`,
    "x-claude-code-session-id": sessionId,
    "x-stainless-retry-count": "0",
  };
}

export function createClaudeMetadata(profile: ClaudeCodeProfile, sessionId: string) {
  return {
    user_id: JSON.stringify({
      device_id: profile.local.deviceId,
      account_uuid: "",
      session_id: sessionId,
    }),
  };
}

export function buildClaudeRequest(
  profile: ClaudeCodeProfile,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  sessionId: string,
  toolProfile: ClaudeToolProfile = "executable",
  selectedOfficialToolNames?: string[],
  piInstructionMode: PiInstructionMode = "omit",
) {
  const registry = new ClaudeToolRegistry(context.tools || [], profile, toolProfile, selectedOfficialToolNames);
  const systemPrompt = context.systemPrompt || "You are an expert coding assistant operating inside pi.";
  const replacements = runtimeReplacements(model.id, systemPrompt);
  const systemTemplate = toolProfile === "executable"
    ? profile.request.systemTemplate
    : profile.request.defaultSystemTemplate;
  const messageScaffold = toolProfile === "executable"
    ? profile.request.messageScaffold
    : profile.request.defaultMessageScaffold;
  const defaultBody = toolProfile === "executable"
    ? profile.request.bodyDefaults
    : profile.request.defaultBodyDefaults;
  const system = renderValue(systemTemplate, replacements);
  const convertedMessages = convertClaudeMessages(context.messages, registry);
  const userReminder = toolProfile === "compatible-core" && piInstructionMode === "user-reminder"
    ? `<system-reminder>\nThe following instructions describe the pi host environment and must be followed for this session:\n${sanitizeText(systemPrompt)}\n</system-reminder>\n\n`
    : undefined;
  const messages = injectMessageScaffold(convertedMessages, messageScaffold, replacements, userReminder);
  const defaults = clone(defaultBody);
  const capturedMaxTokens = Number(defaults.max_tokens || 64_000);
  const requestedMaxTokens = Number(options?.maxTokens || model.maxTokens || capturedMaxTokens);
  defaults.max_tokens = Math.min(capturedMaxTokens, requestedMaxTokens);
  defaults.stream = true;
  const effort = mapReasoningEffort(options?.reasoning);
  if (effort) defaults.output_config = { ...(defaults.output_config || {}), effort };

  const body: JsonObject = {
    model: model.id,
    messages,
    system,
    ...(registry.tools.length ? { tools: registry.tools } : {}),
    metadata: createClaudeMetadata(profile, sessionId),
    ...defaults,
  };
  return { body, registry };
}
