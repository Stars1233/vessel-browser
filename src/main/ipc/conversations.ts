import { ipcMain } from "electron";
import { z } from "zod";
import { Channels } from "../../shared/channels";
import type { ConversationManager } from "../conversations/manager";
import { assertTrustedIpcSender, parseIpc } from "./common";

const ThreadIdSchema = z.string().min(1).max(200);
const ChatIdSchema = z.string().min(1).max(200);
const CreateThreadSchema = z
  .object({
    title: z.string().trim().max(200).optional(),
    lastActiveTabId: z.string().max(200).nullable().optional(),
    lastActiveUrl: z.string().max(20_000).nullable().optional(),
  })
  .optional();
const CreateChatSchema = z
  .object({
    title: z.string().trim().max(200).optional(),
  })
  .optional();
const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(200_000),
  runId: z.string().max(200).optional(),
});

export function registerConversationHandlers(
  manager: ConversationManager,
  sendToRendererViews: (channel: string, ...args: unknown[]) => void,
): void {
  manager.subscribe((threads) => sendToRendererViews(Channels.CONVERSATION_UPDATE, threads));

  ipcMain.handle(Channels.CONVERSATION_LIST, (event, includeArchived?: unknown) => {
    assertTrustedIpcSender(event);
    const include = parseIpc(z.boolean().optional(), includeArchived, "include archived");
    return manager.listThreads({ includeArchived: include });
  });

  ipcMain.handle(Channels.CONVERSATION_GET, (event, threadId: unknown) => {
    assertTrustedIpcSender(event);
    return manager.getThread(parseIpc(ThreadIdSchema, threadId, "conversation ID"));
  });

  ipcMain.handle(Channels.CONVERSATION_CREATE, (event, input: unknown) => {
    assertTrustedIpcSender(event);
    return manager.createThread(parseIpc(CreateThreadSchema, input, "conversation") ?? {});
  });

  ipcMain.handle(Channels.CONVERSATION_CHAT_CREATE, (event, threadId: unknown, input: unknown) => {
    assertTrustedIpcSender(event);
    return manager.createChat(
      parseIpc(ThreadIdSchema, threadId, "conversation ID"),
      parseIpc(CreateChatSchema, input, "chat") ?? {},
    );
  });

  ipcMain.handle(
    Channels.CONVERSATION_CHAT_RENAME,
    (event, threadId: unknown, chatId: unknown, title: unknown) => {
      assertTrustedIpcSender(event);
      return manager.renameChat(
        parseIpc(ThreadIdSchema, threadId, "conversation ID"),
        parseIpc(ChatIdSchema, chatId, "chat ID"),
        parseIpc(z.string().trim().min(1).max(200), title, "chat title"),
      );
    },
  );

  ipcMain.handle(Channels.CONVERSATION_RENAME, (event, threadId: unknown, title: unknown) => {
    assertTrustedIpcSender(event);
    return manager.renameThread(
      parseIpc(ThreadIdSchema, threadId, "conversation ID"),
      parseIpc(z.string().trim().min(1).max(200), title, "conversation title"),
    );
  });

  ipcMain.handle(Channels.CONVERSATION_ARCHIVE, (event, threadId: unknown) => {
    assertTrustedIpcSender(event);
    return manager.archiveThread(parseIpc(ThreadIdSchema, threadId, "conversation ID"));
  });

  ipcMain.handle(Channels.CONVERSATION_DELETE, (event, threadId: unknown) => {
    assertTrustedIpcSender(event);
    return manager.deleteThread(parseIpc(ThreadIdSchema, threadId, "conversation ID"));
  });

  ipcMain.handle(
    Channels.CONVERSATION_MESSAGE_APPEND,
    (event, threadId: unknown, chatId: unknown, message: unknown) => {
      assertTrustedIpcSender(event);
      return manager.appendMessage(
        parseIpc(ThreadIdSchema, threadId, "conversation ID"),
        parseIpc(ChatIdSchema, chatId, "chat ID"),
        parseIpc(MessageSchema, message, "conversation message"),
      );
    },
  );
}
