import assert from "node:assert/strict";
import test from "node:test";
import { getRetryDelayMs, isRetryableStatus, parseRetryAfterMs } from "../src/retry.ts";
import { nextSseChunk, parseSseEvent, parseSseJson } from "../src/sse.ts";

test("parses Unix and CRLF SSE chunks incrementally", () => {
  const unix = nextSseChunk('event: ping\ndata: {"type":"ping"}\n\nrest');
  assert.deepEqual(unix, { chunk: 'event: ping\ndata: {"type":"ping"}', rest: "rest" });
  assert.deepEqual(parseSseEvent(unix!.chunk), { event: "ping", data: '{"type":"ping"}' });

  const crlf = nextSseChunk('event: message\r\ndata: {"a":1}\r\ndata: {"b":2}\r\n\r\ntail');
  assert.equal(crlf!.rest, "tail");
  assert.deepEqual(parseSseEvent(crlf!.chunk), { event: "message", data: '{"a":1}\n{"b":2}' });
  assert.equal(nextSseChunk("event: partial\ndata: x"), undefined);
});

test("validates JSON SSE data", () => {
  assert.deepEqual(parseSseJson('{"type":"message_stop"}'), { type: "message_stop" });
  assert.throws(() => parseSseJson("{broken", "Claude SSE"), /invalid Claude SSE payload/);
});

test("classifies retry statuses and honors bounded Retry-After", () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(parseRetryAfterMs("2"), 2_000);
  assert.equal(parseRetryAfterMs("invalid"), undefined);
  const now = Date.parse("2026-08-03T00:00:00Z");
  assert.equal(parseRetryAfterMs("Mon, 03 Aug 2026 00:00:05 GMT", now), 5_000);
  assert.equal(getRetryDelayMs(0, undefined, 7), 1_007);
  assert.equal(getRetryDelayMs(10, undefined, 0), 15_000);
  assert.equal(getRetryDelayMs(0, 60_000), 30_000);
});
