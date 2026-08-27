export type ClaudeSseCompletionState = {
  sawMessageStart: boolean;
  sawContentBlock: boolean;
  sawStopReason: boolean;
  sawMessageStop: boolean;
  openContentBlocks: number;
};

export function createClaudeSseCompletionState(): ClaudeSseCompletionState {
  return {
    sawMessageStart: false,
    sawContentBlock: false,
    sawStopReason: false,
    sawMessageStop: false,
    openContentBlocks: 0,
  };
}

export function observeClaudeSsePayload(state: ClaudeSseCompletionState, payload: any) {
  switch (payload?.type) {
    case "message_start":
      state.sawMessageStart = true;
      break;
    case "content_block_start":
      state.sawContentBlock = true;
      state.openContentBlocks += 1;
      break;
    case "content_block_stop":
      state.openContentBlocks = Math.max(0, state.openContentBlocks - 1);
      break;
    case "message_delta":
      if (payload.delta?.stop_reason) state.sawStopReason = true;
      break;
    case "message_stop":
      state.sawMessageStop = true;
      break;
  }
}

export function getClaudeSseCompletionError(state: ClaudeSseCompletionState) {
  if (!state.sawMessageStart) return "Claude stream ended without a terminal response event (missing message_start)";
  if (state.openContentBlocks > 0) return "Claude stream ended without a terminal response event (incomplete content block)";
  if (!state.sawStopReason) return "Claude stream ended without a terminal response event (missing message_delta stop_reason)";
  if (!state.sawMessageStop) return "Claude stream ended before message_stop";
  return undefined;
}

export function canRetryIncompleteClaudeStream(state: ClaudeSseCompletionState) {
  return !state.sawContentBlock;
}

export function parseSseEvent(chunk: string) {
  let event = "message";
  const data: string[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join("\n") };
}

export function nextSseChunk(buffer: string) {
  const unix = buffer.indexOf("\n\n");
  const dos = buffer.indexOf("\r\n\r\n");
  if (unix === -1 && dos === -1) return undefined;
  if (dos !== -1 && (unix === -1 || dos < unix)) {
    return { chunk: buffer.slice(0, dos), rest: buffer.slice(dos + 4) };
  }
  return { chunk: buffer.slice(0, unix), rest: buffer.slice(unix + 2) };
}

export function parseSseJson(data: string, label = "SSE") {
  try {
    return JSON.parse(data);
  } catch {
    throw new Error(`invalid ${label} payload: ${data.slice(0, 200)}`);
  }
}
