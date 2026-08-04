export type ConversationRole = "user" | "assistant";

export interface ConversationMessage {
  id: string;
  role: ConversationRole;
  content: string;
  createdAt: string;
  runId?: string;
}

export interface ConversationChatSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ConversationChat extends ConversationChatSummary {
  messages: ConversationMessage[];
}

export interface ConversationThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  lastActiveTabId: string | null;
  lastActiveUrl: string | null;
  chatCount: number;
  messageCount: number;
}

export interface ConversationThread extends ConversationThreadSummary {
  chats: ConversationChat[];
}

export interface ConversationStoreState {
  version: 2;
  threads: ConversationThread[];
}

export interface CreateConversationInput {
  title?: string;
  lastActiveTabId?: string | null;
  lastActiveUrl?: string | null;
}

export interface CreateConversationChatInput {
  title?: string;
}
