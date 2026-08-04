import type { WebFrameMain } from "electron";
import type { TabManager } from "../../tabs/tab-manager";

type VaultFillTab = NonNullable<ReturnType<TabManager["getActiveTab"]>>;

export interface VaultFillExecutionTarget {
  executeJavaScript<T = unknown>(code: string, userGesture?: boolean): Promise<T>;
}

export type VaultFillTargetResult<T> =
  | { status: "denied" }
  | { status: "changed" }
  | { status: "completed"; value: T };

export interface VaultFillTargetGuard {
  dispose(): void;
  runAfterApproval<T>(
    requestApproval: () => Promise<boolean>,
    operation: (target: VaultFillExecutionTarget) => Promise<T>,
  ): Promise<VaultFillTargetResult<T>>;
}

class VaultFillTargetChangedError extends Error {}

export function createVaultFillTargetGuard(
  tabManager: Pick<TabManager, "getActiveTab">,
  tab: VaultFillTab,
): VaultFillTargetGuard {
  const webContents = tab.view.webContents;
  const expectedFrame: WebFrameMain = webContents.mainFrame;
  const expectedUrl = webContents.getURL() || tab.state.url;
  const expectedOrigin = new URL(expectedUrl).origin;
  let navigationStarted = false;
  let disposed = false;

  const onDidStartNavigation = (
    _event: unknown,
    _url: string,
    _isInPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame) navigationStarted = true;
  };
  const onDidNavigateInPage = (
    _event: unknown,
    _url: string,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame) navigationStarted = true;
  };
  webContents.on("did-start-navigation", onDidStartNavigation);
  webContents.on("did-navigate-in-page", onDidNavigateInPage);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    webContents.removeListener("did-start-navigation", onDidStartNavigation);
    webContents.removeListener("did-navigate-in-page", onDidNavigateInPage);
  };

  const isCurrent = () => {
    if (
      navigationStarted ||
      webContents.isDestroyed() ||
      expectedFrame.isDestroyed() ||
      expectedFrame.detached ||
      webContents.mainFrame !== expectedFrame ||
      tabManager.getActiveTab() !== tab
    ) {
      return false;
    }
    try {
      const currentUrl = webContents.getURL();
      return currentUrl === expectedUrl && new URL(currentUrl).origin === expectedOrigin;
    } catch {
      return false;
    }
  };

  const target: VaultFillExecutionTarget = {
    async executeJavaScript<T>(code: string, userGesture = false): Promise<T> {
      if (!isCurrent()) throw new VaultFillTargetChangedError();
      try {
        return await expectedFrame.executeJavaScript(code, userGesture) as T;
      } catch (error) {
        if (!isCurrent()) throw new VaultFillTargetChangedError();
        throw error;
      }
    },
  };

  return {
    dispose,
    async runAfterApproval<T>(requestApproval, operation): Promise<VaultFillTargetResult<T>> {
      try {
        if (!await requestApproval()) return { status: "denied" };
        if (!isCurrent()) return { status: "changed" };
        try {
          return { status: "completed", value: await operation(target) };
        } catch (error) {
          if (error instanceof VaultFillTargetChangedError) return { status: "changed" };
          throw error;
        }
      } finally {
        dispose();
      }
    },
  };
}
