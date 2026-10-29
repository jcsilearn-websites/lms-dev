import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { ImportsController } from './imports.controller';
import {
  cancelRouteSchema,
  confirmRouteSchema,
  errorsCsvRouteSchema,
  getRouteSchema,
  listRouteSchema,
  rowsRouteSchema,
  templateRouteSchema,
  uploadRouteSchema,
} from './imports.schemas';

// URL + method + TypeBox schemas + route declaration only; no logic. Every import endpoint needs
// import.run (institution admin). The upload is multipart (registered in core/uploads.ts).
export function createImportsRoutes(deps: {
  importsController: ImportsController;
}): FastifyPluginAsyncTypebox {
  const { importsController: c } = deps;
  const run = { permission: 'import.run' } as const;
  return async (app) => {
    app.get(
      '/imports/templates/students.csv',
      { config: run, schema: templateRouteSchema('students') },
      c.template('students'),
    );
    app.get(
      '/imports/templates/faculty.csv',
      { config: run, schema: templateRouteSchema('faculty') },
      c.template('faculty'),
    );
    app.post('/imports', { config: run, schema: uploadRouteSchema }, c.upload);
    app.get('/imports', { config: run, schema: listRouteSchema }, c.list);
    app.get('/imports/:id', { config: run, schema: getRouteSchema }, c.get);
    app.get('/imports/:id/rows', { config: run, schema: rowsRouteSchema }, c.rows);
    app.get('/imports/:id/errors.csv', { config: run, schema: errorsCsvRouteSchema }, c.errorsCsv);
    app.post('/imports/:id/confirm', { config: run, schema: confirmRouteSchema }, c.confirm);
    app.post('/imports/:id/cancel', { config: run, schema: cancelRouteSchema }, c.cancel);
  };
}
