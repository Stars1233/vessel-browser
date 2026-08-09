import { ipcMain } from "electron";
import { z } from "zod";
import { Channels } from "../../shared/channels";
import { loadSettings } from "../config/settings";
import { createProvider, fetchProviderModels } from "../ai/provider";
import type { AIProvider } from "../ai/provider";
import { handleAIQuery } from "../ai/commands";
import { endAIStream, onAIStreamIdle, tryBeginAIStream } from "../ai/stream-lock";
import type { AIMessage, ProviderConfig } from "../../shared/types";
import { compactProviderHistory } from "../../shared/ai-history";
import { errorResult, getErrorMessage } from "../../shared/result";
import { assertTrustedIpcSender, parseIpc, type SendToRendererViews } from "./common";
import type { AgentRuntime } from "../agent/runtime";
import type { ResearchOrchestrator } from "../agent/research/orchestrator";
import type { TabManager } from "../tabs/tab-manager";
import type { RunManager } from "../runs/manager";
import type { ConversationManager } from "../conversations/manager";
import { buildChatTitlePrompt, normalizeGeneratedChatTitle } from "../conversations/chat-title";
import { createStreamBatcher } from "../ai/stream-batcher";

// --- Zod schemas for IPC validation ---

const AIQuerySchema = z.string().min(1);
const AIMessageSchema: z.ZodType<AIMessage> = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const ConversationIdSchema = z.string().trim().min(1).optional();
const ChatIdSchema = z.string().trim().min(1).optional();
const AIHistorySchema = z.array(AIMessageSchema).optional();

const ReasoningEffortSchema = z.enum(["off", "low", "medium", "high", "max"]);

const ProviderConfigSchema = z.object({
  id: z.enum([
    "anthropic",
    "openai",
    "openai_codex",
    "openrouter",
    "ollama",
    "llama_cpp",
    "mistral",
    "xai",
    "google",
    "custom",
  ]),
  apiKey: z.string(),
  hasApiKey: z.boolean().optional(),
  model: z.string(),
  baseUrl: z.string().optional(),
  reasoningEffort: ReasoningEffortSchema.optional(),
}) satisfies z.ZodType<ProviderConfig>;

let activeChatProvider: AIProvider | null = null;
let activeManualStream: {
  cancelled: boolean;
  ended: boolean;
  flush: () => void;
} | null = null;

function finishManualStream(
  run: { cancelled: boolean; ended: boolean },
  sendToRendererViews: SendToRendererViews,
  status: "completed" | "failed",
): void {
  if (run.ended) return;
  run.ended = true;
  sendToRendererViews(Channels.AI_STREAM_END, status);
}

export function registerAIHandlers(
  tabManager: TabManager,
  runtime: AgentRuntime,
  sendToRendererViews: SendToRendererViews,
  getResearchOrchestrator: () => ResearchOrchestrator,
  runManager: RunManager,
  conversationManager: ConversationManager,
): void {
  onAIStreamIdle(() => {
    sendToRendererViews(Channels.AI_STREAM_IDLE);
  });

  ipcMain.handle(
    Channels.AI_QUERY,
    async (
      event,
      query: unknown,
      history?: unknown,
      conversationId?: unknown,
      chatId?: unknown,
    ) => {
      assertTrustedIpcSender(event);
      const validatedQuery = parseIpc(AIQuerySchema, query, "query");
      const validatedHistory =
        history !== undefined ? parseIpc(AIHistorySchema, history, "history") : undefined;
      const requestedConversationId =
        conversationId !== undefined
          ? parseIpc(ConversationIdSchema, conversationId, "conversationId")
          : undefined;
      const requestedChatId =
        chatId !== undefined ? parseIpc(ChatIdSchema, chatId, "chatId") : undefined;
      const settings = loadSettings();
      const chatConfig = settings.chatProvider;

      const getConversation = () => {
        const requestedThread = requestedConversationId
          ? conversationManager.getThread(requestedConversationId)
          : null;
        const thread =
          requestedThread ??
          conversationManager.createThread({
            title: requestedConversationId ? "New thread" : validatedQuery.slice(0, 120),
            lastActiveTabId: tabManager.getActiveTabId(),
            lastActiveUrl: tabManager.getActiveTab()?.view.webContents.getURL() ?? null,
          });
        const requestedChat = requestedChatId
          ? conversationManager.getChat(thread.id, requestedChatId)
          : null;
        const chat = requestedChat ?? conversationManager.createChat(thread.id);
        if (!chat) throw new Error("Could not create chat");
        return { thread, chat };
      };
      if (!chatConfig) {
        const activeState = tabManager
          .getAllStates()
          .find((tab) => tab.id === tabManager.getActiveTabId());
        const conversation = getConversation();
        conversationManager.appendMessage(conversation.thread.id, conversation.chat.id, {
          role: "user",
          content: validatedQuery,
        });
        const failedRun = runManager.startRun({
          source: "chat",
          title: validatedQuery,
          goal: validatedQuery,
          conversationId: conversation.thread.id,
          initialTab: activeState
            ? { tabId: activeState.id, title: activeState.title, url: activeState.url }
            : null,
        });
        runManager.finishRun(failedRun.id, {
          status: "failed",
          error: "Chat provider not configured",
        });
        sendToRendererViews(Channels.AI_STREAM_START, validatedQuery);
        sendToRendererViews(
          Channels.AI_STREAM_CHUNK,
          "Chat provider not configured. Open Settings (Ctrl+,) to choose a provider.",
        );
        sendToRendererViews(Channels.AI_STREAM_END, "failed");
        conversationManager.appendMessage(conversation.thread.id, conversation.chat.id, {
          role: "assistant",
          content: "Chat provider not configured. Open Settings to choose a provider.",
          runId: failedRun.id,
        });
        return {
          accepted: true as const,
          conversationId: conversation.thread.id,
          chatId: conversation.chat.id,
        };
      }

      if (!tryBeginAIStream("manual")) {
        return { accepted: false as const, reason: "busy" as const };
      }

      const conversation = getConversation();
      conversationManager.appendMessage(conversation.thread.id, conversation.chat.id, {
        role: "user",
        content: validatedQuery,
      });
      const initialState = tabManager
        .getAllStates()
        .find((tab) => tab.id === tabManager.getActiveTabId());
      const runRecord = runManager.startRun({
        source: "chat",
        title: validatedQuery,
        goal: validatedQuery,
        initialTab: initialState
          ? { tabId: initialState.id, title: initialState.title, url: initialState.url }
          : null,
        conversationId: conversation.thread.id,
      });
      const streamBatcher = createStreamBatcher((chunk) => {
        sendToRendererViews(Channels.AI_STREAM_CHUNK, chunk);
      });
      const run = {
        cancelled: false,
        ended: false,
        flush: streamBatcher.flush,
      };
      activeManualStream = run;
      sendToRendererViews(Channels.AI_STREAM_START, validatedQuery);

      (async () => {
        let provider: AIProvider | null = null;
        let output = "";
        let failure: string | null = null;
        try {
          provider = createProvider(chatConfig);
          activeChatProvider = provider;
          const activeTab = tabManager.getActiveTab();
          await handleAIQuery(
            validatedQuery,
            provider,
            activeTab?.view.webContents,
            (chunk) => {
              if (!run.cancelled && !run.ended) {
                output += chunk;
                streamBatcher.push(chunk);
              }
            },
            () => {
              if (!run.cancelled) {
                streamBatcher.flush();
                finishManualStream(run, sendToRendererViews, "completed");
              }
            },
            tabManager,
            runtime,
            compactProviderHistory(validatedHistory),
            getResearchOrchestrator(),
            runRecord.id,
          );
        } catch (err: unknown) {
          if (!run.cancelled) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            streamBatcher.push(`\n[Error: ${msg}]`);
            streamBatcher.flush();
            failure = msg;
            finishManualStream(run, sendToRendererViews, "failed");
          }
        } finally {
          streamBatcher.flush();
          if (activeManualStream === run) activeManualStream = null;
          if (activeChatProvider === provider) activeChatProvider = null;
          endAIStream("manual");
          if (output) runManager.appendOutput(runRecord.id, output);
          const finalState = tabManager
            .getAllStates()
            .find((tab) => tab.id === tabManager.getActiveTabId());
          runManager.finishRun(runRecord.id, {
            status: run.cancelled ? "cancelled" : failure ? "failed" : "completed",
            outputSummary: output,
            error: failure,
            finalTab: finalState
              ? { tabId: finalState.id, title: finalState.title, url: finalState.url }
              : null,
          });
          conversationManager.appendMessage(conversation.thread.id, conversation.chat.id, {
            role: "assistant",
            content: output || (failure ? `[Error: ${failure}]` : ""),
            runId: runRecord.id,
          });
          const completedChat = conversationManager.getChat(
            conversation.thread.id,
            conversation.chat.id,
          );
          if (
            !run.cancelled &&
            !failure &&
            output &&
            completedChat?.messageCount === 2 &&
            completedChat.title === "New chat"
          ) {
            let generatedTitle = "";
            try {
              await provider?.streamQuery(
                "Create a short, descriptive title for the supplied chat.",
                buildChatTitlePrompt(validatedQuery, output),
                (chunk) => {
                  generatedTitle += chunk;
                },
                () => {},
              );
            } catch {
              // The opening request remains a useful local fallback.
            }
            conversationManager.renameChat(
              conversation.thread.id,
              conversation.chat.id,
              normalizeGeneratedChatTitle(generatedTitle, validatedQuery),
            );
          }
        }
      })();
      return {
        accepted: true as const,
        conversationId: conversation.thread.id,
        chatId: conversation.chat.id,
      };
    },
  );

  ipcMain.handle(Channels.AI_CANCEL, (event) => {
    assertTrustedIpcSender(event);
    if (activeManualStream && !activeManualStream.ended) {
      activeManualStream.cancelled = true;
      activeManualStream.flush();
      finishManualStream(activeManualStream, sendToRendererViews, "failed");
    }
    activeChatProvider?.cancel();
  });

  ipcMain.handle(Channels.AI_FETCH_MODELS, async (event, config: unknown) => {
    assertTrustedIpcSender(event);
    try {
      const validatedConfig = parseIpc(ProviderConfigSchema, config, "providerConfig");
      return await fetchProviderModels(validatedConfig);
    } catch (err: unknown) {
      return errorResult(getErrorMessage(err), { models: [] });
    }
  });
}
