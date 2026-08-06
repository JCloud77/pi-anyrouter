import { createHash } from "node:crypto";
import type { Tool } from "@earendil-works/pi-ai";
import type { ClaudeCodeProfile, JsonObject } from "./claude-profile.ts";

export type ClaudeToolProfile = "executable" | "compatible-core" | "full-official";

export type ToolBinding = {
  piName: string;
  wireName: string;
  kind: "builtin" | "mcp";
  wireTool: JsonObject;
  toWireArguments(argumentsValue: any): JsonObject;
  fromWireArguments(argumentsValue: any): JsonObject;
};

const CORE_WIRE_NAME_BY_PI_NAME: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  web_search: "WebSearch",
  fetch_content: "WebFetch",
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function objectArguments(value: any, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} arguments must be an object`);
  }
  return value;
}

function copyDefined(source: JsonObject, keys: string[]) {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

function toWireCore(wireName: string, value: any): JsonObject {
  const args = objectArguments(value, wireName);
  switch (wireName) {
    case "Read": {
      if (!args.path) throw new Error("Read requires pi argument path");
      return { file_path: args.path, ...copyDefined(args, ["offset", "limit"]) };
    }
    case "Bash": {
      if (!args.command) throw new Error("Bash requires command");
      const result: JsonObject = { command: args.command };
      if (args.timeout !== undefined) result.timeout = Math.min(600_000, Math.max(0, Number(args.timeout) * 1000));
      return result;
    }
    case "Edit": {
      if (!args.path || !Array.isArray(args.edits) || args.edits.length !== 1) {
        throw new Error("Official Edit replay requires exactly one pi edit entry");
      }
      const edit = objectArguments(args.edits[0], "Edit entry");
      return { file_path: args.path, old_string: edit.oldText, new_string: edit.newText };
    }
    case "Write": {
      if (!args.path || typeof args.content !== "string") throw new Error("Write requires path and content");
      return { file_path: args.path, content: args.content };
    }
    case "WebSearch": {
      if (Array.isArray(args.queries)) throw new Error("Official WebSearch replay cannot encode multiple pi queries in one tool call");
      if (!args.query) throw new Error("WebSearch requires query");
      const result: JsonObject = { query: args.query };
      if (Array.isArray(args.domainFilter)) {
        const allowed = args.domainFilter.filter((item: any) => typeof item === "string" && !item.startsWith("-"));
        const blocked = args.domainFilter.filter((item: any) => typeof item === "string" && item.startsWith("-")).map((item: string) => item.slice(1));
        if (allowed.length) result.allowed_domains = allowed;
        if (blocked.length) result.blocked_domains = blocked;
      }
      return result;
    }
    case "WebFetch": {
      if (Array.isArray(args.urls)) throw new Error("Official WebFetch replay cannot encode multiple pi URLs in one tool call");
      if (!args.url) throw new Error("WebFetch requires url");
      return { url: args.url, prompt: args.prompt || "Return the relevant readable content." };
    }
    default:
      throw new Error(`Unsupported Claude built-in ${wireName}`);
  }
}

function fromWireCore(wireName: string, value: any): JsonObject {
  const args = objectArguments(value, wireName);
  switch (wireName) {
    case "Read": {
      if (args.pages !== undefined) throw new Error("Claude Read pages is not supported by pi read");
      return { path: args.file_path, ...copyDefined(args, ["offset", "limit"]) };
    }
    case "Bash": {
      if (args.run_in_background) throw new Error("Claude Bash background execution is not supported by pi bash");
      if (args.dangerouslyDisableSandbox) throw new Error("Claude Bash sandbox override is not supported by pi bash");
      const result: JsonObject = { command: args.command };
      if (args.timeout !== undefined) result.timeout = Math.max(1, Math.ceil(Number(args.timeout) / 1000));
      return result;
    }
    case "Edit": {
      if (args.replace_all) throw new Error("Claude Edit replace_all is not supported; no file was modified");
      return {
        path: args.file_path,
        edits: [{ oldText: args.old_string, newText: args.new_string }],
      };
    }
    case "Write":
      return { path: args.file_path, content: args.content };
    case "WebSearch": {
      const domainFilter = [
        ...(Array.isArray(args.allowed_domains) ? args.allowed_domains : []),
        ...(Array.isArray(args.blocked_domains) ? args.blocked_domains.map((domain: string) => `-${domain}`) : []),
      ];
      return { query: args.query, ...(domainFilter.length ? { domainFilter } : {}) };
    }
    case "WebFetch":
      return { url: args.url, prompt: args.prompt, mode: "answer" };
    default:
      throw new Error(`Unsupported Claude built-in ${wireName}`);
  }
}

function mcpWireName(piName: string) {
  const slug = piName.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 38) || "tool";
  const hash = createHash("sha256").update(piName).digest("hex").slice(0, 8);
  return `mcp__pi__${slug}_${hash}`;
}

function createBuiltinBinding(tool: Tool, wireName: string, profile: ClaudeCodeProfile): ToolBinding {
  const wireTool = profile.request.toolCatalog[wireName];
  if (!wireTool) throw new Error(`Claude profile does not include captured built-in ${wireName}`);
  return {
    piName: tool.name,
    wireName,
    kind: "builtin",
    wireTool: clone(wireTool),
    toWireArguments: (args) => toWireCore(wireName, args),
    fromWireArguments: (args) => fromWireCore(wireName, args),
  };
}

function createMcpBinding(tool: Tool): ToolBinding {
  const wireName = mcpWireName(tool.name);
  const wireTool = {
    name: wireName,
    description: tool.description,
    input_schema: clone(tool.parameters || { type: "object", properties: {} }),
  };
  return {
    piName: tool.name,
    wireName,
    kind: "mcp",
    wireTool,
    toWireArguments: (args) => clone(objectArguments(args, wireName)),
    fromWireArguments: (args) => clone(objectArguments(args, wireName)),
  };
}

export class ClaudeToolRegistry {
  readonly tools: JsonObject[];
  readonly bindings: ToolBinding[];
  private readonly byPiName = new Map<string, ToolBinding>();
  private readonly byWireName = new Map<string, ToolBinding>();
  private readonly advertisedWireNames = new Set<string>();
  private readonly diagnosticOnlyWireNames = new Set<string>();

  constructor(
    tools: Tool[],
    profile: ClaudeCodeProfile,
    toolProfile: ClaudeToolProfile = "executable",
    selectedOfficialToolNames?: string[],
  ) {
    const bindings = tools.map((tool) => {
      const wireName = CORE_WIRE_NAME_BY_PI_NAME[tool.name.toLowerCase()];
      return wireName ? createBuiltinBinding(tool, wireName, profile) : createMcpBinding(tool);
    });
    const order = new Map(profile.request.coreToolNames.map((name, index) => [name, index]));
    bindings.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "builtin" ? -1 : 1;
      if (left.kind === "builtin") return (order.get(left.wireName) ?? 10_000) - (order.get(right.wireName) ?? 10_000);
      return tools.findIndex((tool) => tool.name === left.piName) - tools.findIndex((tool) => tool.name === right.piName);
    });

    for (const binding of bindings) {
      if (this.byPiName.has(binding.piName)) throw new Error(`Duplicate pi tool name: ${binding.piName}`);
      if (this.byWireName.has(binding.wireName)) throw new Error(`Duplicate Claude wire tool name: ${binding.wireName}`);
      this.byPiName.set(binding.piName, binding);
      this.byWireName.set(binding.wireName, binding);
    }
    this.bindings = bindings;
    if (toolProfile === "full-official") {
      const selected = selectedOfficialToolNames
        ? new Set(selectedOfficialToolNames)
        : new Set(profile.request.defaultToolNames);
      for (const name of selected) {
        if (!profile.request.toolCatalog[name]) throw new Error(`Selected official tool ${name} is not present in the Claude profile`);
      }
      const advertisedNames = profile.request.defaultToolNames.filter((name) => selected.has(name));
      if (advertisedNames.length === 0) throw new Error("full-official diagnostic profile requires at least one selected official tool");
      this.tools = advertisedNames.map((name) => clone(profile.request.toolCatalog[name]));
      for (const name of advertisedNames) {
        this.advertisedWireNames.add(name);
        if (!this.byWireName.has(name)) this.diagnosticOnlyWireNames.add(name);
      }
    } else if (toolProfile === "compatible-core") {
      this.tools = profile.request.coreToolNames.map((name) => clone(profile.request.toolCatalog[name]));
      for (const name of profile.request.coreToolNames) {
        this.advertisedWireNames.add(name);
        if (!this.byWireName.has(name)) this.diagnosticOnlyWireNames.add(name);
      }
    } else {
      this.tools = bindings.map((binding) => clone(binding.wireTool));
      for (const binding of bindings) this.advertisedWireNames.add(binding.wireName);
    }
  }

  private getExecutableBinding(wireName: string) {
    const binding = this.byWireName.get(wireName);
    if (binding && this.advertisedWireNames.has(wireName)) return binding;
    if (this.diagnosticOnlyWireNames.has(wireName)) {
      throw new Error(`Claude called diagnostic-only official tool ${wireName}; no active pi handler is registered`);
    }
    throw new Error(`Claude returned unadvertised tool ${wireName}`);
  }

  getPiName(wireName: string) {
    return this.getExecutableBinding(wireName).piName;
  }

  toWireToolCall(piName: string, argumentsValue: any) {
    const binding = this.byPiName.get(piName);
    if (!binding) throw new Error(`Historical pi tool ${piName} is not available in the current AnyRouter context`);
    if (!this.advertisedWireNames.has(binding.wireName)) {
      throw new Error(`Historical pi tool ${piName} is not advertised by the full-official diagnostic profile`);
    }
    return { name: binding.wireName, input: binding.toWireArguments(argumentsValue) };
  }

  fromWireToolCall(wireName: string, argumentsValue: any) {
    const binding = this.getExecutableBinding(wireName);
    return { name: binding.piName, arguments: binding.fromWireArguments(argumentsValue) };
  }
}
