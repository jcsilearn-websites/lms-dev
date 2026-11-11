import { type Static, type TSchema, Type } from '@sinclair/typebox';
import { RichTextSchema } from './content';

const Id = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
const Nullable = <T extends TSchema>(t: T) => Type.Union([Type.Null(), t]);

// The question bank (step 9). Questions belong to a COURSE; editing one adds a VERSION (past attempts keep theirs).
// These DTOs carry the ANSWER KEY: they are only ever sent to instructors, assistants and administrators.

export const QUESTION_TYPES = [
  'single_choice',
  'multiple_choice',
  'true_false',
  'numeric',
  'short_answer',
  'essay',
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const DifficultySchema = Type.Union([
  Type.Literal('easy'),
  Type.Literal('medium'),
  Type.Literal('hard'),
]);
export type Difficulty = Static<typeof DifficultySchema>;

const TypeField = Type.Union([
  Type.Literal('single_choice'),
  Type.Literal('multiple_choice'),
  Type.Literal('true_false'),
  Type.Literal('numeric'),
  Type.Literal('short_answer'),
  Type.Literal('essay'),
]);

export const QuestionTypeSchema = TypeField;

export const MAX_OPTIONS = 10;
export const MAX_QUESTION_IMAGES = 4;

export const QuestionOptionInputSchema = Type.Object({
  /** the id of an option kept from the previous version; omit it for a NEW option (the server draws a random id) */
  id: Type.Optional(Type.String({ minLength: 4, maxLength: 24, pattern: '^[a-z0-9]+$' })),
  text: RichTextSchema,
  correct: Type.Boolean(),
});

export const QuestionImageSchema = Type.Object({
  fileId: Id,
  alt: Type.String({ maxLength: 300 }),
});

/** The content of a question (create, or a new version). Which fields apply depends on `type`. */
export const QuestionInputSchema = Type.Object({
  type: TypeField,
  difficulty: Type.Optional(DifficultySchema),
  stem: RichTextSchema,
  options: Type.Optional(Type.Array(QuestionOptionInputSchema, { maxItems: MAX_OPTIONS })),
  images: Type.Optional(Type.Array(QuestionImageSchema, { maxItems: MAX_QUESTION_IMAGES })),
  /** multiple choice: partial credit for the right options picked, minus the wrong ones */
  partialCredit: Type.Optional(Type.Boolean()),
  /** true / false: the right answer */
  trueIsCorrect: Type.Optional(Type.Boolean()),
  /** numeric */
  numeric: Type.Optional(
    Type.Object({
      value: Type.Number(),
      tolerance: Type.Optional(Type.Number({ minimum: 0 })),
      mode: Type.Optional(Type.Union([Type.Literal('absolute'), Type.Literal('percent')])),
    }),
  ),
  /** short answer: accepted answers (normalised exact match) or graded by a person */
  shortAnswer: Type.Optional(
    Type.Object({
      mode: Type.Union([Type.Literal('auto'), Type.Literal('manual')]),
      accepted: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 30 }),
      ),
    }),
  ),
  /** essay: a soft word limit shown to the learner */
  maxWords: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
  /** shown with the answers when results are released */
  explanation: Type.Optional(RichTextSchema),
  tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 10 })),
});
export type QuestionInput = Static<typeof QuestionInputSchema>;

export const QuestionOptionSchema = Type.Object({
  id: Type.String(),
  text: RichTextSchema,
  correct: Type.Boolean(),
});

export const QuestionSchema = Type.Object({
  id: Id,
  courseId: Id,
  status: Type.Union([Type.Literal('active'), Type.Literal('archived')]),
  /** the version shown here and the newest version number */
  version: Type.Integer(),
  latestVersion: Type.Integer(),
  versionId: Id,
  type: TypeField,
  difficulty: DifficultySchema,
  stem: RichTextSchema,
  options: Type.Array(QuestionOptionSchema),
  images: Type.Array(QuestionImageSchema),
  partialCredit: Type.Boolean(),
  trueIsCorrect: Nullable(Type.Boolean()),
  numeric: Nullable(
    Type.Object({
      value: Type.Number(),
      tolerance: Type.Number(),
      mode: Type.Union([Type.Literal('absolute'), Type.Literal('percent')]),
    }),
  ),
  shortAnswer: Nullable(
    Type.Object({
      mode: Type.Union([Type.Literal('auto'), Type.Literal('manual')]),
      accepted: Type.Array(Type.String()),
    }),
  ),
  maxWords: Nullable(Type.Integer()),
  explanation: Nullable(RichTextSchema),
  tags: Type.Array(Type.String()),
  createdAt: DateTime,
  updatedAt: DateTime,
});
export type QuestionDto = Static<typeof QuestionSchema>;

export const QuestionListQuerySchema = Type.Object({
  type: Type.Optional(TypeField),
  difficulty: Type.Optional(DifficultySchema),
  tag: Type.Optional(Type.String({ maxLength: 40 })),
  status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('archived')])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  after: Type.Optional(Id),
});
export const QuestionPageSchema = Type.Object({
  items: Type.Array(QuestionSchema),
  nextCursor: Nullable(Id),
});
export type QuestionPage = Static<typeof QuestionPageSchema>;

export const QuestionCourseParamsSchema = Type.Object({ courseId: Id });
export const QuestionParamsSchema = Type.Object({ courseId: Id, questionId: Id });
export const QuestionGetQuerySchema = Type.Object({
  version: Type.Optional(Type.Integer({ minimum: 1 })),
});

export const QuestionVersionSchema = Type.Object({
  version: Type.Integer(),
  versionId: Id,
  current: Type.Boolean(),
  createdAt: DateTime,
  createdByName: Nullable(Type.String()),
});
export const QuestionVersionsSchema = Type.Object({ items: Type.Array(QuestionVersionSchema) });

export const TagsSchema = Type.Object({
  items: Type.Array(Type.Object({ tag: Type.String(), count: Type.Integer() })),
});

// ------------------------------------------------------------------ CSV import (at most 1,000 rows, synchronous)
export const MAX_QUESTION_IMPORT_ROWS = 1000;

export const QuestionImportSchema = Type.Object({
  id: Id,
  courseId: Id,
  fileName: Type.String(),
  status: Type.Union([Type.Literal('staged'), Type.Literal('applied'), Type.Literal('cancelled')]),
  totalRows: Type.Integer(),
  validRows: Type.Integer(),
  invalidRows: Type.Integer(),
  createdCount: Type.Integer(),
  createdAt: DateTime,
});
export type QuestionImportDto = Static<typeof QuestionImportSchema>;

export const QuestionImportParamsSchema = Type.Object({ courseId: Id, importId: Id });
export const QuestionImportRowsQuerySchema = Type.Object({
  status: Type.Optional(Type.Union([Type.Literal('valid'), Type.Literal('invalid')])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  after: Type.Optional(Type.Integer({ minimum: 0 })),
});
export const QuestionImportRowSchema = Type.Object({
  rowNo: Type.Integer(),
  valid: Type.Boolean(),
  errors: Type.Array(Type.Object({ column: Type.String(), message: Type.String() })),
  question: Type.String(),
  type: Type.String(),
});
export const QuestionImportRowsSchema = Type.Object({
  items: Type.Array(QuestionImportRowSchema),
  nextCursor: Nullable(Type.Integer()),
});
export const ConfirmQuestionImportSchema = Type.Object({
  /** required when some rows are invalid: import the valid ones only */
  skipInvalid: Type.Optional(Type.Boolean()),
});
