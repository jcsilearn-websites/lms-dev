/**
 * Work that must not delay (or leak timing into) the HTTP response: bookkeeping after a failed login,
 * sending password-reset mail. Tracked so tests and shutdown can wait for it with drain().
 */
export function createBackgroundTasks(onError: (err: unknown) => void) {
  const pending = new Set<Promise<void>>();
  return {
    run(task: () => Promise<void>): void {
      const p: Promise<void> = new Promise<void>((resolve) => {
        setImmediate(() => {
          task()
            .catch(onError)
            .finally(() => {
              pending.delete(p);
              resolve();
            });
        });
      });
      pending.add(p);
    },
    async drain(): Promise<void> {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
export type BackgroundTasks = ReturnType<typeof createBackgroundTasks>;
