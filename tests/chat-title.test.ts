import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatTitlePrompt,
  normalizeGeneratedChatTitle,
} from "../src/main/conversations/chat-title";

test("chat title prompt uses the first completed exchange", () => {
  const prompt = buildChatTitlePrompt("How should we roll this out?", "Start with a small beta.");
  assert.match(prompt, /How should we roll this out\?/);
  assert.match(prompt, /Start with a small beta\./);
  assert.match(prompt, /80 characters/i);
});

test("generated chat titles are single-line, unquoted, and bounded", () => {
  assert.equal(
    normalizeGeneratedChatTitle('  "Beta rollout plan"\nExtra explanation', "fallback"),
    "Beta rollout plan",
  );
  assert.equal(
    normalizeGeneratedChatTitle("", "How should we roll this out to the whole company?"),
    "How should we roll this out to the whole company?",
  );
  assert.equal(normalizeGeneratedChatTitle("x".repeat(120), "fallback").length, 80);
});
