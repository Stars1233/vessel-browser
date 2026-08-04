import { createSignal } from "solid-js";
import type {
  ConversationThread,
  ConversationThreadSummary,
  CreateConversationInput,
} from "../../../shared/conversation-types";
import { createLogger } from "../../../shared/logger";

const logger = createLogger("ConversationStore");
const [threads, setThreads] = createSignal<ConversationThreadSummary[]>([]);
const [selectedThread, setSelectedThread] = createSignal<ConversationThread | null>(null);
let initialized = false;

async function refresh(): Promise<void> {
  setThreads(await window.vessel.conversations.list());
}

async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    await refresh();
    window.vessel.conversations.onUpdate((next) => {
      setThreads(next);
      const selectedId = selectedThread()?.id;
      if (selectedId) {
        void window.vessel.conversations
          .get(selectedId)
          .then((thread) => setSelectedThread(thread));
      }
    });
  } catch (error) {
    initialized = false;
    logger.error("Failed to initialize conversation store:", error);
  }
}

export function useConversations() {
  void init();
  return {
    threads,
    selectedThread,
    refresh,
    selectThread: async (threadId: string) => {
      const thread = await window.vessel.conversations.get(threadId);
      setSelectedThread(thread);
      return thread;
    },
    createThread: async (input: CreateConversationInput) => {
      const thread = await window.vessel.conversations.create(input);
      setSelectedThread(thread);
      return thread;
    },
    createChat: async (threadId: string) => {
      const chat = await window.vessel.conversations.createChat(threadId);
      const thread = await window.vessel.conversations.get(threadId);
      setSelectedThread(thread);
      return chat;
    },
    renameChat: async (threadId: string, chatId: string, title: string) => {
      const chat = await window.vessel.conversations.renameChat(threadId, chatId, title);
      const thread = await window.vessel.conversations.get(threadId);
      setSelectedThread(thread);
      return chat;
    },
    renameThread: (threadId: string, title: string) =>
      window.vessel.conversations.rename(threadId, title),
    clearSelection: () => setSelectedThread(null),
    archiveThread: (threadId: string) => window.vessel.conversations.archive(threadId),
    deleteThread: async (threadId: string) => {
      const deleted = await window.vessel.conversations.delete(threadId);
      if (deleted && selectedThread()?.id === threadId) setSelectedThread(null);
      return deleted;
    },
  };
}
