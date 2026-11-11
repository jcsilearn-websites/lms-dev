import { type Static, type TSchema, Type } from '@sinclair/typebox';
import { RichTextSchema } from './content';
import { DifficultySchema, QuestionImageSchema } from './questions';

const Id = Type.String({ format: 'uuid' });
const DateTime = Type.String({ format: 'date-time' });
const Nullable = <T extends TSchema>(t: T) => Type.Union([Type.Null(), t]);

// Assessments (step 9). Two audiences, two families of DTOs:
//  * the LEARNER ones (attempt, result) never contain an answer key before results are released: there is no field for it;
//  * the INSTRUCTOR ones (grading, analysis, regrade) do.

export const AssessmentItemParamsSchema = Type.Object({ id: Id, itemId: Id });
export const AttemptParamsSchema = Type.Object({ id: Id, attemptId: Id });
export const AttemptFileParamsSchema = Type.Object({ id: Id, attemptId: Id, fileId: Id });
export const AttemptQuestionParamsSchema = Type.Object({
  id: Id,
  attemptId: Id,
  position: Type.Integer({ minimum: 1, maximum: 500 }),
});
export const AccommodationParamsSchema = Type.Object({ id: Id, itemId: Id, participantId: Id });

// ------------------------------------------------------------------ settings and questions
export const AssessmentKindSchema = Type.Union([Type.Literal('practice'), Type.Literal('exam')]);
export const ScoringSchema = Type.Union([
  Type.Literal('highest'),
  Type.Literal('latest'),
  Type.Literal('average'),
]);
export const ResultsVisibilitySchema = Type.Union([
  Type.Literal('immediate'),
  Type.Literal('after_close'),
  Type.Literal('manual'),
]);
export const AnswersVisibilitySchema = Type.Union([
  Type.Literal('never'),
  Type.Literal('after_close'),
  Type.Literal('after_release'),
]);

export const AssessmentSettingsSchema = Type.Object({
  kind: AssessmentKindSchema,
  opensAt: Nullable(DateTime),
  closesAt: Nullable(DateTime),
  timeLimitMinutes: Nullable(Type.Integer({ minimum: 1, maximum: 720 })),
  attemptsAllowed: Type.Integer({ minimum: 1, maximum: 20 }),
  scoring: ScoringSchema,
  shuffleQuestions: Type.Boolean(),
  shuffleOptions: Type.Boolean(),
  /** percent of the maximum */
  passingScore: Nullable(Type.Number({ minimum: 0, maximum: 100 })),
  resultsVisibility: ResultsVisibilitySchema,
  answersVisibility: AnswersVisibilitySchema,
});
export type AssessmentSettings = Static<typeof AssessmentSettingsSchema>;

export const UpdateSettingsRequestSchema = Type.Partial(AssessmentSettingsSchema);

export const SlotInputSchema = Type.Object({
  kind: Type.Union([Type.Literal('fixed'), Type.Literal('pool')]),
  /** fixed: the question (its CURRENT version is shown) */
  questionId: Type.Optional(Id),
  /** pool: draw `count` questions with this tag and / or difficulty (either may be omitted) */
  tag: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  difficulty: Type.Optional(DifficultySchema),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  /** points of EACH question of the slot */
  points: Type.Number({ minimum: 0.01, maximum: 1000 }),
});
export const MAX_SLOTS = 60;
export const MAX_ATTEMPT_QUESTIONS = 200;
export const ReplaceSlotsRequestSchema = Type.Object({
  slots: Type.Array(SlotInputSchema, { maxItems: MAX_SLOTS }),
});

export const SlotSchema = Type.Object({
  position: Type.Integer(),
  kind: Type.Union([Type.Literal('fixed'), Type.Literal('pool')]),
  questionId: Nullable(Id),
  tag: Nullable(Type.String()),
  difficulty: Nullable(DifficultySchema),
  count: Type.Integer(),
  points: Type.Number(),
  /** fixed: what the question is now (instructors see the key elsewhere) */
  question: Nullable(
    Type.Object({
      type: Type.String(),
      difficulty: DifficultySchema,
      stem: RichTextSchema,
      status: Type.Union([Type.Literal('active'), Type.Literal('archived')]),
    }),
  ),
  /** pool: how many active questions of the bank match right now (the draw fails when this is below `count`) */
  available: Nullable(Type.Integer()),
});

export const AssessmentConfigSchema = Type.Object({
  itemId: Id,
  courseId: Id,
  title: Type.String(),
  published: Type.Boolean(),
  settings: AssessmentSettingsSchema,
  slots: Type.Array(SlotSchema),
  /** how many attempts exist: settings can still change, but what past attempts showed cannot */
  attemptsStarted: Type.Integer(),
  totalPoints: Type.Number(),
  questionCount: Type.Integer(),
});
export type AssessmentConfig = Static<typeof AssessmentConfigSchema>;

// ------------------------------------------------------------------ what a learner is sent
export const AnswerSchema = Type.Object(
  {
    /** choice: the ids of the options picked */
    o: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 12 })),
    /** numeric */
    n: Type.Optional(Type.Number()),
    /** short answer / essay */
    t: Type.Optional(Type.String({ maxLength: 20000 })),
  },
  { additionalProperties: false },
);
export type Answer = Static<typeof AnswerSchema>;

export const LearnerOptionSchema = Type.Object({ id: Type.String(), text: RichTextSchema });
export const AttemptQuestionSchema = Type.Object({
  position: Type.Integer(),
  type: Type.String(),
  points: Type.Number(),
  stem: RichTextSchema,
  images: Type.Array(QuestionImageSchema),
  maxWords: Nullable(Type.Integer()),
  options: Type.Array(LearnerOptionSchema),
  /** what was saved so far */
  answer: Nullable(AnswerSchema),
  /** the server's revision of this answer: a client continues from it */
  rev: Type.Integer(),
  flagged: Type.Boolean(),
});
export type AttemptQuestion = Static<typeof AttemptQuestionSchema>;

export const AttemptHeaderSchema = Type.Object({
  id: Id,
  itemId: Id,
  title: Type.String(),
  kind: AssessmentKindSchema,
  attemptNo: Type.Integer(),
  status: Type.Union([
    Type.Literal('in_progress'),
    Type.Literal('submitted'),
    Type.Literal('graded'),
  ]),
  startedAt: DateTime,
  /** the SERVER deadline: the screen only displays it */
  deadlineAt: DateTime,
  /** the server clock when this was sent (the client corrects its own clock by the difference) */
  serverNow: DateTime,
  submittedAt: Nullable(DateTime),
});
export const AttemptSchema = Type.Object({
  attempt: AttemptHeaderSchema,
  /** empty once the attempt is over */
  questions: Type.Array(AttemptQuestionSchema),
});
export type AttemptDto = Static<typeof AttemptSchema>;

export const StartAttemptResponseSchema = Type.Object({
  attemptId: Id,
  /** true: the learner already had an active attempt (a reload, another tab or device): this is it */
  resumed: Type.Boolean(),
});

export const SaveAnswerSchema = Type.Object({
  position: Type.Integer({ minimum: 1, maximum: 500 }),
  /** null clears the answer */
  answer: Nullable(AnswerSchema),
  /** the revision of this change: strictly above the last one the client knows (the server's, after a resume) */
  rev: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
  flagged: Type.Optional(Type.Boolean()),
  /** client clock in ms: breaks a tie between two tabs that chose the same revision */
  at: Type.Integer({ minimum: 0 }),
  /** milliseconds spent on the question since the last save */
  spentMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 300_000 })),
});
export const EventKindSchema = Type.Union([
  Type.Literal('hidden'),
  Type.Literal('visible'),
  Type.Literal('blur'),
  Type.Literal('focus'),
  Type.Literal('offline'),
  Type.Literal('online'),
  Type.Literal('resume'),
]);
export const SaveRequestSchema = Type.Object({
  answers: Type.Array(SaveAnswerSchema, { maxItems: 100 }),
  events: Type.Optional(
    Type.Array(Type.Object({ kind: EventKindSchema, at: Type.Integer({ minimum: 0 }) }), {
      maxItems: 50,
    }),
  ),
});
export type SaveRequest = Static<typeof SaveRequestSchema>;

export const SaveResponseSchema = Type.Object({
  /** ok | submitted (already submitted) | closed (the deadline passed: the attempt was closed) */
  result: Type.Union([Type.Literal('ok'), Type.Literal('submitted'), Type.Literal('closed')]),
  applied: Type.Integer(),
  /** answers NOT applied because the server already has a newer revision: adopt these */
  stale: Type.Array(
    Type.Object({
      position: Type.Integer(),
      rev: Type.Integer(),
      answer: Nullable(AnswerSchema),
      flagged: Type.Boolean(),
    }),
  ),
  serverNow: Nullable(DateTime),
  deadlineAt: Nullable(DateTime),
});
export type SaveResponse = Static<typeof SaveResponseSchema>;

export const SubmitResponseSchema = Type.Object({
  status: Type.Union([Type.Literal('submitted'), Type.Literal('graded')]),
  submittedAt: DateTime,
});

// ------------------------------------------------------------------ the learner's page of an assessment
export const AssessmentMeSchema = Type.Object({
  serverNow: DateTime,
  assessment: Type.Object({
    itemId: Id,
    title: Type.String(),
    kind: AssessmentKindSchema,
    opensAt: Nullable(DateTime),
    /** the close date that applies to THIS learner (their accommodation included) */
    closesAt: Nullable(DateTime),
    timeLimitMinutes: Nullable(Type.Integer()),
    extraMinutes: Type.Integer(),
    attemptsAllowed: Type.Integer(),
    scoring: ScoringSchema,
    passingScore: Nullable(Type.Number()),
    resultsVisibility: ResultsVisibilitySchema,
    answersVisibility: AnswersVisibilitySchema,
    questionCount: Type.Integer(),
  }),
  attemptsUsed: Type.Integer(),
  canStart: Type.Boolean(),
  blockedReason: Nullable(
    Type.Union([
      Type.Literal('empty'),
      Type.Literal('not_open'),
      Type.Literal('closed'),
      Type.Literal('no_attempts_left'),
    ]),
  ),
  activeAttemptId: Nullable(Id),
  counted: Nullable(
    Type.Object({ score: Type.Number(), maxScore: Type.Number(), percent: Type.Number() }),
  ),
  attempts: Type.Array(
    Type.Object({
      id: Id,
      attemptNo: Type.Integer(),
      status: Type.Union([
        Type.Literal('in_progress'),
        Type.Literal('submitted'),
        Type.Literal('graded'),
      ]),
      startedAt: DateTime,
      submittedAt: Nullable(DateTime),
      resultsVisible: Type.Boolean(),
      score: Nullable(Type.Number()),
      maxScore: Nullable(Type.Number()),
      pendingGrading: Type.Boolean(),
    }),
  ),
});
export type AssessmentMe = Static<typeof AssessmentMeSchema>;

// ------------------------------------------------------------------ a result (follows the visibility settings)
export const ResultQuestionSchema = Type.Object({
  position: Type.Integer(),
  type: Type.String(),
  points: Type.Number(),
  dropped: Type.Boolean(),
  stem: RichTextSchema,
  images: Type.Array(QuestionImageSchema),
  options: Type.Array(LearnerOptionSchema),
  answer: Nullable(AnswerSchema),
  score: Nullable(Type.Number()),
  pendingGrading: Type.Boolean(),
  feedback: Nullable(Type.String()),
  /** ONLY when the answer visibility allows it: the correct option ids / value / accepted answers / explanation */
  key: Type.Optional(Type.Any()),
});
export const ResultSchema = Type.Object({
  result: Type.Union([Type.Literal('ok'), Type.Literal('not_released')]),
  attempt: Type.Object({
    id: Id,
    itemId: Type.Optional(Id),
    attemptNo: Type.Integer(),
    status: Type.Union([Type.Literal('submitted'), Type.Literal('graded')]),
    submittedAt: Nullable(DateTime),
    feedback: Type.Optional(Nullable(Type.String())),
    pendingGrading: Type.Optional(Type.Boolean()),
    score: Type.Optional(Nullable(Type.Number())),
    maxScore: Type.Optional(Nullable(Type.Number())),
    percent: Type.Optional(Nullable(Type.Number())),
    passed: Type.Optional(Nullable(Type.Boolean())),
    answersShown: Type.Optional(Type.Boolean()),
  }),
  questions: Type.Array(ResultQuestionSchema),
});
export type ResultDto = Static<typeof ResultSchema>;

export const PreviewSchema = Type.Object({ questions: Type.Array(AttemptQuestionSchema) });

// ------------------------------------------------------------------ accommodations (sensitive)
export const AccommodationInputSchema = Type.Object({
  extraMinutes: Type.Integer({ minimum: 0, maximum: 720 }),
  extendedCloseAt: Type.Optional(Nullable(DateTime)),
  /** OPTIONAL. Do not write medical details: say "approved by the disability office" at most. Never audited. */
  reason: Type.Optional(Nullable(Type.String({ maxLength: 300 }))),
});
export const AccommodationSchema = Type.Object({
  participantId: Id,
  learnerName: Type.String(),
  learnerEmail: Type.String(),
  extraMinutes: Type.Integer(),
  extendedCloseAt: Nullable(DateTime),
  reason: Nullable(Type.String()),
  updatedAt: DateTime,
});
export const AccommodationsSchema = Type.Object({ items: Type.Array(AccommodationSchema) });

// ------------------------------------------------------------------ instructors: attempts and grading
export const AttemptListQuerySchema = Type.Object({
  status: Type.Optional(
    Type.Union([Type.Literal('in_progress'), Type.Literal('submitted'), Type.Literal('graded')]),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  after: Type.Optional(Id),
});
export const AttemptRowSchema = Type.Object({
  attemptId: Id,
  participantId: Id,
  learnerName: Type.String(),
  learnerEmail: Type.String(),
  attemptNo: Type.Integer(),
  status: Type.Union([
    Type.Literal('in_progress'),
    Type.Literal('submitted'),
    Type.Literal('graded'),
  ]),
  startedAt: DateTime,
  submittedAt: Nullable(DateTime),
  submitKind: Nullable(Type.Union([Type.Literal('manual'), Type.Literal('deadline')])),
  score: Nullable(Type.Number()),
  maxScore: Nullable(Type.Number()),
  pendingManual: Type.Integer(),
  /** blur / tab-hidden / offline events logged by the browser (informational only) */
  eventCount: Type.Integer(),
  released: Type.Boolean(),
});
export const AttemptPageSchema = Type.Object({
  items: Type.Array(AttemptRowSchema),
  nextCursor: Nullable(Id),
});

export const GradingSummarySchema = Type.Object({
  questions: Type.Array(
    Type.Object({
      questionId: Id,
      type: Type.String(),
      stem: RichTextSchema,
      points: Type.Number(),
      pending: Type.Integer(),
      graded: Type.Integer(),
    }),
  ),
  attemptsToGrade: Type.Integer(),
});
export const GradingAnswersQuerySchema = Type.Object({
  questionId: Id,
  state: Type.Optional(
    Type.Union([Type.Literal('pending'), Type.Literal('graded'), Type.Literal('all')]),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  after: Type.Optional(Id),
});
export const GradingAnswerSchema = Type.Object({
  attemptId: Id,
  position: Type.Integer(),
  learnerName: Type.String(),
  answer: Nullable(AnswerSchema),
  points: Type.Number(),
  score: Nullable(Type.Number()),
  feedback: Nullable(Type.String()),
  state: Type.Union([Type.Literal('pending'), Type.Literal('graded')]),
});
export const GradingAnswersSchema = Type.Object({
  question: Type.Object({
    questionId: Id,
    type: Type.String(),
    stem: RichTextSchema,
    key: Type.Any(),
    maxWords: Nullable(Type.Integer()),
  }),
  items: Type.Array(GradingAnswerSchema),
  nextCursor: Nullable(Id),
});

export const GradeRequestSchema = Type.Object({
  score: Type.Number({ minimum: 0, maximum: 1000 }),
  feedback: Type.Optional(Nullable(Type.String({ maxLength: 5000 }))),
});
export const GradeResponseSchema = Type.Object({
  attemptId: Id,
  position: Type.Integer(),
  score: Type.Number(),
  attemptStatus: Type.Union([Type.Literal('submitted'), Type.Literal('graded')]),
  attemptScore: Nullable(Type.Number()),
  pendingManual: Type.Integer(),
});
export const FeedbackRequestSchema = Type.Object({
  feedback: Nullable(Type.String({ maxLength: 5000 })),
});

/** One attempt as the instructor sees it: every answer, the key, marks, feedback and the integrity log. */
export const ScriptSchema = Type.Object({
  attempt: AttemptRowSchema,
  feedback: Nullable(Type.String()),
  events: Type.Array(Type.Object({ kind: EventKindSchema, at: DateTime })),
  questions: Type.Array(
    Type.Object({
      position: Type.Integer(),
      questionId: Id,
      type: Type.String(),
      points: Type.Number(),
      dropped: Type.Boolean(),
      stem: RichTextSchema,
      options: Type.Array(LearnerOptionSchema),
      images: Type.Array(QuestionImageSchema),
      answer: Nullable(AnswerSchema),
      key: Type.Any(),
      score: Nullable(Type.Number()),
      state: Type.Union([Type.Literal('na'), Type.Literal('pending'), Type.Literal('graded')]),
      feedback: Nullable(Type.String()),
      spentSeconds: Type.Integer(),
    }),
  ),
});

// ------------------------------------------------------------------ regrade, release, analysis
export const RegradeRequestSchema = Type.Object({
  questionId: Id,
  /** rekey: score again with another VERSION of the question (same options); drop: the question no longer counts;
   * credit: everybody gets the points */
  action: Type.Union([Type.Literal('rekey'), Type.Literal('drop'), Type.Literal('credit')]),
  toVersionId: Type.Optional(Id),
  /** true: only show what would change */
  dryRun: Type.Boolean(),
});
export const RegradeResponseSchema = Type.Object({
  applied: Type.Boolean(),
  runId: Nullable(Id),
  affectedAttempts: Type.Integer(),
  changedScores: Type.Integer(),
  averageBefore: Nullable(Type.Number()),
  averageAfter: Nullable(Type.Number()),
  /** the biggest changes first (at most 100) */
  changes: Type.Array(
    Type.Object({
      attemptId: Id,
      learnerName: Type.String(),
      before: Nullable(Type.Number()),
      after: Nullable(Type.Number()),
      maxBefore: Nullable(Type.Number()),
      maxAfter: Nullable(Type.Number()),
    }),
  ),
});
export type RegradeResponse = Static<typeof RegradeResponseSchema>;
export const RegradeHistorySchema = Type.Object({
  items: Type.Array(
    Type.Object({
      id: Id,
      questionId: Id,
      action: Type.String(),
      affectedAttempts: Type.Integer(),
      createdAt: DateTime,
      createdByName: Nullable(Type.String()),
    }),
  ),
});

export const ReleaseRequestSchema = Type.Object({
  /** omit to release every graded attempt of the assessment */
  attemptIds: Type.Optional(Type.Array(Id, { maxItems: 2000 })),
});
export const ReleaseResponseSchema = Type.Object({
  released: Type.Integer(),
  /** attempts still waiting for a person to grade them (they are NOT released) */
  stillPending: Type.Integer(),
});

export const AnalysisSchema = Type.Object({
  attempts: Type.Integer(),
  averagePercent: Nullable(Type.Number()),
  averageMinutes: Nullable(Type.Number()),
  questions: Type.Array(
    Type.Object({
      questionId: Id,
      type: Type.String(),
      stem: RichTextSchema,
      points: Type.Number(),
      answered: Type.Integer(),
      total: Type.Integer(),
      correctPercent: Nullable(Type.Number()),
      averagePercent: Nullable(Type.Number()),
      averageSeconds: Nullable(Type.Number()),
      /** choice questions: how often each option was picked */
      options: Type.Array(
        Type.Object({
          id: Type.String(),
          text: RichTextSchema,
          picked: Type.Integer(),
          correct: Type.Boolean(),
        }),
      ),
    }),
  ),
});
export type AnalysisDto = Static<typeof AnalysisSchema>;

/** What the gradebook (step 11) reads: the score that counts per learner and assessment. */
export interface AssessmentFinalScore {
  itemId: string;
  participantId: string;
  attemptsGraded: number;
  score: number;
  maxScore: number;
  percent: number;
  scoring: 'highest' | 'latest' | 'average';
  released: boolean;
  passingScore: number | null;
}

export const ReplaceSlotsResponseSchema = Type.Object({ slots: Type.Integer() });
