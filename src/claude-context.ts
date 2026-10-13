import type { Context, Message, TextContent, Tool } from "@earendil-works/pi-ai";

// Structural types keep this adapter loadable with older Pi releases that do not
// export TranscriptContext or the transcript helpers yet.
export type PiSystemMessage = {
  role: "system";
  content: string | TextContent[];
  sections?: Record<string, string | null>;
  toolsAdded?: Tool[];
  toolsRemoved?: { name: string }[];
  timestamp?: number;
};
export type ClaudeContext = Omit<Context, "messages"> & {
  messages: (Message | PiSystemMessage)[];
};

/**
 * Match Pi's normalizeContext + getCurrentTools/getCurrentSystemPrompt semantics.
 * Legacy top-level fields form an initial checkpoint; transcript system messages
 * then apply ordered tool and prompt-section deltas. Never infer availability
 * from historical calls, the captured official catalog, or user/assistant text.
 * Keep this Claude-local so the legacy Codex route is unaffected.
 */
export function resolveClaudeContext(context: ClaudeContext): Context {
  const tools = new Map<string, Tool>();
  for (const tool of context.tools ?? []) tools.set(tool.name, tool);
  const content: string[] = context.systemPrompt ? [context.systemPrompt] : [];
  const sections = new Map<string, string>();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    const text = typeof message.content === "string"
      ? message.content
      : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    if (text.length > 0) content.push(text);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  return {
    systemPrompt: [content.join("\n\n"), ...sections.values()].filter((part) => part.length > 0).join("\n\n"),
    tools: [...tools.values()],
    // The captured Claude envelope supplies its own system blocks/scaffold.
    messages: context.messages.filter((message): message is Message => message.role !== "system"),
  };
}
