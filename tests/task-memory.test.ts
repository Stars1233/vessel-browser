import assert from "node:assert/strict";
import test from "node:test";

import {
  createTaskMemory,
  updateTaskMemory,
  addTaskNote,
  setTaskBlocker,
  resolveTaskMemory,
  abandonTaskMemory,
  formatTaskMemory,
} from "../src/main/ai/task-memory";
import type { TaskMemory } from "../src/shared/types";

function makeActiveTask(overrides?: Partial<TaskMemory>): TaskMemory {
  return {
    id: "test-id",
    goal: "Buy groceries online",
    status: "active",
    blocker: null,
    notes: [],
    nextStep: null,
    facts: {},
    startedAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

// --- createTaskMemory ---

test("createTaskMemory creates an active task with the given goal", () => {
  const task = createTaskMemory("Find the best laptop deal");
  assert.equal(task.goal, "Find the best laptop deal");
  assert.equal(task.status, "active");
  assert.equal(task.blocker, null);
  assert.equal(task.nextStep, null);
  assert.deepEqual(task.notes, []);
  assert.deepEqual(task.facts, {});
  assert.equal(task.completedAt, null);
  assert.ok(task.id);
  assert.ok(task.startedAt);
  assert.ok(task.updatedAt);
});

test("createTaskMemory trims the goal", () => {
  const task = createTaskMemory("  research flights  ");
  assert.equal(task.goal, "research flights");
});

// --- updateTaskMemory ---

test("updateTaskMemory sets nextStep", () => {
  const task = makeActiveTask();
  const updated = updateTaskMemory(task, { nextStep: "Search on Amazon" });
  assert.equal(updated.nextStep, "Search on Amazon");
});

test("updateTaskMemory merges facts", () => {
  const task = makeActiveTask({ facts: { site: "amazon.com" } });
  const updated = updateTaskMemory(task, { facts: { item: "laptop" } });
  assert.equal(updated.facts.site, "amazon.com");
  assert.equal(updated.facts.item, "laptop");
});

test("updateTaskMemory overwrites existing facts", () => {
  const task = makeActiveTask({ facts: { site: "amazon.com" } });
  const updated = updateTaskMemory(task, { facts: { site: "bestbuy.com" } });
  assert.equal(updated.facts.site, "bestbuy.com");
});

test("updateTaskMemory sets nextStep to null when explicitly passed", () => {
  const task = makeActiveTask({ nextStep: "Search on Amazon" });
  const updated = updateTaskMemory(task, { nextStep: null });
  assert.equal(updated.nextStep, null);
});

test("updateTaskMemory preserves existing nextStep when not passed", () => {
  const task = makeActiveTask({ nextStep: "Search on Amazon" });
  const updated = updateTaskMemory(task, { facts: { key: "val" } });
  assert.equal(updated.nextStep, "Search on Amazon");
});

// --- addTaskNote ---

test("addTaskNote appends a note", () => {
  const task = makeActiveTask();
  const updated = addTaskNote(task, "Found a good deal on page 3");
  assert.equal(updated.notes.length, 1);
  assert.equal(updated.notes[0].text, "Found a good deal on page 3");
  assert.ok(updated.notes[0].id);
  assert.ok(updated.notes[0].createdAt);
});

test("addTaskNote trims whitespace", () => {
  const task = makeActiveTask();
  const updated = addTaskNote(task, "  note text  ");
  assert.equal(updated.notes[0].text, "note text");
});

test("addTaskNote caps at 50 notes", () => {
  const task = makeActiveTask({
    notes: Array.from({ length: 50 }, (_, i) => ({
      id: `note-${i}`,
      text: `Old note ${i}`,
      createdAt: "2025-01-01T00:00:00.000Z",
    })),
  });
  const updated = addTaskNote(task, "New note");
  assert.equal(updated.notes.length, 50);
  assert.equal(updated.notes[49].text, "New note");
});

// --- setTaskBlocker ---

test("setTaskBlocker sets blocker and changes status to blocked", () => {
  const task = makeActiveTask();
  const updated = setTaskBlocker(task, "Captcha is blocking access");
  assert.equal(updated.status, "blocked");
  assert.equal(updated.blocker, "Captcha is blocking access");
});

test("setTaskBlocker clears blocker and restores status to active", () => {
  const task = makeActiveTask({ status: "blocked", blocker: "stuck" });
  const updated = setTaskBlocker(task, null);
  assert.equal(updated.status, "active");
  assert.equal(updated.blocker, null);
});

test("setTaskBlocker on a completed task clears blocker but keeps completed status", () => {
  const task = makeActiveTask({ status: "completed", completedAt: "2025-01-01T00:00:00.000Z" });
  const updated = setTaskBlocker(task, null);
  assert.equal(updated.status, "completed");
  assert.equal(updated.blocker, null);
});

// --- resolveTaskMemory ---

test("resolveTaskMemory marks task as completed", () => {
  const task = makeActiveTask();
  const resolved = resolveTaskMemory(task, "Found the deal!");
  assert.equal(resolved.status, "completed");
  assert.equal(resolved.blocker, null);
  assert.ok(resolved.completedAt);
});

test("resolveTaskMemory adds summary as note", () => {
  const task = makeActiveTask();
  const resolved = resolveTaskMemory(task, "Found the deal!");
  assert.equal(resolved.notes.length, 1);
  assert.equal(resolved.notes[0].text, "Found the deal!");
});

test("resolveTaskMemory without summary still completes", () => {
  const task = makeActiveTask();
  const resolved = resolveTaskMemory(task);
  assert.equal(resolved.status, "completed");
  assert.equal(resolved.notes.length, 0);
});

// --- abandonTaskMemory ---

test("abandonTaskMemory marks task as abandoned", () => {
  const task = makeActiveTask();
  const abandoned = abandonTaskMemory(task, "Site is down");
  assert.equal(abandoned.status, "abandoned");
  assert.equal(abandoned.blocker, null);
  assert.ok(abandoned.completedAt);
});

test("abandonTaskMemory adds reason as note", () => {
  const task = makeActiveTask();
  const abandoned = abandonTaskMemory(task, "Site is down");
  assert.equal(abandoned.notes.length, 1);
  assert.equal(abandoned.notes[0].text, "Abandoned: Site is down");
});

test("abandonTaskMemory without reason still abandons", () => {
  const task = makeActiveTask();
  const abandoned = abandonTaskMemory(task);
  assert.equal(abandoned.status, "abandoned");
  assert.equal(abandoned.notes.length, 0);
});

// --- formatTaskMemory ---

test("formatTaskMemory returns empty string for null", () => {
  assert.equal(formatTaskMemory(null), "");
});

test("formatTaskMemory formats an active task", () => {
  const task = makeActiveTask({
    goal: "Buy groceries",
    nextStep: "Search for items",
    facts: { store: "whole foods" },
  });
  const text = formatTaskMemory(task);
  assert.ok(text.includes("Buy groceries"));
  assert.ok(text.includes("active"));
  assert.ok(text.includes("Next step: Search for items"));
  assert.ok(text.includes("store: whole foods"));
});

test("formatTaskMemory formats a blocked task", () => {
  const task = makeActiveTask({
    goal: "Login",
    status: "blocked",
    blocker: "2FA required",
  });
  const text = formatTaskMemory(task);
  assert.ok(text.includes("blocked"));
  assert.ok(text.includes("2FA required"));
});

test("formatTaskMemory shows notes", () => {
  const task = makeActiveTask({
    notes: [{ id: "1", text: "Found good prices", createdAt: "2025-01-01T14:30:00.000Z" }],
  });
  const text = formatTaskMemory(task);
  assert.ok(text.includes("Found good prices"));
  assert.ok(text.includes("14:30"));
});

test("formatTaskMemory omits empty sections", () => {
  const task = makeActiveTask({ goal: "Simple task" });
  const text = formatTaskMemory(task);
  assert.ok(!text.includes("Next step:"));
  assert.ok(!text.includes("Facts:"));
  assert.ok(!text.includes("Notes:"));
});

// --- Immutability checks ---

test("updateTaskMemory does not mutate the original task", () => {
  const task = makeActiveTask({ facts: { key: "old" } });
  const updated = updateTaskMemory(task, { facts: { key: "new" } });
  assert.equal(task.facts.key, "old");
  assert.equal(updated.facts.key, "new");
});

test("addTaskNote does not mutate the original task", () => {
  const task = makeActiveTask();
  const updated = addTaskNote(task, "test note");
  assert.equal(task.notes.length, 0);
  assert.equal(updated.notes.length, 1);
});
