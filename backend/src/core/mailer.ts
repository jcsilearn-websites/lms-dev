export interface Email {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(email: Email): Promise<void>;
}

/** Dev mailer: writes the email (including any link) to the log. Never use it in production. */
export function createConsoleMailer(log: (obj: object, msg: string) => void): Mailer {
  return {
    async send(email) {
      log({ to: email.to, subject: email.subject, text: email.text }, 'email (console mailer)');
    },
  };
}

/** Test double: remembers what would have been sent. */
export function createCapturingMailer(): Mailer & { sent: Email[] } {
  const sent: Email[] = [];
  return {
    sent,
    async send(email) {
      sent.push(email);
    },
  };
}

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
