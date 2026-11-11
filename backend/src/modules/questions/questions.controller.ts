import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  ConfirmQuestionImportSchema,
  QuestionCourseParamsSchema,
  QuestionGetQuerySchema,
  QuestionImportParamsSchema,
  QuestionImportRowsQuerySchema,
  QuestionInput,
  QuestionListQuerySchema,
  QuestionParamsSchema,
} from '../../contracts';
import { contextFrom } from '../../core/context';
import type { FilesService } from '../files';
import { QuestionImportFileError } from './questions.errors';
import type { QuestionsService } from './questions.service';

// Reads the validated request, calls the service, maps the result to the response DTO. No DB access, no rules.
const as = <T>(v: unknown) => v as T;
type Course = { Params: Static<typeof QuestionCourseParamsSchema> };
type Question = { Params: Static<typeof QuestionParamsSchema> };
type Import = { Params: Static<typeof QuestionImportParamsSchema> };

export function createQuestionsController(deps: {
  questionsService: QuestionsService;
  filesService: Pick<FilesService, 'downloadTarget'>;
}) {
  const { questionsService: svc, filesService } = deps;
  return {
    list: async (
      request: FastifyRequest<Course & { Querystring: Static<typeof QuestionListQuerySchema> }>,
    ) => as<never>(await svc.list(contextFrom(request), request.params.courseId, request.query)),
    tags: async (request: FastifyRequest<Course>) =>
      as<never>(await svc.tags(contextFrom(request), request.params.courseId)),
    get: async (
      request: FastifyRequest<Question & { Querystring: Static<typeof QuestionGetQuerySchema> }>,
    ) =>
      as<never>(
        await svc.get(
          contextFrom(request),
          request.params.courseId,
          request.params.questionId,
          request.query.version,
        ),
      ),
    versions: async (request: FastifyRequest<Question>) =>
      as<never>(
        await svc.versions(
          contextFrom(request),
          request.params.courseId,
          request.params.questionId,
        ),
      ),
    create: async (
      request: FastifyRequest<Course & { Body: QuestionInput }>,
      reply: FastifyReply,
    ) => {
      const q = await svc.create(contextFrom(request), request.params.courseId, request.body);
      reply.status(201);
      return as<never>(q);
    },
    update: async (request: FastifyRequest<Question & { Body: QuestionInput }>) =>
      as<never>(
        await svc.update(
          contextFrom(request),
          request.params.courseId,
          request.params.questionId,
          request.body,
        ),
      ),
    archive: async (request: FastifyRequest<Question>) =>
      as<never>(
        await svc.setStatus(
          contextFrom(request),
          request.params.courseId,
          request.params.questionId,
          'archived',
        ),
      ),
    unarchive: async (request: FastifyRequest<Question>) =>
      as<never>(
        await svc.setStatus(
          contextFrom(request),
          request.params.courseId,
          request.params.questionId,
          'active',
        ),
      ),
    image: async (request: FastifyRequest<{ Params: Question['Params'] & { fileId: string } }>) => {
      const file = await svc.imageFile(
        contextFrom(request),
        request.params.courseId,
        request.params.questionId,
        request.params.fileId,
      );
      const t = await filesService.downloadTarget(file);
      return as<never>({
        url: t.url,
        expiresAt: t.expiresAt,
        fileName: t.fileName,
        inline: t.inline,
      });
    },

    template: async (request: FastifyRequest<Course>, reply: FastifyReply) => {
      const csv = await svc.template(contextFrom(request), request.params.courseId);
      void reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="questions-template.csv"');
      return csv;
    },
    upload: async (request: FastifyRequest<Course>, reply: FastifyReply) => {
      if (!request.isMultipart())
        throw new QuestionImportFileError(
          400,
          'no_file',
          'Send the CSV file as multipart form data',
        );
      const file = await request.file();
      if (!file)
        throw new QuestionImportFileError(
          400,
          'no_file',
          'Send the CSV file as multipart form data',
        );
      if (!/\.csv$/i.test(file.filename ?? '')) {
        file.file.resume();
        throw new QuestionImportFileError(
          400,
          'unsupported_file',
          'Only .csv files can be imported',
        );
      }
      const imp = await svc.upload(contextFrom(request), request.params.courseId, {
        name: file.filename ?? 'questions.csv',
        stream: file.file,
      });
      reply.status(201);
      return as<never>(imp);
    },
    getImport: async (request: FastifyRequest<Import>) =>
      as<never>(
        await svc.getImport(contextFrom(request), request.params.courseId, request.params.importId),
      ),
    importRows: async (
      request: FastifyRequest<
        Import & { Querystring: Static<typeof QuestionImportRowsQuerySchema> }
      >,
    ) =>
      as<never>(
        await svc.importRows(
          contextFrom(request),
          request.params.courseId,
          request.params.importId,
          request.query,
        ),
      ),
    confirmImport: async (
      request: FastifyRequest<Import & { Body: Static<typeof ConfirmQuestionImportSchema> }>,
    ) =>
      as<never>(
        await svc.confirmImport(
          contextFrom(request),
          request.params.courseId,
          request.params.importId,
          request.body?.skipInvalid === true,
        ),
      ),
    cancelImport: async (request: FastifyRequest<Import>) =>
      as<never>(
        await svc.cancelImport(
          contextFrom(request),
          request.params.courseId,
          request.params.importId,
        ),
      ),
  };
}
export type QuestionsController = ReturnType<typeof createQuestionsController>;
