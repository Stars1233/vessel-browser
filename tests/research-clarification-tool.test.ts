import test from "node:test";
import assert from "node:assert/strict";
import { handleAIQuery } from "../src/main/ai/commands";
import type { AIProvider } from "../src/main/ai/provider";

function makePageWebContents() {
  return {
    id: 4242,
    getURL: () => "https://example.test/article",
    getTitle: () => "Example article",
    isDestroyed: () => false,
    executeJavaScript: async (script: string) => {
      if (script.includes("document.readyState")) return "complete";
      if (script.includes("querySelectorAll('*')")) return 10;
      return {
        title: "Example article",
        url: "https://example.test/article",
        content: "Useful page context",
      };
    },
  } as never;
}

function makeTabManager() {
  return {
    getAllStates: () => [
      { id: "tab-1", title: "Example article", url: "https://example.test/article" },
    ],
    getActiveTabId: () => "tab-1",
  } as never;
}

test("Research Desk briefing uses streamQuery and forwards streamed text", async () => {
  const chunks: string[] = [];
  let completed = false;

  const provider: AIProvider = {
    agentToolProfile: "default",
    async streamQuery(
      systemPrompt,
      _userMessage,
      onChunk,
      onEnd,
    ) {
      assert.ok(systemPrompt.includes("Research Captain"));
      onChunk("What depth are you looking for?");
      onChunk("\n- High-level overview\n- Deep dive\n");
      onEnd();
    },
    async streamAgentQuery() {
      throw new Error("Briefing should not use the agent tool loop");
    },
    cancel() {},
  };

  await handleAIQuery(
    "Compare AI browsers",
    provider,
    undefined,
    (chunk) => chunks.push(chunk),
    () => {
      completed = true;
    },
    undefined,
    undefined,
    [],
    {
      getState: () => ({
        phase: "briefing",
      }),
    } as never,
  );

  assert.equal(completed, true);
  assert.deepEqual(chunks, [
    "What depth are you looking for?",
    "\n- High-level overview\n- Deep dive\n",
  ]);
});

test("Research Desk planning uses streamQuery and parses objectives", async () => {
  const chunks: string[] = [];
  let completed = false;
  let parseCalled = false;

  const provider: AIProvider = {
    agentToolProfile: "default",
    async streamQuery(
      systemPrompt,
      _userMessage,
      onChunk,
      onEnd,
    ) {
      assert.ok(systemPrompt.includes("Research Objectives"));
      onChunk('```json\n{"researchQuestion":"X","threads":[]}\n```');
      onEnd();
    },
    async streamAgentQuery() {
      throw new Error("Planning should not use the agent tool loop");
    },
    cancel() {},
  };

  const orchestrator = {
    getState: () => ({ phase: "planning" }),
    parseAndSetObjectives: (text: string) => {
      parseCalled = true;
      assert.ok(text.includes("researchQuestion"));
      return true;
    },
  } as never;

  await handleAIQuery(
    "Build the Research Objectives from this brief now.",
    provider,
    undefined,
    (chunk) => chunks.push(chunk),
    () => {
      completed = true;
    },
    undefined,
    undefined,
    [],
    orchestrator,
  );

  assert.equal(completed, true);
  assert.equal(parseCalled, true);
});

test("Research Desk planning shows error when objectives parsing fails", async () => {
  const chunks: string[] = [];
  let completed = false;

  const provider: AIProvider = {
    agentToolProfile: "default",
    async streamQuery(_systemPrompt, _userMessage, onChunk, onEnd) {
      onChunk("invalid json");
      onEnd();
    },
    async streamAgentQuery() {
      throw new Error("Planning should not use the agent tool loop");
    },
    cancel() {},
  };

  const orchestrator = {
    getState: () => ({ phase: "planning" }),
    parseAndSetObjectives: () => false,
  } as never;

  await handleAIQuery(
    "Build the Research Objectives from this brief now.",
    provider,
    undefined,
    (chunk) => chunks.push(chunk),
    () => {
      completed = true;
    },
    undefined,
    undefined,
    [],
    orchestrator,
  );

  assert.equal(completed, true);
  assert.ok(
    chunks.some((c) => c.includes("Failed to parse objectives")),
  );
});

test("agent setup failures use the logged simple-path fallback before the loop starts", async () => {
  let simpleQueries = 0;
  let agentQueries = 0;
  const provider: AIProvider = {
    agentToolProfile: "default",
    async streamQuery(_systemPrompt, _userMessage, onChunk, onEnd) {
      simpleQueries += 1;
      onChunk("fallback response");
      onEnd();
    },
    async streamAgentQuery() {
      agentQueries += 1;
    },
    cancel() {},
  };
  const runtime = {
    clearTaskTracker: () => undefined,
    getState: () => {
      throw new Error("setup exploded");
    },
  } as never;

  await handleAIQuery(
    "What is on this page?",
    provider,
    makePageWebContents(),
    () => undefined,
    () => undefined,
    makeTabManager(),
    runtime,
  );

  assert.equal(agentQueries, 0);
  assert.equal(simpleQueries, 1);
});

test("agent-loop failures propagate without producing a second simple answer", async () => {
  let simpleQueries = 0;
  const chunks: string[] = [];
  const provider: AIProvider = {
    agentToolProfile: "default",
    async streamQuery() {
      simpleQueries += 1;
    },
    async streamAgentQuery(_systemPrompt, _query, _tools, onChunk) {
      onChunk("partial agent response");
      throw new Error("tool loop exploded");
    },
    cancel() {},
  };
  const runtime = {
    clearTaskTracker: () => undefined,
    getState: () => ({
      checkpoints: [],
      supervisor: { paused: false, approvalMode: "confirm-dangerous", pendingApprovals: [] },
      taskMemory: null,
    }),
    getTaskTrackerContext: () => "",
    getTaskMemoryContext: () => "",
  } as never;

  await assert.rejects(
    handleAIQuery(
      "What is on this page?",
      provider,
      makePageWebContents(),
      (chunk) => chunks.push(chunk),
      () => undefined,
      makeTabManager(),
      runtime,
    ),
    /tool loop exploded/,
  );

  assert.deepEqual(chunks, ["partial agent response"]);
  assert.equal(simpleQueries, 0);
});
