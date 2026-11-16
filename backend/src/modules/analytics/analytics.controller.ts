import { Readable } from 'node:stream';
import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  AtRiskQuerySchema,
  OfferingParamsSchema,
  ReportExportQuerySchema,
  ReportParamsSchema,
  ReportQuerySchema,
  UpdateAnalyticsSettingsRequestSchema,
  VideoEngagementParamsSchema,
} from '../../contracts';
import { contextFrom } from '../../core/context';
import type { AnalyticsService } from './analytics.service';

// Reads the validated request, calls the service, maps the result to the response DTO. No DB access, no rules.
const as = <T>(v: unknown) => v as T;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function download(reply: FastifyReply, type: string, name: string) {
  void reply
    .header('content-type', type)
    .header('content-disposition', `attachment; filename="${name}"`)
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'private, no-store');
}

export function createAnalyticsController(deps: { analyticsService: AnalyticsService }) {
  const { analyticsService: svc } = deps;
  type Off = { Params: Static<typeof OfferingParamsSchema> };
  return {
    learnerDashboard: async (request: FastifyRequest) =>
      as<never>(await svc.learnerDashboard(contextFrom(request))),
    teachingDashboard: async (request: FastifyRequest) =>
      as<never>(await svc.teachingDashboard(contextFrom(request))),
    offeringDashboard: async (request: FastifyRequest<Off>) =>
      as<never>(await svc.offeringDashboard(contextFrom(request), request.params.id)),
    videoEngagement: async (
      request: FastifyRequest<{ Params: Static<typeof VideoEngagementParamsSchema> }>,
    ) =>
      as<never>(
        await svc.videoEngagement(contextFrom(request), request.params.id, request.params.itemId),
      ),
    atRisk: async (
      request: FastifyRequest<Off & { Querystring: Static<typeof AtRiskQuerySchema> }>,
    ) =>
      as<never>(
        await svc.atRisk(contextFrom(request), request.params.id, {
          limit: request.query.limit ?? 50,
          after: request.query.after && UUID.test(request.query.after) ? request.query.after : null,
        }),
      ),
    atRiskCsv: async (request: FastifyRequest<Off>, reply: FastifyReply) => {
      const it = svc.atRiskCsv(contextFrom(request), request.params.id);
      const first = await it.next(); // a refusal is a normal JSON error: nothing has been sent yet
      async function* all() {
        if (!first.done) yield first.value;
        yield* it;
      }
      download(reply, 'text/csv; charset=utf-8', 'at-risk-learners.csv');
      return reply.send(Readable.from(all()));
    },
    atRiskXlsx: async (request: FastifyRequest<Off>, reply: FastifyReply) => {
      const stream = await svc.atRiskXlsx(contextFrom(request), request.params.id);
      download(reply, XLSX, 'at-risk-learners.xlsx');
      return reply.send(stream);
    },
    getSettings: async (request: FastifyRequest) =>
      as<never>(await svc.getSettings(contextFrom(request))),
    updateSettings: async (
      request: FastifyRequest<{ Body: Static<typeof UpdateAnalyticsSettingsRequestSchema> }>,
    ) => as<never>(await svc.updateSettings(contextFrom(request), request.body)),
    activeUsers: async (request: FastifyRequest) => {
      const r = await svc.activeUsers(contextFrom(request));
      return as<never>({
        timeZone: r.tz,
        today: r.today,
        dau: r.dau,
        wau: r.wau,
        mau: r.mau,
        asOf: r.asOf,
      });
    },
    report: async (
      request: FastifyRequest<{
        Params: Static<typeof ReportParamsSchema>;
        Querystring: Static<typeof ReportQuerySchema>;
      }>,
    ) =>
      as<never>(await svc.reportTable(contextFrom(request), request.params.table, request.query)),
    reportExport: async (
      request: FastifyRequest<{
        Params: Static<typeof ReportParamsSchema>;
        Querystring: Static<typeof ReportExportQuerySchema>;
      }>,
      reply: FastifyReply,
    ) => {
      const ctx = contextFrom(request);
      const { table } = request.params;
      if (request.query.format === 'xlsx') {
        const stream = await svc.reportXlsx(ctx, table, request.query);
        download(reply, XLSX, `${table}.xlsx`);
        return reply.send(stream);
      }
      const csv = await svc.reportCsv(ctx, table, request.query);
      download(reply, 'text/csv; charset=utf-8', `${table}.csv`);
      return reply.send(csv);
    },
  };
}
export type AnalyticsController = ReturnType<typeof createAnalyticsController>;
