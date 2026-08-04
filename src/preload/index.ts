import { contextBridge, ipcRenderer } from "electron";
import { Channels } from "../shared/channels";
import type {
  AgentCheckpoint,
  AgentRuntimeState,
  AutomationActivityEntry,
  AIMessage,
  ApprovalMode,
  AutomationKit,
  Bookmark,
  BookmarkFolder,
  BookmarkExportResult,
  BookmarkHtmlExportOptions,
  BookmarksState,
  ClearDataOptions,
  HistoryState,
  HistoryPage,
  ImportResult,
  PremiumState,
  ProviderConfig,
  ProviderModelsResult,
  RuntimeHealthState,
  ScheduledJob,
  SecurityState,
  SessionSnapshot,
  SidebarPanelState,
  DownloadRecord,
  PermissionRecord,
  TaskMemory,
  UpdateCheckResult,
  TabGroupColor,
  TabState,
  RendererSettableSettingKey,
  RendererSettableSettings,
  VesselSettings,
} from "../shared/types";
import type { ApprovalResolution } from "../shared/policy-types";
import type { RunDetail, RunListQuery, RunRecord } from "../shared/run-types";
import type {
  ConversationChat,
  ConversationMessage,
  ConversationThread,
  ConversationThreadSummary,
  CreateConversationInput,
  CreateConversationChatInput,
} from "../shared/conversation-types";
import type {
  AddPolicyRuleInput,
  PolicyEvaluation,
  PolicyEvaluationInput,
  PolicyRule,
} from "../shared/policy-types";
import type { AutofillProfile, AutofillResult } from "../shared/autofill-types";
import type { PageDiff, PageDiffHistoryItem } from "../shared/page-diff-types";
import type {
  DevToolsPanelHostState,
  DevToolsPageMapRevealStatus,
  DevToolsPanelState,
  DevToolsPanelTab,
} from "../shared/devtools-types";
import type { ResearchClarification, ResearchState } from "../shared/research-types";

type TabId = TabState["id"];
type TabGroupId = NonNullable<TabState["groupId"]>;
type TabNavigationPostBody = Record<string, string>;
type FindInPageOptions = {
  forward?: boolean;
  findNext?: boolean;
};
type FindInPageStopAction = "clearSelection" | "keepSelection" | "activateSelection";
type FindInPageResult = {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
};

const api = {
  tabs: {
    create: (url?: string): Promise<TabId> => ipcRenderer.invoke(Channels.TAB_CREATE, url),
    close: (id: TabId): Promise<void> => ipcRenderer.invoke(Channels.TAB_CLOSE, id),
    switch: (id: TabId): Promise<void> => ipcRenderer.invoke(Channels.TAB_SWITCH, id),
    navigate: (id: TabId, url: string, postBody?: TabNavigationPostBody): Promise<void> =>
      ipcRenderer.invoke(Channels.TAB_NAVIGATE, id, url, postBody),
    back: (id: TabId): Promise<void> => ipcRenderer.invoke(Channels.TAB_BACK, id),
    forward: (id: TabId): Promise<void> => ipcRenderer.invoke(Channels.TAB_FORWARD, id),
    reload: (id: TabId): Promise<void> => ipcRenderer.invoke(Channels.TAB_RELOAD, id),
    toggleAdBlock: (id: TabId): Promise<boolean | null> =>
      ipcRenderer.invoke(Channels.TAB_TOGGLE_AD_BLOCK, id),
    zoomIn: (id: TabId): Promise<void> => ipcRenderer.invoke(Channels.TAB_ZOOM_IN, id),
    zoomOut: (id: TabId): Promise<void> => ipcRenderer.invoke(Channels.TAB_ZOOM_OUT, id),
    zoomReset: (id: TabId): Promise<void> => ipcRenderer.invoke(Channels.TAB_ZOOM_RESET, id),
    reopenClosed: (): Promise<TabId | null> => ipcRenderer.invoke(Channels.TAB_REOPEN_CLOSED),
    duplicate: (id: TabId): Promise<TabId | null> => ipcRenderer.invoke(Channels.TAB_DUPLICATE, id),
    showContextMenu: (id: TabId): void => ipcRenderer.send(Channels.TAB_CONTEXT_MENU, id),
    openPrivateWindow: (): Promise<void> => ipcRenderer.invoke(Channels.OPEN_PRIVATE_WINDOW),
    isPrivateMode: (): Promise<boolean> => ipcRenderer.invoke(Channels.IS_PRIVATE_MODE),
    pin: (id: TabId): Promise<void> => ipcRenderer.invoke(Channels.TAB_PIN, id),
    unpin: (id: TabId): Promise<void> => ipcRenderer.invoke(Channels.TAB_UNPIN, id),
    createGroup: (id: TabId): Promise<TabGroupId | null> =>
      ipcRenderer.invoke(Channels.TAB_GROUP_CREATE, id),
    addToGroup: (id: TabId, groupId: TabGroupId): Promise<void> =>
      ipcRenderer.invoke(Channels.TAB_GROUP_ADD_TAB, id, groupId),
    removeFromGroup: (id: TabId): Promise<void> =>
      ipcRenderer.invoke(Channels.TAB_GROUP_REMOVE_TAB, id),
    toggleGroupCollapsed: (groupId: TabGroupId): Promise<boolean | null> =>
      ipcRenderer.invoke(Channels.TAB_GROUP_TOGGLE_COLLAPSED, groupId),
    setGroupColor: (groupId: TabGroupId, color: TabGroupColor): Promise<void> =>
      ipcRenderer.invoke(Channels.TAB_GROUP_SET_COLOR, groupId, color),
    showGroupContextMenu: (groupId: TabGroupId): void =>
      ipcRenderer.send(Channels.TAB_GROUP_CONTEXT_MENU, groupId),
    toggleMute: (id: TabId): Promise<boolean | null> =>
      ipcRenderer.invoke(Channels.TAB_TOGGLE_MUTE, id),
    print: (id: TabId): Promise<void> => ipcRenderer.invoke(Channels.TAB_PRINT, id),
    printToPdf: (id: TabId): Promise<string | null> =>
      ipcRenderer.invoke(Channels.TAB_PRINT_TO_PDF, id),
    openNewWindow: (): Promise<void> => ipcRenderer.invoke(Channels.OPEN_NEW_WINDOW),
    getState: (): Promise<{ tabs: TabState[]; activeId: string }> =>
      ipcRenderer.invoke(Channels.TAB_STATE_GET),
    onStateUpdate: (cb: (tabs: TabState[], activeId: string) => void): (() => void) => {
      const handler = (_: unknown, tabs: TabState[], activeId: string) => cb(tabs, activeId);
      ipcRenderer.on(Channels.TAB_STATE_UPDATE, handler);
      return () => ipcRenderer.removeListener(Channels.TAB_STATE_UPDATE, handler);
    },
  },
  ai: {
    query: (prompt: string, history?: AIMessage[], conversationId?: string, chatId?: string) =>
      ipcRenderer.invoke<
        | { accepted: true; conversationId: string; chatId: string }
        | { accepted: false; reason: "busy" }
      >(Channels.AI_QUERY, prompt, history, conversationId, chatId),
    onStreamStart: (cb: (prompt: string) => void): (() => void) => {
      const handler = (_: unknown, prompt: string) => cb(prompt);
      ipcRenderer.on(Channels.AI_STREAM_START, handler);
      return () => ipcRenderer.removeListener(Channels.AI_STREAM_START, handler);
    },
    onStreamChunk: (cb: (chunk: string) => void): (() => void) => {
      const handler = (_: unknown, chunk: string) => cb(chunk);
      ipcRenderer.on(Channels.AI_STREAM_CHUNK, handler);
      return () => ipcRenderer.removeListener(Channels.AI_STREAM_CHUNK, handler);
    },
    onStreamEnd: (cb: (status: "completed" | "failed") => void): (() => void) => {
      const handler = (_: unknown, status: "completed" | "failed" = "completed") => cb(status);
      ipcRenderer.on(Channels.AI_STREAM_END, handler);
      return () => ipcRenderer.removeListener(Channels.AI_STREAM_END, handler);
    },
    onStreamIdle: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on(Channels.AI_STREAM_IDLE, handler);
      return () => ipcRenderer.removeListener(Channels.AI_STREAM_IDLE, handler);
    },
    onResearchClarification: (cb: (payload: ResearchClarification) => void): (() => void) => {
      const handler = (_: unknown, payload: ResearchClarification) => cb(payload);
      ipcRenderer.on(Channels.AI_RESEARCH_CLARIFICATION, handler);
      return () => ipcRenderer.removeListener(Channels.AI_RESEARCH_CLARIFICATION, handler);
    },
    onAutomationActivityStart: (cb: (entry: AutomationActivityEntry) => void): (() => void) => {
      const handler = (_: unknown, entry: AutomationActivityEntry) => cb(entry);
      ipcRenderer.on(Channels.AUTOMATION_ACTIVITY_START, handler);
      return () => ipcRenderer.removeListener(Channels.AUTOMATION_ACTIVITY_START, handler);
    },
    onAutomationActivityChunk: (
      cb: (payload: { id: string; chunk: string }) => void,
    ): (() => void) => {
      const handler = (_: unknown, payload: { id: string; chunk: string }) => cb(payload);
      ipcRenderer.on(Channels.AUTOMATION_ACTIVITY_CHUNK, handler);
      return () => ipcRenderer.removeListener(Channels.AUTOMATION_ACTIVITY_CHUNK, handler);
    },
    onAutomationActivityEnd: (
      cb: (payload: { id: string; status: "completed" | "failed"; finishedAt: string }) => void,
    ): (() => void) => {
      const handler = (
        _: unknown,
        payload: {
          id: string;
          status: "completed" | "failed";
          finishedAt: string;
        },
      ) => cb(payload);
      ipcRenderer.on(Channels.AUTOMATION_ACTIVITY_END, handler);
      return () => ipcRenderer.removeListener(Channels.AUTOMATION_ACTIVITY_END, handler);
    },
    cancel: () => ipcRenderer.invoke(Channels.AI_CANCEL),
    fetchModels: (config: ProviderConfig): Promise<ProviderModelsResult> =>
      ipcRenderer.invoke(Channels.AI_FETCH_MODELS, config),
    getRuntime: (): Promise<AgentRuntimeState> => ipcRenderer.invoke(Channels.AGENT_RUNTIME_GET),
    onRuntimeUpdate: (cb: (state: AgentRuntimeState) => void): (() => void) => {
      const handler = (_: unknown, state: AgentRuntimeState) => cb(state);
      ipcRenderer.on(Channels.AGENT_RUNTIME_UPDATE, handler);
      return () => ipcRenderer.removeListener(Channels.AGENT_RUNTIME_UPDATE, handler);
    },
    pause: (): Promise<AgentRuntimeState> => ipcRenderer.invoke(Channels.AGENT_PAUSE),
    resume: (): Promise<AgentRuntimeState> => ipcRenderer.invoke(Channels.AGENT_RESUME),
    setApprovalMode: (mode: ApprovalMode): Promise<AgentRuntimeState> =>
      ipcRenderer.invoke(Channels.AGENT_SET_APPROVAL_MODE, mode),
    resolveApproval: (
      approvalId: string,
      resolution: ApprovalResolution,
    ): Promise<AgentRuntimeState> =>
      ipcRenderer.invoke(Channels.AGENT_APPROVAL_RESOLVE, approvalId, resolution),
    createCheckpoint: (name?: string, note?: string): Promise<AgentCheckpoint> =>
      ipcRenderer.invoke(Channels.AGENT_CHECKPOINT_CREATE, name, note),
    restoreCheckpoint: (checkpointId: string): Promise<AgentCheckpoint | null> =>
      ipcRenderer.invoke(Channels.AGENT_CHECKPOINT_RESTORE, checkpointId),
    updateCheckpointNote: (checkpointId: string, note?: string): Promise<AgentCheckpoint | null> =>
      ipcRenderer.invoke(Channels.AGENT_CHECKPOINT_UPDATE_NOTE, checkpointId, note),
    undoLastAction: (): Promise<string | null> =>
      ipcRenderer.invoke(Channels.AGENT_UNDO_LAST_ACTION),
    captureSession: (note?: string): Promise<SessionSnapshot> =>
      ipcRenderer.invoke(Channels.AGENT_SESSION_CAPTURE, note),
    restoreSession: (snapshot?: SessionSnapshot | null): Promise<SessionSnapshot> =>
      ipcRenderer.invoke(Channels.AGENT_SESSION_RESTORE, snapshot),
    startTaskMemory: (goal: string): Promise<TaskMemory> =>
      ipcRenderer.invoke(Channels.AGENT_TASK_START, goal),
    updateTaskMemory: (patch: {
      nextStep?: string | null;
      facts?: Record<string, string>;
    }): Promise<TaskMemory | null> => ipcRenderer.invoke(Channels.AGENT_TASK_UPDATE, patch),
    addTaskNote: (text: string): Promise<TaskMemory | null> =>
      ipcRenderer.invoke(Channels.AGENT_TASK_NOTE, text),
    setTaskBlocker: (blocker?: string | null): Promise<TaskMemory | null> =>
      ipcRenderer.invoke(Channels.AGENT_TASK_BLOCKER, blocker),
    resolveTaskMemory: (summary?: string): Promise<TaskMemory | null> =>
      ipcRenderer.invoke(Channels.AGENT_TASK_RESOLVE, summary),
    abandonTaskMemory: (reason?: string): Promise<TaskMemory | null> =>
      ipcRenderer.invoke(Channels.AGENT_TASK_ABANDON, reason),
    clearTaskMemory: (): Promise<null> => ipcRenderer.invoke(Channels.AGENT_TASK_CLEAR),
  },
  runs: {
    list: (query?: RunListQuery): Promise<RunRecord[]> =>
      ipcRenderer.invoke(Channels.RUN_LIST, query),
    get: (runId: string): Promise<RunDetail | null> => ipcRenderer.invoke(Channels.RUN_GET, runId),
    delete: (runId: string): Promise<boolean> => ipcRenderer.invoke(Channels.RUN_DELETE, runId),
    export: (runId: string, format: "json" | "markdown"): Promise<{ filePath: string } | null> =>
      ipcRenderer.invoke(Channels.RUN_EXPORT, runId, format),
    onUpdate: (cb: (runs: RunRecord[]) => void): (() => void) => {
      const handler = (_: unknown, runs: RunRecord[]) => cb(runs);
      ipcRenderer.on(Channels.RUN_UPDATE, handler);
      return () => ipcRenderer.removeListener(Channels.RUN_UPDATE, handler);
    },
  },
  conversations: {
    list: (): Promise<ConversationThreadSummary[]> =>
      ipcRenderer.invoke(Channels.CONVERSATION_LIST),
    get: (threadId: string): Promise<ConversationThread | null> =>
      ipcRenderer.invoke(Channels.CONVERSATION_GET, threadId),
    create: (input: CreateConversationInput): Promise<ConversationThread> =>
      ipcRenderer.invoke(Channels.CONVERSATION_CREATE, input),
    createChat: (
      threadId: string,
      input: CreateConversationChatInput = {},
    ): Promise<ConversationChat | null> =>
      ipcRenderer.invoke(Channels.CONVERSATION_CHAT_CREATE, threadId, input),
    renameChat: (
      threadId: string,
      chatId: string,
      title: string,
    ): Promise<ConversationChat | null> =>
      ipcRenderer.invoke(Channels.CONVERSATION_CHAT_RENAME, threadId, chatId, title),
    rename: (threadId: string, title: string): Promise<ConversationThread | null> =>
      ipcRenderer.invoke(Channels.CONVERSATION_RENAME, threadId, title),
    archive: (threadId: string): Promise<ConversationThread | null> =>
      ipcRenderer.invoke(Channels.CONVERSATION_ARCHIVE, threadId),
    delete: (threadId: string): Promise<boolean> =>
      ipcRenderer.invoke(Channels.CONVERSATION_DELETE, threadId),
    appendMessage: (
      threadId: string,
      chatId: string,
      message: Omit<ConversationMessage, "id" | "createdAt">,
    ): Promise<ConversationMessage | null> =>
      ipcRenderer.invoke(Channels.CONVERSATION_MESSAGE_APPEND, threadId, chatId, message),
    onUpdate: (cb: (threads: ConversationThreadSummary[]) => void): (() => void) => {
      const handler = (_: unknown, threads: ConversationThreadSummary[]) => cb(threads);
      ipcRenderer.on(Channels.CONVERSATION_UPDATE, handler);
      return () => ipcRenderer.removeListener(Channels.CONVERSATION_UPDATE, handler);
    },
  },
  policies: {
    list: (): Promise<PolicyRule[]> => ipcRenderer.invoke(Channels.POLICY_LIST),
    add: (input: AddPolicyRuleInput): Promise<PolicyRule> =>
      ipcRenderer.invoke(Channels.POLICY_ADD, input),
    remove: (ruleId: string): Promise<boolean> =>
      ipcRenderer.invoke(Channels.POLICY_REMOVE, ruleId),
    evaluate: (
      input: PolicyEvaluationInput,
      approvalMode: ApprovalMode,
      hardDenyReason?: string | null,
    ): Promise<PolicyEvaluation> =>
      ipcRenderer.invoke(Channels.POLICY_EVALUATE, { input, approvalMode, hardDenyReason }),
    onUpdate: (cb: (rules: PolicyRule[]) => void): (() => void) => {
      const handler = (_: unknown, rules: PolicyRule[]) => cb(rules);
      ipcRenderer.on(Channels.POLICY_UPDATE, handler);
      return () => ipcRenderer.removeListener(Channels.POLICY_UPDATE, handler);
    },
  },
  research: {
    getState: (): Promise<ResearchState> => ipcRenderer.invoke(Channels.RESEARCH_STATE_GET),
    onStateUpdate: (cb: (state: ResearchState) => void): (() => void) => {
      const handler = (_: unknown, state: ResearchState) => cb(state);
      ipcRenderer.on(Channels.RESEARCH_STATE_UPDATE, handler);
      return () => ipcRenderer.removeListener(Channels.RESEARCH_STATE_UPDATE, handler);
    },
    startBrief: (query: string) =>
      ipcRenderer.invoke<{ accepted: true } | { accepted: false; reason: "busy" | "error" }>(
        Channels.RESEARCH_START_BRIEF,
        query,
      ),
    confirmBrief: () =>
      ipcRenderer.invoke<{ accepted: true } | { accepted: false; reason: "premium" | "error" }>(
        Channels.RESEARCH_CONFIRM_BRIEF,
      ),
    approveObjectives: (options?: {
      supervisionMode?: "walk-away" | "interactive";
      includeTraces?: boolean;
    }) =>
      ipcRenderer.invoke<{ accepted: true } | { accepted: false; reason: "premium" | "error" }>(
        Channels.RESEARCH_APPROVE_OBJECTIVES,
        options ?? {},
      ),
    setMode: (mode: "walk-away" | "interactive") =>
      ipcRenderer.invoke(Channels.RESEARCH_SET_MODE, mode),
    setTraces: (include: boolean) => ipcRenderer.invoke(Channels.RESEARCH_SET_TRACES, include),
    cancel: () => ipcRenderer.invoke(Channels.RESEARCH_CANCEL),
    stopAndSynthesize: () => ipcRenderer.invoke(Channels.RESEARCH_STOP_AND_SYNTHESIZE),
    exportReport: () =>
      ipcRenderer.invoke<
        | { accepted: true; savedPath: string }
        | { accepted: false; reason: "premium" | "error" | "cancelled"; error?: string }
      >(Channels.RESEARCH_EXPORT_REPORT),
  },
  content: {
    extract: () => ipcRenderer.invoke(Channels.CONTENT_EXTRACT),
    toggleReader: () => ipcRenderer.invoke(Channels.READER_MODE_TOGGLE),
  },
  highlights: {
    capture: (): Promise<{
      success: boolean;
      text?: string;
      message?: string;
    }> => ipcRenderer.invoke(Channels.HIGHLIGHT_CAPTURE),
    onCaptureResult: (
      cb: (result: { success: boolean; text?: string; message?: string }) => void,
    ): (() => void) => {
      const handler = (_: unknown, result: { success: boolean; text?: string; message?: string }) =>
        cb(result);
      ipcRenderer.on(Channels.HIGHLIGHT_CAPTURE_RESULT, handler);
      return () => ipcRenderer.removeListener(Channels.HIGHLIGHT_CAPTURE_RESULT, handler);
    },
    getCount: (): Promise<number> => ipcRenderer.invoke(Channels.HIGHLIGHT_NAV_COUNT),
    onCountUpdate: (cb: (count: number) => void): (() => void) => {
      const handler = (_: unknown, count: number) => cb(count);
      ipcRenderer.on(Channels.HIGHLIGHT_COUNT_UPDATE, handler);
      return () => ipcRenderer.removeListener(Channels.HIGHLIGHT_COUNT_UPDATE, handler);
    },
    scrollTo: (index: number): Promise<boolean> =>
      ipcRenderer.invoke(Channels.HIGHLIGHT_NAV_SCROLL, index),
    remove: (index: number): Promise<boolean> =>
      ipcRenderer.invoke(Channels.HIGHLIGHT_NAV_REMOVE, index),
    clearAll: (): Promise<boolean> => ipcRenderer.invoke(Channels.HIGHLIGHT_NAV_CLEAR),
    onSidebarAction: (cb: (action: "remove-current" | "clear-all") => void): (() => void) => {
      const handler = (_: unknown, action: "remove-current" | "clear-all") => cb(action);
      ipcRenderer.on(Channels.SIDEBAR_HIGHLIGHT_ACTION, handler);
      return () => ipcRenderer.removeListener(Channels.SIDEBAR_HIGHLIGHT_ACTION, handler);
    },
  },
  ui: {
    toggleSidebar: () => ipcRenderer.invoke(Channels.SIDEBAR_TOGGLE),
    openSidebarTab: (tab: string) => ipcRenderer.invoke(Channels.SIDEBAR_NAVIGATE, tab),
    startSidebarResize: () => ipcRenderer.invoke(Channels.SIDEBAR_RESIZE_START),
    resizeSidebar: (width: number) => ipcRenderer.invoke(Channels.SIDEBAR_RESIZE, width),
    commitSidebarResize: () => ipcRenderer.invoke(Channels.SIDEBAR_RESIZE_COMMIT),
    popOutSidebar: () => ipcRenderer.invoke(Channels.SIDEBAR_POPOUT),
    dockSidebar: () => ipcRenderer.invoke(Channels.SIDEBAR_DOCK),
    rendererReady: (view: "chrome" | "sidebar" | "devtools") =>
      ipcRenderer.send(Channels.RENDERER_VIEW_READY, view),
    onSidebarContextMenu: (cb: (position: { x: number; y: number }) => void): (() => void) => {
      const handler = (_: unknown, position: { x: number; y: number }) => cb(position);
      ipcRenderer.on(Channels.SIDEBAR_CONTEXT_MENU, handler);
      return () => ipcRenderer.removeListener(Channels.SIDEBAR_CONTEXT_MENU, handler);
    },
    onSidebarNavigate: (cb: (tab: string) => void): (() => void) => {
      const handler = (_: unknown, tab: string) => cb(tab);
      ipcRenderer.on(Channels.SIDEBAR_NAVIGATE, handler);
      return () => ipcRenderer.removeListener(Channels.SIDEBAR_NAVIGATE, handler);
    },
    onSidebarStateUpdate: (cb: (state: SidebarPanelState) => void): (() => void) => {
      const handler = (_: unknown, state: SidebarPanelState) => cb(state);
      ipcRenderer.on(Channels.SIDEBAR_STATE_UPDATE, handler);
      return () => ipcRenderer.removeListener(Channels.SIDEBAR_STATE_UPDATE, handler);
    },
    toggleFocusMode: () => ipcRenderer.invoke(Channels.FOCUS_MODE_TOGGLE),
    setSettingsVisibility: (open: boolean) =>
      ipcRenderer.invoke(Channels.SETTINGS_VISIBILITY, open),
  },
  settings: {
    get: () => ipcRenderer.invoke(Channels.SETTINGS_GET),
    getHealth: (): Promise<RuntimeHealthState> => ipcRenderer.invoke(Channels.SETTINGS_HEALTH_GET),
    regenerateMcpToken: (): Promise<{ endpoint: string } | null> =>
      ipcRenderer.invoke(Channels.MCP_REGENERATE_TOKEN),
    onHealthUpdate: (cb: (health: RuntimeHealthState) => void): (() => void) => {
      const handler = (_: unknown, health: RuntimeHealthState) => cb(health);
      ipcRenderer.on(Channels.SETTINGS_HEALTH_UPDATE, handler);
      return () => ipcRenderer.removeListener(Channels.SETTINGS_HEALTH_UPDATE, handler);
    },
    set: <K extends RendererSettableSettingKey>(
      key: K,
      value: RendererSettableSettings[K],
    ): Promise<VesselSettings> => ipcRenderer.invoke(Channels.SETTINGS_SET, key, value),
    onUpdate: (cb: (settings: VesselSettings) => void): (() => void) => {
      const handler = (_: unknown, settings: VesselSettings) => cb(settings);
      ipcRenderer.on(Channels.SETTINGS_UPDATE, handler);
      return () => ipcRenderer.removeListener(Channels.SETTINGS_UPDATE, handler);
    },
  },
  support: {
    submitFeedback: (email: string, message: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(Channels.SUPPORT_SUBMIT_FEEDBACK, email, message),
  },
  bookmarks: {
    get: (): Promise<BookmarksState> => ipcRenderer.invoke(Channels.BOOKMARKS_GET),
    saveBookmark: (
      url: string,
      title: string,
      folderId?: string,
      note?: string,
      intent?: string,
      expectedContent?: string,
      keyFields?: string[],
      agentHints?: Record<string, string>,
    ): Promise<Bookmark> =>
      ipcRenderer.invoke(
        Channels.BOOKMARK_SAVE,
        url,
        title,
        folderId,
        note,
        intent,
        expectedContent,
        keyFields,
        agentHints,
      ),
    updateBookmark: (
      id: string,
      updates: {
        title?: string;
        note?: string;
        folderId?: string;
        intent?: string;
        expectedContent?: string;
        keyFields?: string[];
        agentHints?: Record<string, string>;
      },
    ): Promise<Bookmark | null> => ipcRenderer.invoke(Channels.BOOKMARK_UPDATE, id, updates),
    removeBookmark: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(Channels.BOOKMARK_REMOVE, id),
    exportHtml: (options?: BookmarkHtmlExportOptions): Promise<BookmarkExportResult | null> =>
      ipcRenderer.invoke(Channels.BOOKMARKS_EXPORT_HTML, options),
    exportJson: (): Promise<BookmarkExportResult | null> =>
      ipcRenderer.invoke(Channels.BOOKMARKS_EXPORT_JSON),
    exportFolderHtml: (
      folderId: string,
      options?: BookmarkHtmlExportOptions,
    ): Promise<BookmarkExportResult | null> =>
      ipcRenderer.invoke(Channels.FOLDER_EXPORT_HTML, folderId, options),
    importHtml: (): Promise<ImportResult | null> =>
      ipcRenderer.invoke(Channels.BOOKMARKS_IMPORT_HTML),
    importJson: (): Promise<ImportResult | null> =>
      ipcRenderer.invoke(Channels.BOOKMARKS_IMPORT_JSON),
    createFolder: (name: string): Promise<BookmarkFolder> =>
      ipcRenderer.invoke(Channels.FOLDER_CREATE, name),
    createFolderWithSummary: (name: string, summary?: string): Promise<BookmarkFolder> =>
      ipcRenderer.invoke(Channels.FOLDER_CREATE, name, summary),
    removeFolder: (id: string, deleteContents?: boolean): Promise<boolean> =>
      ipcRenderer.invoke(Channels.FOLDER_REMOVE, id, deleteContents),
    renameFolder: (id: string, newName: string, summary?: string): Promise<BookmarkFolder | null> =>
      ipcRenderer.invoke(Channels.FOLDER_RENAME, id, newName, summary),
    onAddContextToChat: (cb: (bookmarkId: string) => void): (() => void) => {
      const handler = (_: unknown, bookmarkId: string) => cb(bookmarkId);
      ipcRenderer.on(Channels.BOOKMARK_ADD_CONTEXT_TO_CHAT, handler);
      return () => ipcRenderer.removeListener(Channels.BOOKMARK_ADD_CONTEXT_TO_CHAT, handler);
    },
    onUpdate: (cb: (state: BookmarksState) => void): (() => void) => {
      const handler = (_: unknown, state: BookmarksState) => cb(state);
      ipcRenderer.on(Channels.BOOKMARKS_UPDATE, handler);
      return () => ipcRenderer.removeListener(Channels.BOOKMARKS_UPDATE, handler);
    },
  },
  devtoolsPanel: {
    toggle: (): Promise<DevToolsPanelHostState> =>
      ipcRenderer.invoke(Channels.DEVTOOLS_PANEL_TOGGLE),
    close: (): Promise<DevToolsPanelHostState> => ipcRenderer.invoke(Channels.DEVTOOLS_PANEL_CLOSE),
    openTab: (tab: DevToolsPanelTab): Promise<DevToolsPanelHostState> =>
      ipcRenderer.invoke(Channels.DEVTOOLS_PANEL_OPEN_TAB, tab),
    startResize: (): Promise<void> => ipcRenderer.invoke(Channels.DEVTOOLS_PANEL_RESIZE_START),
    resize: (height: number): Promise<number> =>
      ipcRenderer.invoke(Channels.DEVTOOLS_PANEL_RESIZE, height),
    commitResize: (): Promise<void> => ipcRenderer.invoke(Channels.DEVTOOLS_PANEL_RESIZE_COMMIT),
    popOut: (): Promise<DevToolsPanelHostState> =>
      ipcRenderer.invoke(Channels.DEVTOOLS_PANEL_POPOUT),
    dock: (): Promise<DevToolsPanelHostState> => ipcRenderer.invoke(Channels.DEVTOOLS_PANEL_DOCK),
    getState: (): Promise<DevToolsPanelState> =>
      ipcRenderer.invoke(Channels.DEVTOOLS_PANEL_STATE_GET),
    getHostState: (): Promise<DevToolsPanelHostState> =>
      ipcRenderer.invoke(Channels.DEVTOOLS_PANEL_HOST_STATE_GET),
    revealElement: (selector: string): Promise<DevToolsPageMapRevealStatus> =>
      ipcRenderer.invoke(Channels.DEVTOOLS_PAGE_MAP_REVEAL, { selector }),
    onStateUpdate: (cb: (state: DevToolsPanelState) => void): (() => void) => {
      const handler = (_: unknown, state: DevToolsPanelState) => cb(state);
      ipcRenderer.on(Channels.DEVTOOLS_PANEL_STATE, handler);
      return () => ipcRenderer.removeListener(Channels.DEVTOOLS_PANEL_STATE, handler);
    },
    onHostStateUpdate: (cb: (state: DevToolsPanelHostState) => void): (() => void) => {
      const handler = (_: unknown, state: DevToolsPanelHostState) => cb(state);
      ipcRenderer.on(Channels.DEVTOOLS_PANEL_HOST_STATE, handler);
      return () => ipcRenderer.removeListener(Channels.DEVTOOLS_PANEL_HOST_STATE, handler);
    },
    onSelectTab: (cb: (tab: DevToolsPanelTab) => void): (() => void) => {
      const handler = (_: unknown, tab: DevToolsPanelTab) => cb(tab);
      ipcRenderer.on(Channels.DEVTOOLS_PANEL_SELECT_TAB, handler);
      return () => ipcRenderer.removeListener(Channels.DEVTOOLS_PANEL_SELECT_TAB, handler);
    },
  },
  find: {
    start: (text: string, options?: FindInPageOptions): Promise<void> =>
      ipcRenderer.invoke(Channels.FIND_IN_PAGE_START, text, options),
    next: (forward?: boolean): Promise<void> =>
      ipcRenderer.invoke(Channels.FIND_IN_PAGE_NEXT, forward),
    stop: (action?: FindInPageStopAction): Promise<void> =>
      ipcRenderer.invoke(Channels.FIND_IN_PAGE_STOP, action),
    onResult: (cb: (result: FindInPageResult) => void): (() => void) => {
      const handler = (_: unknown, result: FindInPageResult) => cb(result);
      ipcRenderer.on(Channels.FIND_IN_PAGE_RESULT, handler);
      return () => ipcRenderer.removeListener(Channels.FIND_IN_PAGE_RESULT, handler);
    },
  },
  history: {
    get: (): Promise<HistoryState> => ipcRenderer.invoke(Channels.HISTORY_GET),
    list: (offset?: number, limit?: number): Promise<HistoryPage> =>
      ipcRenderer.invoke(Channels.HISTORY_LIST, offset, limit),
    search: (query: string) => ipcRenderer.invoke(Channels.HISTORY_SEARCH, query),
    clear: () => ipcRenderer.invoke(Channels.HISTORY_CLEAR),
    exportHtml: (): Promise<{ filePath: string; count: number } | null> =>
      ipcRenderer.invoke(Channels.HISTORY_EXPORT_HTML),
    exportJson: (): Promise<{ filePath: string; count: number } | null> =>
      ipcRenderer.invoke(Channels.HISTORY_EXPORT_JSON),
    importFile: (): Promise<ImportResult | null> => ipcRenderer.invoke(Channels.HISTORY_IMPORT),
    onUpdate: (cb: (state: HistoryPage) => void): (() => void) => {
      const handler = (_: unknown, state: HistoryPage) => cb(state);
      ipcRenderer.on(Channels.HISTORY_UPDATE, handler);
      return () => ipcRenderer.removeListener(Channels.HISTORY_UPDATE, handler);
    },
  },
  premium: {
    getState: (): Promise<PremiumState> => ipcRenderer.invoke(Channels.PREMIUM_GET_STATE),
    requestCode: (
      email: string,
    ): Promise<{ ok: boolean; email?: string; challengeToken?: string; error?: string }> =>
      ipcRenderer.invoke(Channels.PREMIUM_ACTIVATION_START, email),
    verifyCode: (
      email: string,
      code: string,
      challengeToken: string,
    ): Promise<{ ok: boolean; state: PremiumState; error?: string }> =>
      ipcRenderer.invoke(Channels.PREMIUM_ACTIVATION_VERIFY, email, code, challengeToken),
    checkout: (email?: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(Channels.PREMIUM_CHECKOUT, email),
    portal: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(Channels.PREMIUM_PORTAL),
    reset: (): Promise<PremiumState> => ipcRenderer.invoke(Channels.PREMIUM_RESET),
    trackContext: (
      step:
        | "chat_banner_viewed"
        | "chat_banner_clicked"
        | "settings_banner_viewed"
        | "settings_banner_clicked"
        | "welcome_banner_clicked"
        | "premium_gate_seen"
        | "premium_gate_clicked"
        | "iteration_limit_seen"
        | "iteration_limit_clicked",
    ): Promise<void> => ipcRenderer.invoke(Channels.PREMIUM_TRACK_CONTEXT, step),
    onUpdate: (cb: (state: PremiumState) => void): (() => void) => {
      const handler = (_: unknown, state: PremiumState) => cb(state);
      ipcRenderer.on(Channels.PREMIUM_UPDATE, handler);
      return () => ipcRenderer.removeListener(Channels.PREMIUM_UPDATE, handler);
    },
  },
  sessions: {
    list: (): Promise<
      Array<{
        name: string;
        createdAt: string;
        updatedAt: string;
        cookieCount: number;
        originCount: number;
        domains: string[];
      }>
    > => ipcRenderer.invoke(Channels.SESSION_LIST),
    save: (
      name: string,
    ): Promise<{
      name: string;
      createdAt: string;
      updatedAt: string;
      cookieCount: number;
      originCount: number;
      domains: string[];
    }> => ipcRenderer.invoke(Channels.SESSION_SAVE, name),
    load: (
      name: string,
    ): Promise<{
      name: string;
      createdAt: string;
      updatedAt: string;
      cookieCount: number;
      originCount: number;
      domains: string[];
    }> => ipcRenderer.invoke(Channels.SESSION_LOAD, name),
    delete: (name: string): Promise<boolean> => ipcRenderer.invoke(Channels.SESSION_DELETE, name),
  },
  vault: {
    list: (): Promise<
      Array<{
        id: string;
        label: string;
        domainPattern: string;
        username: string;
        notes?: string;
        createdAt: string;
        lastUsedAt?: string;
        useCount: number;
      }>
    > => ipcRenderer.invoke(Channels.VAULT_LIST),
    add: (entry: {
      label: string;
      domainPattern: string;
      username: string;
      password: string;
      totpSecret?: string;
      notes?: string;
    }): Promise<{ id: string; label: string; domainPattern: string; username: string }> =>
      ipcRenderer.invoke(Channels.VAULT_ADD, entry),
    update: (
      id: string,
      updates: {
        label?: string;
        domainPattern?: string;
        username?: string;
        password?: string;
        totpSecret?: string;
        notes?: string;
      },
    ): Promise<boolean> => ipcRenderer.invoke(Channels.VAULT_UPDATE, id, updates),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke(Channels.VAULT_REMOVE, id),
    auditLog: (
      limit?: number,
    ): Promise<
      Array<{
        timestamp: string;
        credentialLabel: string;
        domain: string;
        action: string;
        approved: boolean;
      }>
    > => ipcRenderer.invoke(Channels.VAULT_AUDIT_LOG, limit),
  },
  humanVault: {
    list: (domain?: string) => ipcRenderer.invoke(Channels.HUMAN_VAULT_LIST, domain),
    get: (id: string) => ipcRenderer.invoke(Channels.HUMAN_VAULT_GET, id),
    save: (entry: {
      title: string;
      url: string;
      username: string;
      password: string;
      notes?: string;
      category?: string;
      tags?: string[];
    }) => ipcRenderer.invoke(Channels.HUMAN_VAULT_SAVE, entry),
    update: (
      id: string,
      updates: {
        title?: string;
        url?: string;
        username?: string;
        password?: string;
        notes?: string;
        category?: string;
        tags?: string[];
      },
    ) => ipcRenderer.invoke(Channels.HUMAN_VAULT_UPDATE, id, updates),
    remove: (id: string) => ipcRenderer.invoke(Channels.HUMAN_VAULT_REMOVE, id),
    auditLog: (limit?: number) => ipcRenderer.invoke(Channels.HUMAN_VAULT_AUDIT_LOG, limit),
  },
  automation: {
    getInstalled: (): Promise<AutomationKit[]> =>
      ipcRenderer.invoke(Channels.AUTOMATION_GET_INSTALLED),
    installFromFile: (): Promise<{ ok: boolean; kit?: AutomationKit; error?: string }> =>
      ipcRenderer.invoke(Channels.AUTOMATION_INSTALL_FROM_FILE),
    createFromText: (
      source: string,
    ): Promise<{ ok: boolean; kit?: AutomationKit; error?: string }> =>
      ipcRenderer.invoke(Channels.AUTOMATION_CREATE_FROM_TEXT, source),
    updateFromText: (
      id: string,
      source: string,
    ): Promise<{ ok: boolean; kit?: AutomationKit; error?: string }> =>
      ipcRenderer.invoke(Channels.AUTOMATION_UPDATE_FROM_TEXT, id, source),
    uninstall: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(Channels.AUTOMATION_UNINSTALL, id),
  },
  schedule: {
    getAll: (): Promise<ScheduledJob[]> => ipcRenderer.invoke(Channels.SCHEDULE_GET_ALL),
    create: (job: Omit<ScheduledJob, "id" | "createdAt" | "nextRunAt">): Promise<ScheduledJob> =>
      ipcRenderer.invoke(Channels.SCHEDULE_CREATE, job),
    update: (
      id: string,
      updates: Partial<
        Pick<ScheduledJob, "enabled" | "schedule" | "renderedPrompt" | "fieldValues">
      >,
    ): Promise<ScheduledJob | null> => ipcRenderer.invoke(Channels.SCHEDULE_UPDATE, id, updates),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke(Channels.SCHEDULE_DELETE, id),
    onJobsUpdate: (cb: (jobs: ScheduledJob[]) => void): (() => void) => {
      const handler = (_: unknown, updatedJobs: ScheduledJob[]) => cb(updatedJobs);
      ipcRenderer.on(Channels.SCHEDULE_JOBS_UPDATE, handler);
      return () => ipcRenderer.removeListener(Channels.SCHEDULE_JOBS_UPDATE, handler);
    },
  },
  window: {
    minimize: () => ipcRenderer.invoke(Channels.WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.invoke(Channels.WINDOW_MAXIMIZE),
    close: () => ipcRenderer.invoke(Channels.WINDOW_CLOSE),
  },
  autofill: {
    list: (): Promise<AutofillProfile[]> => ipcRenderer.invoke(Channels.AUTOFILL_LIST),
    add: (
      profile: Omit<AutofillProfile, "id" | "createdAt" | "updatedAt">,
    ): Promise<AutofillProfile> => ipcRenderer.invoke(Channels.AUTOFILL_ADD, profile),
    update: (
      id: string,
      updates: Partial<Omit<AutofillProfile, "id" | "createdAt">>,
    ): Promise<AutofillProfile | null> => ipcRenderer.invoke(Channels.AUTOFILL_UPDATE, id, updates),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke(Channels.AUTOFILL_DELETE, id),
    fill: (profileId: string): Promise<AutofillResult> =>
      ipcRenderer.invoke(Channels.AUTOFILL_FILL, profileId),
  },
  downloads: {
    getAll: (): Promise<DownloadRecord[]> => ipcRenderer.invoke(Channels.DOWNLOADS_GET),
    clear: (): Promise<boolean> => ipcRenderer.invoke(Channels.DOWNLOADS_CLEAR),
    open: (id: string): Promise<boolean> => ipcRenderer.invoke(Channels.DOWNLOADS_OPEN, id),
    showInFolder: (id: string): Promise<boolean> =>
      ipcRenderer.invoke(Channels.DOWNLOADS_SHOW_IN_FOLDER, id),
    onUpdate: (cb: (items: DownloadRecord[]) => void): (() => void) => {
      const handler = (_: unknown, items: DownloadRecord[]) => cb(items);
      ipcRenderer.on(Channels.DOWNLOADS_UPDATE, handler);
      return () => ipcRenderer.removeListener(Channels.DOWNLOADS_UPDATE, handler);
    },
    onStarted: (
      cb: (info: {
        filename: string;
        savePath: string;
        totalBytes: number;
        receivedBytes: number;
        state: string;
      }) => void,
    ): (() => void) => {
      const handler = (
        _: unknown,
        info: {
          filename: string;
          savePath: string;
          totalBytes: number;
          receivedBytes: number;
          state: string;
        },
      ) => cb(info);
      ipcRenderer.on(Channels.DOWNLOAD_STARTED, handler);
      return () => ipcRenderer.removeListener(Channels.DOWNLOAD_STARTED, handler);
    },
    onProgress: (
      cb: (info: {
        filename: string;
        savePath: string;
        totalBytes: number;
        receivedBytes: number;
        state: string;
      }) => void,
    ): (() => void) => {
      const handler = (
        _: unknown,
        info: {
          filename: string;
          savePath: string;
          totalBytes: number;
          receivedBytes: number;
          state: string;
        },
      ) => cb(info);
      ipcRenderer.on(Channels.DOWNLOAD_PROGRESS, handler);
      return () => ipcRenderer.removeListener(Channels.DOWNLOAD_PROGRESS, handler);
    },
    onDone: (
      cb: (info: {
        filename: string;
        savePath: string;
        totalBytes: number;
        receivedBytes: number;
        state: string;
      }) => void,
    ): (() => void) => {
      const handler = (
        _: unknown,
        info: {
          filename: string;
          savePath: string;
          totalBytes: number;
          receivedBytes: number;
          state: string;
        },
      ) => cb(info);
      ipcRenderer.on(Channels.DOWNLOAD_DONE, handler);
      return () => ipcRenderer.removeListener(Channels.DOWNLOAD_DONE, handler);
    },
  },
  pageDiff: {
    onChanged: (cb: (diff: PageDiff) => void): (() => void) => {
      const handler = (_: unknown, diff: PageDiff) => cb(diff);
      ipcRenderer.on(Channels.PAGE_CHANGED, handler);
      return () => ipcRenderer.removeListener(Channels.PAGE_CHANGED, handler);
    },
    get: (): Promise<PageDiff | null> => ipcRenderer.invoke(Channels.PAGE_DIFF_GET),
    getHistory: (): Promise<PageDiffHistoryItem[] | { error: string }> =>
      ipcRenderer.invoke(Channels.PAGE_DIFF_HISTORY),
  },
  security: {
    onStateUpdate: (cb: (tabId: string, state: SecurityState) => void): (() => void) => {
      const handler = (_: unknown, data: { tabId: string; state: SecurityState }) =>
        cb(data.tabId, data.state);
      ipcRenderer.on(Channels.SECURITY_STATE_UPDATE, handler);
      return () => ipcRenderer.removeListener(Channels.SECURITY_STATE_UPDATE, handler);
    },
    showDetails: (state: SecurityState): Promise<void> =>
      ipcRenderer.invoke(Channels.SECURITY_SHOW_DETAILS, state),
    proceedAnyway: (tabId: string): Promise<void> =>
      ipcRenderer.invoke(Channels.SECURITY_PROCEED_ANYWAY, tabId),
    goBackToSafety: (tabId: string): Promise<void> =>
      ipcRenderer.invoke(Channels.SECURITY_GO_BACK_TO_SAFETY, tabId),
  },
  updates: {
    check: (): Promise<UpdateCheckResult> => ipcRenderer.invoke(Channels.UPDATES_CHECK),
    openDownload: (): Promise<void> => ipcRenderer.invoke(Channels.UPDATES_OPEN_DOWNLOAD),
  },
  permissions: {
    getAll: (): Promise<PermissionRecord[]> => ipcRenderer.invoke(Channels.PERMISSIONS_GET),
    clear: (): Promise<boolean> => ipcRenderer.invoke(Channels.PERMISSIONS_CLEAR),
    clearOrigin: (origin: string): Promise<boolean> =>
      ipcRenderer.invoke(Channels.PERMISSIONS_CLEAR_ORIGIN, origin),
  },
  browsingData: {
    clear: (options: ClearDataOptions): Promise<void> =>
      ipcRenderer.invoke(Channels.CLEAR_BROWSING_DATA, options),
    onOpenDialog: (cb: () => void): (() => void) => {
      const handler = () => cb();
      ipcRenderer.on(Channels.CLEAR_BROWSING_DATA_OPEN, handler);
      return () => ipcRenderer.removeListener(Channels.CLEAR_BROWSING_DATA_OPEN, handler);
    },
  },
  pip: {
    toggle: (): Promise<boolean> => ipcRenderer.invoke(Channels.TAB_TOGGLE_PIP),
  },
  codex: {
    startAuth: (): Promise<
      { ok: true; accountEmail: string; accountId: string } | { ok: false; error: string }
    > => ipcRenderer.invoke(Channels.CODEX_START_AUTH),
    cancelAuth: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(Channels.CODEX_CANCEL_AUTH),
    disconnect: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(Channels.CODEX_DISCONNECT),
    onAuthStatus: (
      cb: (payload: { status: string; error: string | null }) => void,
    ): (() => void) => {
      const handler = (_: unknown, payload: { status: string; error: string | null }) =>
        cb(payload);
      ipcRenderer.on(Channels.CODEX_AUTH_STATUS, handler);
      return () => ipcRenderer.removeListener(Channels.CODEX_AUTH_STATUS, handler);
    },
  },
  openrouter: {
    startAuth: (): Promise<
      { ok: true; providerId: "openrouter"; model: string } | { ok: false; error: string }
    > => ipcRenderer.invoke(Channels.OPENROUTER_START_AUTH),
    cancelAuth: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(Channels.OPENROUTER_CANCEL_AUTH),
    onAuthStatus: (
      cb: (payload: { status: string; error: string | null }) => void,
    ): (() => void) => {
      const handler = (_: unknown, payload: { status: string; error: string | null }) =>
        cb(payload);
      ipcRenderer.on(Channels.OPENROUTER_AUTH_STATUS, handler);
      return () => ipcRenderer.removeListener(Channels.OPENROUTER_AUTH_STATUS, handler);
    },
  },
};

contextBridge.exposeInMainWorld("vessel", api);

export type VesselAPI = typeof api;
