import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PersistentState } from "../persistence/persistent-state";
import type {
  FinishRunInput,
  HistoryRetentionDays,
  RunDetail,
  RunEvent,
  RunListQuery,
  RunRecord,
  RunStoreState,
  StartRunInput,
} from "../../shared/run-types";
import { isTerminalRunStatus } from "../../shared/run-types";
import { RUN_SOURCES, RUN_STATUSES } from "../../shared/run-types";
import { redactRunValue, summarizeRunOutput } from "./redaction";

interface RunManagerOptions {
  filename?: string;
  createId?: () => string;
  now?: () => Date;
}

type AppendRunEventInput = Omit<RunEvent, "id" | "runId" | "timestamp"> & {
  timestamp?: string;
};

const EMPTY_STATE: RunStoreState = {
  version: 1,
  runs: [],
  events: [],
  importedLegacyActions: false,
};

const RunTabContextSchema = z.object({
  tabId: z.string().nullable(),
  title: z.string(),
  url: z.string(),
});
const StoredRunRecordSchema = z.object({
  id: z.string().min(1),
  source: z.enum(RUN_SOURCES),
  title: z.string(),
  goal: z.string(),
  status: z.enum(RUN_STATUSES),
  createdAt: z.string().min(1),
  startedAt: z.string().min(1),
  updatedAt: z.string().min(1),
  finishedAt: z.string().nullable(),
  initialTab: RunTabContextSchema.nullable(),
  finalTab: RunTabContextSchema.nullable(),
  outputSummary: z.string(),
  error: z.string().nullable(),
  lastCompletedAction: z.string().nullable(),
  conversationId: z.string().optional(),
  scheduledJobId: z.string().optional(),
  researchId: z.string().optional(),
  flowId: z.string().optional(),
  checkpointId: z.string().optional(),
  retryOfRunId: z.string().optional(),
  resumeOfRunId: z.string().optional(),
  parentRunId: z.string().optional(),
});
const StoredRunEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  kind: z.enum([
    "run-started",
    "run-completed",
    "run-failed",
    "run-cancelled",
    "run-interrupted",
    "action-started",
    "action-waiting-approval",
    "action-completed",
    "action-failed",
    "action-rejected",
    "approval-requested",
    "approval-resolved",
    "human-steering",
    "checkpoint-created",
    "checkpoint-restored",
    "output-appended",
    "navigation",
  ]),
  timestamp: z.string().min(1),
  summary: z.string(),
  actionId: z.string().optional(),
  actionName: z.string().optional(),
  durationMs: z.number().optional(),
  tab: RunTabContextSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class RunManager {
  private readonly createId: () => string;
  private readonly now: () => Date;
  private readonly state: PersistentState<RunStoreState>;
  private unscopedMcpRun: { id: string; lastActivityAt: number } | null = null;

  constructor(options: RunManagerOptions = {}) {
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.state = new PersistentState<RunStoreState>({
      filename: options.filename ?? "vessel-runs.json",
      fallback: clone(EMPTY_STATE),
      parse: (raw) => this.parseStoredState(raw),
      logLabel: "runs",
      debounceMs: 150,
      resetOnSchedule: true,
      snapshot: clone,
    });
  }

  startRun(input: StartRunInput): RunRecord {
    const timestamp = this.now().toISOString();
    const run: RunRecord = {
      id: this.createId(),
      source: input.source,
      title: input.title.trim() || input.goal.trim() || "Untitled run",
      goal: input.goal.trim(),
      status: "running",
      createdAt: timestamp,
      startedAt: timestamp,
      updatedAt: timestamp,
      finishedAt: null,
      initialTab: input.initialTab ?? null,
      finalTab: null,
      outputSummary: "",
      error: null,
      lastCompletedAction: null,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.scheduledJobId ? { scheduledJobId: input.scheduledJobId } : {}),
      ...(input.researchId ? { researchId: input.researchId } : {}),
      ...(input.flowId ? { flowId: input.flowId } : {}),
      ...(input.checkpointId ? { checkpointId: input.checkpointId } : {}),
      ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      ...(input.resumeOfRunId ? { resumeOfRunId: input.resumeOfRunId } : {}),
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
    };
    const event: RunEvent = {
      id: this.createId(),
      runId: run.id,
      kind: "run-started",
      timestamp,
      summary: run.goal || run.title,
      ...(run.initialTab ? { tab: clone(run.initialTab) } : {}),
    };
    this.state.mutate((state) => {
      state.runs.push(run);
      state.events.push(event);
    });
    return clone(run);
  }

  appendEvent(runId: string, input: AppendRunEventInput): RunEvent | null {
    const timestamp = input.timestamp ?? this.now().toISOString();
    const event: RunEvent = {
      ...input,
      id: this.createId(),
      runId,
      timestamp,
      summary: summarizeRunOutput(input.summary),
      ...(input.metadata
        ? {
            metadata: redactRunValue(input.actionName ?? "event", input.metadata) as Record<
              string,
              unknown
            >,
          }
        : {}),
    };
    return this.state.mutate((state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (!run) return null;
      run.updatedAt = timestamp;
      if (input.kind === "action-completed" && input.actionName) {
        run.lastCompletedAction = input.actionName;
      }
      if (input.tab) run.finalTab = clone(input.tab);
      state.events.push(event);
      return clone(event);
    });
  }

  appendOutput(runId: string, chunk: string): RunRecord | null {
    const summary = summarizeRunOutput(chunk);
    return this.state.mutate((state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (!run) return null;
      run.outputSummary = summarizeRunOutput(`${run.outputSummary}${chunk}`);
      run.updatedAt = this.now().toISOString();
      state.events.push({
        id: this.createId(),
        runId,
        kind: "output-appended",
        timestamp: run.updatedAt,
        summary,
      });
      return clone(run);
    });
  }

  setWaitingApproval(runId: string, summary: string): RunRecord | null {
    const timestamp = this.now().toISOString();
    return this.state.mutate((state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (!run || isTerminalRunStatus(run.status)) return null;
      run.status = "waiting-approval";
      run.updatedAt = timestamp;
      state.events.push({
        id: this.createId(),
        runId,
        kind: "approval-requested",
        timestamp,
        summary: summarizeRunOutput(summary),
      });
      return clone(run);
    });
  }

  setRunning(runId: string, summary = "Execution resumed"): RunRecord | null {
    const timestamp = this.now().toISOString();
    return this.state.mutate((state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (!run || isTerminalRunStatus(run.status)) return null;
      run.status = "running";
      run.updatedAt = timestamp;
      state.events.push({
        id: this.createId(),
        runId,
        kind: "approval-resolved",
        timestamp,
        summary: summarizeRunOutput(summary),
      });
      return clone(run);
    });
  }

  finishRun(runId: string, input: FinishRunInput): RunRecord | null {
    const timestamp = this.now().toISOString();
    return this.state.mutate((state) => {
      const run = state.runs.find((candidate) => candidate.id === runId);
      if (!run) return null;
      run.status = input.status;
      run.updatedAt = timestamp;
      run.finishedAt = timestamp;
      run.finalTab = input.finalTab ?? run.finalTab;
      if (input.outputSummary !== undefined) {
        run.outputSummary = summarizeRunOutput(input.outputSummary);
      }
      run.error = input.error ? summarizeRunOutput(input.error) : null;
      const kind =
        input.status === "completed"
          ? "run-completed"
          : input.status === "cancelled"
            ? "run-cancelled"
            : input.status === "interrupted"
              ? "run-interrupted"
              : "run-failed";
      state.events.push({
        id: this.createId(),
        runId,
        kind,
        timestamp,
        summary: run.error || run.outputSummary || input.status,
        ...(run.finalTab ? { tab: clone(run.finalTab) } : {}),
      });
      if (this.unscopedMcpRun?.id === runId) this.unscopedMcpRun = null;
      return clone(run);
    });
  }

  getRun(runId: string): RunDetail | null {
    const state = this.state.getState();
    const run = state.runs.find((candidate) => candidate.id === runId);
    if (!run) return null;
    return {
      ...clone(run),
      events: state.events
        .filter((event) => event.runId === runId)
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
        .map(clone),
    };
  }

  listRuns(query: RunListQuery = {}): RunRecord[] {
    const statuses = query.statuses ? new Set(query.statuses) : null;
    const sources = query.sources ? new Set(query.sources) : null;
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.max(1, Math.min(query.limit ?? 200, 1000));
    return this.state
      .getState()
      .runs.filter(
        (run) => (!statuses || statuses.has(run.status)) && (!sources || sources.has(run.source)),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(offset, offset + limit)
      .map(clone);
  }

  deleteRun(runId: string): boolean {
    return this.state.mutate((state) => {
      const before = state.runs.length;
      state.runs = state.runs.filter((run) => run.id !== runId);
      if (state.runs.length === before) return false;
      state.events = state.events.filter((event) => event.runId !== runId);
      if (this.unscopedMcpRun?.id === runId) this.unscopedMcpRun = null;
      return true;
    });
  }

  pruneExpired(retentionDays: HistoryRetentionDays): number {
    if (retentionDays === null) return 0;
    const cutoff = this.now().getTime() - retentionDays * 24 * 60 * 60 * 1000;
    return this.state.mutate((state) => {
      const expiredIds = new Set(
        state.runs
          .filter(
            (run) =>
              isTerminalRunStatus(run.status) &&
              new Date(run.finishedAt ?? run.updatedAt).getTime() < cutoff,
          )
          .map((run) => run.id),
      );
      if (expiredIds.size === 0) return 0;
      state.runs = state.runs.filter((run) => !expiredIds.has(run.id));
      state.events = state.events.filter((event) => !expiredIds.has(event.runId));
      return expiredIds.size;
    });
  }

  getOrCreateUnscopedMcpRun(idleMs = 5 * 60_000): RunRecord {
    const nowMs = this.now().getTime();
    if (this.unscopedMcpRun && nowMs - this.unscopedMcpRun.lastActivityAt <= idleMs) {
      const existing = this.getRun(this.unscopedMcpRun.id);
      if (existing && !isTerminalRunStatus(existing.status)) {
        this.unscopedMcpRun.lastActivityAt = nowMs;
        return existing;
      }
    }
    if (this.unscopedMcpRun) {
      this.finishRun(this.unscopedMcpRun.id, { status: "completed" });
    }
    const run = this.startRun({
      source: "mcp",
      title: "MCP activity",
      goal: "Unscoped external agent activity",
    });
    this.unscopedMcpRun = { id: run.id, lastActivityAt: nowMs };
    return run;
  }

  subscribe(listener: (runs: RunRecord[]) => void): () => void {
    return this.state.subscribe((snapshot) => listener(snapshot.runs.map(clone)));
  }

  flushPersist(): Promise<void> {
    return this.state.flushPersist();
  }

  private parseStoredState(raw: unknown): RunStoreState {
    if (!raw || typeof raw !== "object") return clone(EMPTY_STATE);
    const input = raw as Partial<RunStoreState>;
    const runs = Array.isArray(input.runs)
      ? input.runs.flatMap((value) => {
          const parsed = StoredRunRecordSchema.safeParse(value);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
    const runIds = new Set(runs.map((run) => run.id));
    const state: RunStoreState = {
      version: 1,
      runs,
      events: Array.isArray(input.events)
        ? input.events.flatMap((value) => {
            const parsed = StoredRunEventSchema.safeParse(value);
            return parsed.success && runIds.has(parsed.data.runId) ? [parsed.data] : [];
          })
        : [],
      importedLegacyActions: input.importedLegacyActions === true,
    };
    const recoveredAt = this.now().toISOString();
    for (const run of state.runs) {
      if (run.status !== "running" && run.status !== "waiting-approval") continue;
      run.status = "interrupted";
      run.updatedAt = recoveredAt;
      run.finishedAt = recoveredAt;
      run.error = "Run was interrupted before the previous Vessel session ended.";
      state.events.push({
        id: this.createId(),
        runId: run.id,
        kind: "run-interrupted",
        timestamp: recoveredAt,
        summary: run.error,
      });
    }
    return state;
  }
}
