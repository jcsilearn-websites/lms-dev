import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileMailer } from '../mailer';

describe('file mailer (dev / E2E only)', () => {
  it('appends one JSON line per email and creates the directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lms-mail-'));
    try {
      const file = join(dir, 'nested', 'outbox.jsonl');
      const mailer = createFileMailer(file);
      await mailer.send({ to: 'a@x.test', subject: 'Hi', text: 'link?token=abc' });
      await mailer.send({ to: 'b@x.test', subject: 'Yo', text: 'second' });
      const lines = (await readFile(file, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0] as string)).toMatchObject({
        to: 'a@x.test',
        subject: 'Hi',
        text: 'link?token=abc',
      });
      expect(JSON.parse(lines[1] as string).to).toBe('b@x.test');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
