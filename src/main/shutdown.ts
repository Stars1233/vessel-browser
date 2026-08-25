export interface ShutdownFlushable {
  flushPersist(): Promise<void>;
}

/** Persist durable state before disposing objects that clear their in-memory state. */
export async function flushBeforeDispose(
  flushables: Array<ShutdownFlushable | null | undefined>,
  disposers: Array<(() => void) | null | undefined>,
): Promise<void> {
  const results = await Promise.allSettled(
    flushables.map(async (item) => item?.flushPersist()),
  );
  for (const dispose of disposers) dispose?.();

  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
}
