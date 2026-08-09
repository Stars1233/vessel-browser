import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { app, ipcMain } from "electron";
import { ConversationManager } from "../src/main/conversations/manager";
import { registerConversationHandlers } from "../src/main/ipc/conversations";
import { registerPolicyHandlers } from "../src/main/ipc/policies";
import { registerRunHandlers } from "../src/main/ipc/runs";
import { registerTrustedIpcSender } from "../src/main/ipc/common";
import { PolicyManager } from "../src/main/policy/manager";
import { RunManager } from "../src/main/runs/manager";
import { Channels } from "../src/shared/channels";

const filenames = ["runs-ipc-test.json", "conversations-ipc-test.json", "policies-ipc-test.json"];

async function cleanState(): Promise<void> {
  await Promise.all(
    filenames.map((filename) =>
      fs.rm(path.join(app.getPath("userData"), filename), { force: true }),
    ),
  );
}

function trustedEvent() {
  const sender = {
    id: 501,
    getURL: () => "file:///app/index.html",
    once: () => undefined,
    isDestroyed: () => false,
  };
  registerTrustedIpcSender(sender as never, () => true);
  return { sender, senderFrame: { url: sender.getURL() } };
}

test("reliability IPC exposes run, conversation, and policy operations", async () => {
  await cleanState();
  const runs = new RunManager({ filename: filenames[0] });
  const conversations = new ConversationManager({ filename: filenames[1] });
  const policies = new PolicyManager({ filename: filenames[2] });
  const updates: string[] = [];
  const send = (channel: string) => updates.push(channel);
  registerRunHandlers(runs, send);
  registerConversationHandlers(conversations, send);
  registerPolicyHandlers(policies, send);
  const event = trustedEvent();

  const run = runs.startRun({ source: "chat", title: "Run", goal: "Test" });
  const listedRuns = await ipcMain._handlers.get(Channels.RUN_LIST)?.(event, {});
  assert.equal(listedRuns[0].id, run.id);
  const runDetail = await ipcMain._handlers.get(Channels.RUN_GET)?.(event, run.id);
  assert.equal(runDetail.id, run.id);
  const thread = await ipcMain._handlers.get(Channels.CONVERSATION_CREATE)?.(event, {
    title: "Thread",
  });
  const chat = await ipcMain._handlers.get(Channels.CONVERSATION_CHAT_CREATE)?.(
    event,
    thread.id,
    {},
  );
  await ipcMain._handlers.get(Channels.CONVERSATION_MESSAGE_APPEND)?.(event, thread.id, chat.id, {
    role: "user",
    content: "Hello",
  });
  await ipcMain._handlers.get(Channels.CONVERSATION_CHAT_RENAME)?.(
    event,
    thread.id,
    chat.id,
    "Greeting",
  );
  const storedThread = await ipcMain._handlers.get(Channels.CONVERSATION_GET)?.(event, thread.id);
  assert.equal(storedThread.chats[0].title, "Greeting");
  assert.equal(storedThread.chats[0].messages[0].content, "Hello");

  const rule = await ipcMain._handlers.get(Channels.POLICY_ADD)?.(event, {
    decision: "allow",
    actionClass: "navigation",
    scope: "domain",
    domain: "example.test",
    reason: "Trusted domain",
  });
  assert.equal(rule.domain, "example.test");
  const evaluation = await ipcMain._handlers.get(Channels.POLICY_EVALUATE)?.(event, {
    input: {
      actionName: "navigate",
      actionClass: "navigation",
      domain: "example.test",
      dangerous: false,
      requiresApproval: false,
    },
    approvalMode: "manual",
  });
  assert.equal(evaluation.decision, "allow");

  assert.ok(updates.includes(Channels.RUN_UPDATE));
  assert.ok(updates.includes(Channels.CONVERSATION_UPDATE));
  assert.ok(updates.includes(Channels.POLICY_UPDATE));
});
