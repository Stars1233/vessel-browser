export const RUN_SOURCES = ["chat", "mcp", "scheduled", "research"] as const;
export type RunSource = (typeof RUN_SOURCES)[number];

export const RUN_STATUSES = [
  "running",
  "waiting-approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export type TerminalRunStatus = Extract<
  RunStatus,
  "completed" | "failed" | "cancelled" | "interrupted"
>;

export const HISTORY_RETENTION_OPTIONS = [7, 30, 90, 180, 365, null] as const;
export type HistoryRetentionDays = (typeof HISTORY_RETENTION_OPTIONS)[number];

export function normalizeHistoryRetentionDays(value: unknown): HistoryRetentionDays {
  return HISTORY_RETENTION_OPTIONS.includes(value as HistoryRetentionDays)
    ? (value as HistoryRetentionDays)
    : 90;
}

export function isTerminalRunStatus(status: RunStatus): status is TerminalRunStatus {
  return status !== "running" && status !== "waiting-approval";
}

export type RunEventKind =
  | "run-started"
  | "run-completed"
  | "run-failed"
  | "run-cancelled"
  | "run-interrupted"
  | "action-started"
  | "action-waiting-approval"
  | "action-completed"
  | "action-failed"
  | "action-rejected"
  | "approval-requested"
  | "approval-resolved"
  | "human-steering"
  | "checkpoint-created"
  | "checkpoint-restored"
  | "output-appended"
  | "navigation";

export interface RunTabContext {
  tabId: string | null;
  title: string;
  url: string;
}

export interface RunEvent {
  id: string;
  runId: string;
  kind: RunEventKind;
  timestamp: string;
  summary: string;
  actionId?: string;
  actionName?: string;
  durationMs?: number;
  tab?: RunTabContext;
  metadata?: Record<string, unknown>;
}

export interface RunRecord {
  id: string;
  source: RunSource;
  title: string;
  goal: string;
  status: RunStatus;
  createdAt: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  initialTab: RunTabContext | null;
  finalTab: RunTabContext | null;
  outputSummary: string;
  error: string | null;
  lastCompletedAction: string | null;
  conversationId?: string;
  scheduledJobId?: string;
  researchId?: string;
  flowId?: string;
  checkpointId?: string;
  retryOfRunId?: string;
  resumeOfRunId?: string;
  parentRunId?: string;
}

export interface RunDetail extends RunRecord {
  events: RunEvent[];
}

export interface RunListQuery {
  statuses?: RunStatus[];
  sources?: RunSource[];
  limit?: number;
  offset?: number;
}

export interface RunStoreState {
  version: 1;
  runs: RunRecord[];
  events: RunEvent[];
  importedLegacyActions: boolean;
}

export interface StartRunInput {
  source: RunSource;
  title: string;
  goal: string;
  initialTab?: RunTabContext | null;
  conversationId?: string;
  scheduledJobId?: string;
  researchId?: string;
  flowId?: string;
  checkpointId?: string;
  retryOfRunId?: string;
  resumeOfRunId?: string;
  parentRunId?: string;
}

export interface FinishRunInput {
  status: TerminalRunStatus;
  outputSummary?: string;
  error?: string | null;
  finalTab?: RunTabContext | null;
}
