import { createSignal } from "solid-js";
import type { RunDetail, RunListQuery, RunRecord } from "../../../shared/run-types";
import { createLogger } from "../../../shared/logger";

const logger = createLogger("RunStore");
const [runs, setRuns] = createSignal<RunRecord[]>([]);
const [selectedRun, setSelectedRun] = createSignal<RunDetail | null>(null);
let initialized = false;
let updateCleanup: (() => void) | null = null;
let selectedRefreshInFlight = false;
let selectedRefreshPending = false;

async function refresh(query?: RunListQuery): Promise<void> {
  setRuns(await window.vessel.runs.list(query));
}

async function refreshSelectedRun(): Promise<void> {
  if (selectedRefreshInFlight) {
    selectedRefreshPending = true;
    return;
  }
  selectedRefreshInFlight = true;
  try {
    do {
      selectedRefreshPending = false;
      const selectedId = selectedRun()?.id;
      if (!selectedId) return;
      const detail = await window.vessel.runs.get(selectedId);
      if (selectedRun()?.id === selectedId) setSelectedRun(detail);
    } while (selectedRefreshPending);
  } catch (error) {
    logger.error("Failed to refresh selected run:", error);
  } finally {
    selectedRefreshInFlight = false;
  }
}

async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  try {
    await refresh();
    updateCleanup = window.vessel.runs.onUpdate((next) => {
      setRuns(next);
      void refreshSelectedRun();
    });
  } catch (error) {
    initialized = false;
    logger.error("Failed to initialize run store:", error);
  }
}

export function resetRunStoreForTests(): void {
  updateCleanup?.();
  updateCleanup = null;
  initialized = false;
  selectedRefreshInFlight = false;
  selectedRefreshPending = false;
  setRuns([]);
  setSelectedRun(null);
}

export function useRuns() {
  void init();
  return {
    runs,
    selectedRun,
    refresh,
    selectRun: async (runId: string) => {
      const detail = await window.vessel.runs.get(runId);
      setSelectedRun(detail);
      return detail;
    },
    clearSelection: () => setSelectedRun(null),
    deleteRun: async (runId: string) => {
      const deleted = await window.vessel.runs.delete(runId);
      if (deleted && selectedRun()?.id === runId) setSelectedRun(null);
      return deleted;
    },
    exportRun: (runId: string, format: "json" | "markdown") =>
      window.vessel.runs.export(runId, format),
  };
}
