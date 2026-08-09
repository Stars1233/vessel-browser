export function createStreamBatcher(
  emit: (chunk: string) => void,
  intervalMs = 32,
): { push: (chunk: string) => void; flush: () => void; cancel: () => void } {
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending) return;
    const chunk = pending;
    pending = "";
    emit(chunk);
  };

  return {
    push: (chunk) => {
      pending += chunk;
      if (!timer) timer = setTimeout(flush, intervalMs);
    },
    flush,
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = "";
    },
  };
}
