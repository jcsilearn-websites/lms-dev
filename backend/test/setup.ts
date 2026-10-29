import { beforeAll } from 'vitest';
import { resetLms } from './support';

beforeAll(async () => {
  await resetLms();
});
