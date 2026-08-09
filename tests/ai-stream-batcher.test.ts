import assert from "node:assert/strict";
import test from "node:test";
import { createStreamBatcher } from "../src/main/ai/stream-batcher";

test("AI stream batcher coalesces chunks and flushes in order", () => {
  const emitted: string[] = [];
  const batcher = createStreamBatcher((chunk) => emitted.push(chunk), 1000);

  batcher.push("one");
  batcher.push(" two");
  assert.deepEqual(emitted, []);
  batcher.flush();
  assert.deepEqual(emitted, ["one two"]);

  batcher.push("three");
  batcher.flush();
  assert.deepEqual(emitted, ["one two", "three"]);
});

test("AI stream batcher can discard pending output", () => {
  const emitted: string[] = [];
  const batcher = createStreamBatcher((chunk) => emitted.push(chunk), 1000);
  batcher.push("discard me");
  batcher.cancel();
  batcher.flush();
  assert.deepEqual(emitted, []);
});
