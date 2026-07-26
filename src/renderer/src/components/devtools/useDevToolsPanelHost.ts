import { createSignal, onMount, type Accessor } from "solid-js";
import type { DevToolsPanelHostState } from "../../../../shared/devtools-types";
import {
  DOCKED_DEVTOOLS_MAX_HEIGHT,
  DOCKED_DEVTOOLS_MIN_HEIGHT,
} from "../../../../shared/devtools";

type DevToolsPanelHostControls = {
  hostState: Accessor<DevToolsPanelHostState>;
  isResizing: Accessor<boolean>;
  close: () => void;
  togglePlacement: () => void;
  startResize: (event: PointerEvent) => void;
  applyHostState: (state: DevToolsPanelHostState) => void;
};

export function useDevToolsPanelHost(): DevToolsPanelHostControls {
  const [hostState, setHostState] = createSignal<DevToolsPanelHostState>({
    open: true,
    detached: false,
    height: 250,
  });
  const [isResizing, setIsResizing] = createSignal(false);

  const applyHostState = (nextState: DevToolsPanelHostState) => {
    setHostState(nextState);
  };

  onMount(() => {
    void window.vessel.devtoolsPanel
      .getHostState()
      .then(applyHostState)
      .catch(() => {
        /* keep the default docked host state during early bootstrap */
      });
  });

  const close = () => {
    void window.vessel.devtoolsPanel.close().then(applyHostState);
  };

  const togglePlacement = () => {
    const action = hostState().detached
      ? window.vessel.devtoolsPanel.dock()
      : window.vessel.devtoolsPanel.popOut();
    void action.then(applyHostState);
  };

  const startResize = (event: PointerEvent) => {
    if (hostState().detached) return;
    event.preventDefault();

    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    setIsResizing(true);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    void window.vessel.devtoolsPanel.startResize().catch(() => {
      /* ignore IPC failures during drag start */
    });

    const startY = event.screenY;
    const startHeight = window.innerHeight;
    let finished = false;
    const dragState = {
      currentY: startY,
      rafId: null as number | null,
      requestId: 0,
    };

    const resizeToCurrentPointer = (): Promise<void> => {
      dragState.rafId = null;
      const nextHeight = Math.max(
        DOCKED_DEVTOOLS_MIN_HEIGHT,
        Math.min(
          DOCKED_DEVTOOLS_MAX_HEIGHT,
          Math.round(startHeight + startY - dragState.currentY),
        ),
      );
      const requestId = ++dragState.requestId;

      // Keep the visual edge under the pointer instead of waiting for a
      // renderer-to-main round trip on every animation frame.
      setHostState((current) => ({ ...current, height: nextHeight }));

      return window.vessel.devtoolsPanel
        .resize(nextHeight)
        .then((height) => {
          if (requestId !== dragState.requestId) return;
          setHostState((current) => ({ ...current, height }));
        })
        .catch(() => {
          /* ignore transient resize IPC failures during drag */
        });
    };

    const commitResize = async () => {
      try {
        await window.vessel.devtoolsPanel.commitResize();
      } catch {
        /* ignore commit failures during drag cleanup */
      } finally {
        // Keep the fixed, bottom-anchored panel active until the native view
        // has been restored to its final bounds.
        setIsResizing(false);
      }
    };

    const clearPointerTracking = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      target.removeEventListener("lostpointercapture", onPointerUp);
      if (target.hasPointerCapture?.(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
      }
      if (dragState.rafId !== null) {
        cancelAnimationFrame(dragState.rafId);
        dragState.rafId = null;
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    const scheduleResize = () => {
      if (dragState.rafId !== null) return;
      dragState.rafId = requestAnimationFrame(resizeToCurrentPointer);
    };

    function onPointerMove(pointerEvent: PointerEvent) {
      if (finished) return;
      dragState.currentY = pointerEvent.screenY;
      scheduleResize();
    }

    function finishResize(pointerEvent?: PointerEvent) {
      if (finished) return;
      finished = true;
      if (pointerEvent) {
        dragState.currentY = pointerEvent.screenY;
      }
      if (dragState.rafId !== null) {
        cancelAnimationFrame(dragState.rafId);
        dragState.rafId = null;
      }
      const finalResize = resizeToCurrentPointer();
      clearPointerTracking();
      void finalResize.finally(commitResize);
    }

    function onPointerUp(pointerEvent: PointerEvent) {
      finishResize(pointerEvent);
    }

    function onWindowBlur() {
      finishResize();
    }

    function onVisibilityChange() {
      if (document.hidden) {
        finishResize();
      }
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("visibilitychange", onVisibilityChange);
    target.addEventListener("lostpointercapture", onPointerUp);
  };

  return {
    hostState,
    isResizing,
    close,
    togglePlacement,
    startResize,
    applyHostState,
  };
}
