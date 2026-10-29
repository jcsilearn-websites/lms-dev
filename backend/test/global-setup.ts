import { prepareTestDatabases } from './support';

// Runs once per `vitest run` in the main process: every worker database (lms_test_1 ... _N) is created
// when missing and migrated. They are reused between runs.
export async function setup(): Promise<void> {
  const { workers, names } = await prepareTestDatabases();
  process.stdout.write(`test databases ready: ${workers} worker(s): ${names.join(', ')}
`);
}
