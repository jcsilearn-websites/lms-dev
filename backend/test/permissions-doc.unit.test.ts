import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collectRoutes, PERMISSIONS_DOC_PATH } from '../src/cli/docs-permissions';
import { renderPermissionsDoc } from '../src/core/authz';

// docs/permissions.md is generated from the code. If this fails: run `pnpm docs:permissions` and commit.
describe('docs/permissions.md', () => {
  it('is up to date with the permission catalog, the role maps and the registered routes', async () => {
    const generated = renderPermissionsDoc(await collectRoutes());
    const committed = readFileSync(PERMISSIONS_DOC_PATH, 'utf8').replace(/\r\n/g, '\n');
    expect(committed).toBe(generated);
  });
});
