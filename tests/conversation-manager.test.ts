import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { app, safeStorage } from "electron";
import { ConversationManager } from "../src/main/conversations/manager";

const filename = "vessel-conversations-test.json";
const statePath = path.join(app.getPath("userData"), filename);
const storageMock = safeStorage as typeof safeStorage & {
  __setEncryptionAvailable(value: boolean): void;
};

async function cleanState(): Promise<void> {
  storageMock.__setEncryptionAvailable(true);
  await fs.rm(statePath, { force: true });
}

test("conversation manager persists named threads and normalized messages", async () => {
  await cleanState();
  let id = 0;
  let now = new Date("2026-01-01T00:00:00.000Z");
  const manager = new ConversationManager({
    filename,
    createId: () => `id-${++id}`,
    now: () => now,
  });
  const thread = manager.createThread({
    lastActiveTabId: "tab-1",
    lastActiveUrl: "https://example.test",
  });
  const chat = manager.createChat(thread.id);
  manager.appendMessage(thread.id, chat!.id, {
    role: "user",
    content: "  Compare these plans  ",
    runId: "run-1",
  });
  now = new Date("2026-01-01T00:00:01.000Z");
  manager.appendMessage(thread.id, chat!.id, {
    role: "assistant",
    content: "Here is the comparison.",
  });
  await manager.flushPersist();

  const reloaded = new ConversationManager({ filename });
  const stored = reloaded.getThread(thread.id);
  assert.equal(stored?.title, "New thread");
  assert.deepEqual(
    stored?.chats[0].messages.map(({ role, content, runId }) => ({ role, content, runId })),
    [
      { role: "user", content: "Compare these plans", runId: "run-1" },
      { role: "assistant", content: "Here is the comparison.", runId: undefined },
    ],
  );
});

test("named threads contain independently titled editable chats", async () => {
  await cleanState();
  let id = 0;
  const manager = new ConversationManager({ filename, createId: () => `id-${++id}` });
  const thread = manager.createThread({ title: "Launch planning" });
  const firstChat = manager.createChat(thread.id);
  const secondChat = manager.createChat(thread.id);

  assert.equal(firstChat?.title, "New chat");
  assert.equal(secondChat?.title, "New chat");
  manager.appendMessage(thread.id, firstChat!.id, {
    role: "user",
    content: "Compare the rollout options",
  });
  manager.appendMessage(thread.id, secondChat!.id, {
    role: "user",
    content: "Draft the launch email",
  });
  manager.renameChat(thread.id, firstChat!.id, "Rollout comparison");

  const stored = manager.getThread(thread.id);
  assert.equal(stored?.title, "Launch planning");
  assert.equal(stored?.chatCount, 2);
  assert.deepEqual(
    stored?.chats.map((chat) => ({
      title: chat.title,
      messages: chat.messages.map((message) => message.content),
    })),
    [
      { title: "Rollout comparison", messages: ["Compare the rollout options"] },
      { title: "New chat", messages: ["Draft the launch email"] },
    ],
  );
});

test("conversation manager archives, renames, deletes, and prunes threads", async () => {
  await cleanState();
  let now = new Date("2026-01-01T00:00:00.000Z");
  const manager = new ConversationManager({ filename, now: () => now });
  const old = manager.createThread({ title: "Old thread" });
  manager.renameThread(old.id, "Renamed thread");
  manager.archiveThread(old.id);
  const active = manager.createThread({ title: "Current thread" });

  now = new Date("2026-05-01T00:00:00.000Z");
  assert.equal(manager.pruneExpired(90), 1);
  assert.equal(manager.getThread(old.id), null);
  assert.equal(manager.getThread(active.id)?.title, "Current thread");
  assert.equal(manager.deleteThread(active.id), true);
  assert.equal(manager.getThread(active.id), null);
});

test("conversation manager remains memory-only when secure storage is unavailable", async () => {
  await cleanState();
  storageMock.__setEncryptionAvailable(false);
  const manager = new ConversationManager({ filename });
  const thread = manager.createThread({ title: "Private" });
  const chat = manager.createChat(thread.id);
  manager.appendMessage(thread.id, chat!.id, { role: "user", content: "Sensitive context" });

  assert.equal(manager.isPersistenceAvailable(), false);
  assert.equal(manager.getThread(thread.id)?.chats[0].messages.length, 1);
  await manager.flushPersist();
  await assert.rejects(() => fs.access(statePath));
  storageMock.__setEncryptionAvailable(true);
});

test("conversation manager drops malformed rows without losing valid history", async () => {
  await cleanState();
  const manager = new ConversationManager({ filename });
  const thread = manager.createThread({ title: "Keep me" });
  const chat = manager.createChat(thread.id);
  manager.appendMessage(thread.id, chat!.id, { role: "user", content: "Still here" });
  await manager.flushPersist();

  const decoded = safeStorage.decryptString(await fs.readFile(statePath));
  const stored = JSON.parse(decoded) as { threads: Array<Record<string, unknown> | null> };
  stored.threads.push(null);
  const validThread = stored.threads[0] as { chats: Array<Record<string, unknown> | null> };
  validThread.chats.push(null);
  const validChat = validThread.chats[0] as { messages: unknown[] };
  validChat.messages.push(null, { role: "system", content: "invalid role" });
  await fs.writeFile(statePath, safeStorage.encryptString(JSON.stringify(stored)));

  const reloaded = new ConversationManager({ filename });
  assert.equal(reloaded.listThreads().length, 1);
  assert.equal(reloaded.getThread(thread.id)?.chats.length, 1);
  assert.deepEqual(
    reloaded.getThread(thread.id)?.chats[0].messages.map((message) => message.content),
    ["Still here"],
  );
});
