import { parseArgs } from 'node:util';
import { loadDotEnv } from '../config/env';
import { removeDemo } from '../demo/remove';
import { seedDemo, signInSheet } from '../demo/seed';
import { attachLecture } from '../demo/video';

// The demo commands (docs/demo-walkthrough.md):
//   pnpm demo:seed  [--slug demo-nilgiri] [--password <12+ characters>]
//   pnpm demo:reset [--slug demo-nilgiri] [--password ...]
//   pnpm demo:video <file> --course CS201 --item "Lecture 1: Arrays and linked lists" [--module "<module title>"]
// All three refuse production, a database host that is not this machine (or DEMO_ALLOWED_HOSTS) and a slug without `demo-`.

const DEFAULT_SLUG = 'demo-nilgiri';

async function main(): Promise<void> {
  loadDotEnv();
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest.filter((a) => a !== '--'),
    allowPositionals: true,
    options: {
      slug: { type: 'string', default: DEFAULT_SLUG },
      password: { type: 'string' },
      course: { type: 'string' },
      item: { type: 'string' },
      module: { type: 'string' },
    },
    strict: true,
  });
  const slug = values.slug ?? DEFAULT_SLUG;
  const started = Date.now();
  const took = () => `${Math.round((Date.now() - started) / 1000)} s`;

  if (command === 'seed' || command === 'reset') {
    if (command === 'reset') {
      const removed = await removeDemo({ slug });
      console.log(removed ? `> ${slug} removed` : `> there was no ${slug} to remove`);
    }
    const log = (m: string) => console.log(m);
    const result = await seedDemo({ slug, password: values.password, log });
    console.log(signInSheet(result));
    console.log(`done in ${took()}`);
  } else if (command === 'video') {
    const file = positionals[0];
    if (!file || !values.course || !values.item) {
      throw new Error(
        'usage: pnpm demo:video <file> --course CS201 --item "<video item title>" [--module "<module title>"]',
      );
    }
    const done = await attachLecture({
      slug,
      file,
      course: values.course,
      item: values.item,
      module: values.module,
      log: (m) => console.log(m),
    });
    console.log(`attached in ${done.seconds} s: ${done.url}`);
  } else {
    throw new Error('usage: demo.ts seed | reset | video');
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'the demo command failed');
  process.exit(1);
});
