export interface ScrollPosition {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

type ScheduleScroll = (callback: () => void) => void;

export function isChatNearBottom(position: ScrollPosition, threshold = 96): boolean {
  return position.scrollHeight - position.scrollTop - position.clientHeight <= threshold;
}

export interface ChatAutoFollow {
  attach(element: ScrollPosition): void;
  resume(): void;
  onScroll(enabled: boolean): void;
  onContentChanged(enabled: () => boolean): void;
  scrollToStart(): void;
}

export function createChatAutoFollow(schedule: ScheduleScroll = queueMicrotask): ChatAutoFollow {
  let element: ScrollPosition | undefined;
  let following = true;
  let initialized = false;

  return {
    attach(nextElement) {
      element = nextElement;
    },
    resume() {
      following = true;
    },
    onScroll(enabled) {
      if (enabled && element) following = isChatNearBottom(element);
    },
    onContentChanged(enabled) {
      if (!initialized) {
        initialized = true;
        return;
      }
      if (!following || !enabled()) return;
      schedule(() => {
        if (following && enabled() && element) {
          element.scrollTop = element.scrollHeight;
        }
      });
    },
    scrollToStart() {
      schedule(() => {
        if (element) element.scrollTop = 0;
      });
    },
  };
}
