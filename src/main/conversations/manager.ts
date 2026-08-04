import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";
import { PersistentState } from "../persistence/persistent-state";
import type {
  ConversationChat,
  ConversationMessage,
  ConversationStoreState,
  ConversationThread,
  ConversationThreadSummary,
  CreateConversationChatInput,
  CreateConversationInput,
} from "../../shared/conversation-types";
import type { HistoryRetentionDays } from "../../shared/run-types";

interface ConversationManagerOptions {
  filename?: string;
  createId?: () => string;
  now?: () => Date;
}

interface AppendConversationMessageInput {
  role: ConversationMessage["role"];
  content: string;
  runId?: string;
}

const EMPTY_STATE: ConversationStoreState = { version: 2, threads: [] };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function storedString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function summarize(thread: ConversationThread): ConversationThreadSummary {
  const { chats: _chats, ...summary } = thread;
  return clone(summary);
}

export class ConversationManager {
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly memoryOnly: boolean;
  private readonly state: PersistentState<ConversationStoreState>;

  constructor(options: ConversationManagerOptions = {}) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    try {
      this.memoryOnly = !safeStorage.isEncryptionAvailable();
    } catch {
      this.memoryOnly = true;
    }
    this.state = new PersistentState<ConversationStoreState>({
      filename: options.filename ?? "vessel-conversations.json",
      fallback: clone(EMPTY_STATE),
      parse: (raw) => this.parseStoredState(raw),
      logLabel: "conversations",
      debounceMs: 150,
      resetOnSchedule: true,
      secure: !this.memoryOnly,
      snapshot: clone,
    });
  }

  createThread(input: CreateConversationInput = {}): ConversationThread {
    const timestamp = this.now().toISOString();
    const thread: ConversationThread = {
      id: this.createId(),
      title: input.title?.trim() || "New thread",
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      lastActiveTabId: input.lastActiveTabId ?? null,
      lastActiveUrl: input.lastActiveUrl ?? null,
      chatCount: 0,
      messageCount: 0,
      chats: [],
    };
    this.mutate((state) => state.threads.push(thread));
    return clone(thread);
  }

  createChat(threadId: string, input: CreateConversationChatInput = {}): ConversationChat | null {
    const timestamp = this.now().toISOString();
    const chat: ConversationChat = {
      id: this.createId(),
      title: input.title?.trim().slice(0, 200) || "New chat",
      createdAt: timestamp,
      updatedAt: timestamp,
      messageCount: 0,
      messages: [],
    };
    return this.mutate((state) => {
      const thread = state.threads.find((candidate) => candidate.id === threadId);
      if (!thread) return null;
      thread.chats.push(chat);
      thread.chatCount = thread.chats.length;
      thread.updatedAt = timestamp;
      thread.archivedAt = null;
      return clone(chat);
    });
  }

  appendMessage(
    threadId: string,
    chatId: string,
    input: AppendConversationMessageInput,
  ): ConversationMessage | null {
    const content = input.content.trim();
    if (!content) return null;
    const message: ConversationMessage = {
      id: this.createId(),
      role: input.role,
      content,
      createdAt: this.now().toISOString(),
      ...(input.runId ? { runId: input.runId } : {}),
    };
    return this.mutate((state) => {
      const thread = state.threads.find((candidate) => candidate.id === threadId);
      const chat = thread?.chats.find((candidate) => candidate.id === chatId);
      if (!thread || !chat) return null;
      chat.messages.push(message);
      chat.messageCount = chat.messages.length;
      chat.updatedAt = message.createdAt;
      thread.messageCount = thread.chats.reduce(
        (total, candidate) => total + candidate.messageCount,
        0,
      );
      thread.updatedAt = message.createdAt;
      thread.archivedAt = null;
      return clone(message);
    });
  }

  renameChat(threadId: string, chatId: string, title: string): ConversationChat | null {
    const normalized = title.trim();
    if (!normalized) return null;
    return this.mutate((state) => {
      const thread = state.threads.find((candidate) => candidate.id === threadId);
      const chat = thread?.chats.find((candidate) => candidate.id === chatId);
      if (!thread || !chat) return null;
      const timestamp = this.now().toISOString();
      chat.title = normalized.slice(0, 200);
      chat.updatedAt = timestamp;
      thread.updatedAt = timestamp;
      return clone(chat);
    });
  }

  updateLocation(
    threadId: string,
    tabId: string | null,
    url: string | null,
  ): ConversationThread | null {
    return this.mutate((state) => {
      const thread = state.threads.find((candidate) => candidate.id === threadId);
      if (!thread) return null;
      thread.lastActiveTabId = tabId;
      thread.lastActiveUrl = url;
      thread.updatedAt = this.now().toISOString();
      return clone(thread);
    });
  }

  renameThread(threadId: string, title: string): ConversationThread | null {
    const normalized = title.trim();
    if (!normalized) return null;
    return this.mutate((state) => {
      const thread = state.threads.find((candidate) => candidate.id === threadId);
      if (!thread) return null;
      thread.title = normalized.slice(0, 200);
      thread.updatedAt = this.now().toISOString();
      return clone(thread);
    });
  }

  archiveThread(threadId: string): ConversationThread | null {
    return this.mutate((state) => {
      const thread = state.threads.find((candidate) => candidate.id === threadId);
      if (!thread) return null;
      const timestamp = this.now().toISOString();
      thread.archivedAt = timestamp;
      thread.updatedAt = timestamp;
      return clone(thread);
    });
  }

  deleteThread(threadId: string): boolean {
    return this.mutate((state) => {
      const before = state.threads.length;
      state.threads = state.threads.filter((thread) => thread.id !== threadId);
      return state.threads.length !== before;
    });
  }

  getThread(threadId: string): ConversationThread | null {
    const thread = this.state.getState().threads.find((candidate) => candidate.id === threadId);
    return thread ? clone(thread) : null;
  }

  getChat(threadId: string, chatId: string): ConversationChat | null {
    const chat = this.state
      .getState()
      .threads.find((candidate) => candidate.id === threadId)
      ?.chats.find((candidate) => candidate.id === chatId);
    return chat ? clone(chat) : null;
  }

  listThreads(options: { includeArchived?: boolean } = {}): ConversationThreadSummary[] {
    return this.state
      .getState()
      .threads.filter((thread) => options.includeArchived || thread.archivedAt === null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(summarize);
  }

  pruneExpired(retentionDays: HistoryRetentionDays): number {
    if (retentionDays === null) return 0;
    const cutoff = this.now().getTime() - retentionDays * 24 * 60 * 60 * 1000;
    return this.mutate((state) => {
      const before = state.threads.length;
      state.threads = state.threads.filter(
        (thread) => thread.archivedAt === null || new Date(thread.updatedAt).getTime() >= cutoff,
      );
      return before - state.threads.length;
    });
  }

  subscribe(listener: (threads: ConversationThreadSummary[]) => void): () => void {
    return this.state.subscribe((snapshot) =>
      listener(
        snapshot.threads
          .filter((thread) => thread.archivedAt === null)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .map(summarize),
      ),
    );
  }

  isPersistenceAvailable(): boolean {
    return !this.memoryOnly;
  }

  flushPersist(): Promise<void> {
    return this.memoryOnly ? Promise.resolve() : this.state.flushPersist();
  }

  private mutate<R>(mutator: (state: ConversationStoreState) => R): R {
    return this.state.mutate(mutator, { save: !this.memoryOnly });
  }

  private parseStoredState(raw: unknown): ConversationStoreState {
    if (!raw || typeof raw !== "object") return clone(EMPTY_STATE);
    const input = raw as { threads?: unknown[] };
    return {
      version: 2,
      threads: Array.isArray(input.threads)
        ? input.threads.flatMap((value) => {
            const thread = this.parseStoredThread(value);
            return thread ? [thread] : [];
          })
        : [],
    };
  }

  private parseStoredThread(value: unknown): ConversationThread | null {
    const thread = asRecord(value);
    if (!thread) return null;
    const createdAt = storedString(thread.createdAt, this.now().toISOString());
    const updatedAt = storedString(thread.updatedAt, createdAt);
    const chats = Array.isArray(thread.chats)
      ? thread.chats.flatMap((chat) => {
          const parsed = this.parseStoredChat(chat, createdAt);
          return parsed ? [parsed] : [];
        })
      : Array.isArray(thread.messages) && thread.messages.length > 0
        ? [
            this.parseStoredChat(
              {
                id: `legacy-${typeof thread.id === "string" ? thread.id : "conversation"}`,
                title: typeof thread.title === "string" ? thread.title : "Previous chat",
                createdAt,
                updatedAt,
                messages: thread.messages,
              },
              createdAt,
            ),
          ].filter((chat): chat is ConversationChat => chat !== null)
        : [];
    return {
      id: storedString(thread.id, this.createId()),
      title: storedString(thread.title, "New thread").trim(),
      createdAt,
      updatedAt,
      archivedAt: typeof thread.archivedAt === "string" ? thread.archivedAt : null,
      lastActiveTabId: typeof thread.lastActiveTabId === "string" ? thread.lastActiveTabId : null,
      lastActiveUrl: typeof thread.lastActiveUrl === "string" ? thread.lastActiveUrl : null,
      chatCount: chats.length,
      messageCount: chats.reduce((total, chat) => total + chat.messageCount, 0),
      chats,
    };
  }

  private parseStoredChat(value: unknown, fallbackCreatedAt: string): ConversationChat | null {
    const chat = asRecord(value);
    if (!chat) return null;
    const createdAt = storedString(chat.createdAt, fallbackCreatedAt);
    const messages = Array.isArray(chat.messages)
      ? chat.messages.flatMap((message) => {
          const parsed = this.parseStoredMessage(message, createdAt);
          return parsed ? [parsed] : [];
        })
      : [];
    return {
      id: storedString(chat.id, this.createId()),
      title: storedString(chat.title, "New chat").trim(),
      createdAt,
      updatedAt: storedString(chat.updatedAt, createdAt),
      messageCount: messages.length,
      messages,
    };
  }

  private parseStoredMessage(
    value: unknown,
    fallbackCreatedAt: string,
  ): ConversationMessage | null {
    const message = asRecord(value);
    if (!message) return null;
    if (message.role !== "user" && message.role !== "assistant") return null;
    if (typeof message.content !== "string" || !message.content.trim()) return null;
    return {
      id: storedString(message.id, this.createId()),
      role: message.role,
      content: message.content,
      createdAt: storedString(message.createdAt, fallbackCreatedAt),
      ...(typeof message.runId === "string" && message.runId ? { runId: message.runId } : {}),
    };
  }
}
