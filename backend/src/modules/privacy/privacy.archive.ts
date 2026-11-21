import { csvLine } from '../../core/csv';

// Pure: the collected JSON document of lms.privacy_export_collect -> the files of the archive. No database, no storage.
// Every CSV cell goes through core/csv (a leading = + - @ tab or CR gets an apostrophe: a name that is a formula stays text).

export interface ArchiveFile {
  name: string;
  content: string;
}

type Row = Record<string, unknown>;

interface Section {
  file: string;
  key: string;
  columns: readonly [header: string, field: string][];
}

const SECTIONS: readonly Section[] = [
  {
    file: 'enrolments.csv',
    key: 'enrolments',
    columns: [
      ['Course code', 'courseCode'],
      ['Course', 'courseTitle'],
      ['Offering', 'offering'],
      ['Term', 'term'],
      ['Role in the course', 'participation'],
      ['Status', 'status'],
      ['Since', 'since'],
    ],
  },
  {
    file: 'progress.csv',
    key: 'progress',
    columns: [
      ['Course code', 'courseCode'],
      ['Offering', 'offering'],
      ['Item', 'item'],
      ['Status', 'status'],
      ['Completed at', 'completedAt'],
      ['Completed how', 'completedHow'],
      ['Seconds watched', 'watchedSeconds'],
      ['First seen', 'firstSeenAt'],
      ['Last activity', 'lastActivityAt'],
    ],
  },
  {
    file: 'quiz-attempts.csv',
    key: 'quizAttempts',
    columns: [
      ['Course code', 'courseCode'],
      ['Offering', 'offering'],
      ['Quiz', 'quiz'],
      ['Attempt', 'attempt'],
      ['Status', 'status'],
      ['Started', 'startedAt'],
      ['Submitted', 'submittedAt'],
      ['Score (only once released)', 'score'],
      ['Out of', 'maxScore'],
    ],
  },
  {
    file: 'assignment-submissions.csv',
    key: 'assignmentSubmissions',
    columns: [
      ['Course code', 'courseCode'],
      ['Offering', 'offering'],
      ['Assignment', 'assignment'],
      ['Version', 'version'],
      ['Submitted', 'submittedAt'],
      ['Late (seconds)', 'lateSeconds'],
      ['Text you submitted', 'text'],
      ['Link you submitted', 'link'],
    ],
  },
  {
    file: 'assignment-grades.csv',
    key: 'assignmentGrades',
    columns: [
      ['Course code', 'courseCode'],
      ['Offering', 'offering'],
      ['Assignment', 'assignment'],
      ['Raw score', 'rawScore'],
      ['Late penalty (percent)', 'penaltyPercent'],
      ['Final score', 'finalScore'],
      ['Out of', 'maxScore'],
      ['Feedback (document)', 'feedback'],
    ],
  },
  {
    file: 'course-grades.csv',
    key: 'courseGrades',
    columns: [
      ['Course code', 'courseCode'],
      ['Offering', 'offering'],
      ['Gradebook version', 'version'],
      ['Approved at', 'lockedAt'],
      ['Final marks', 'finalMarks'],
      ['Final percent', 'finalPercent'],
      ['Grade', 'grade'],
      ['Pass', 'isPass'],
    ],
  },
  {
    file: 'activity-days.csv',
    key: 'activityDays',
    columns: [
      ['Day', 'day'],
      ['First activity', 'firstAt'],
    ],
  },
  {
    file: 'notification-preferences.csv',
    key: 'notificationPreferences',
    columns: [
      ['Category', 'category'],
      ['Email', 'email'],
      ['In the app', 'inApp'],
    ],
  },
  {
    file: 'notifications.csv',
    key: 'notifications',
    columns: [
      ['Category', 'category'],
      ['Type', 'type'],
      ['Created', 'createdAt'],
      ['Read', 'readAt'],
    ],
  },
];

const cell = (v: unknown): string | number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return JSON.stringify(v);
};

export const SECTION_KEYS = SECTIONS.map((s) => s.key);

/** rows per section (numbers only): stored with the export and shown to the member */
export function countsOf(doc: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of SECTIONS)
    out[s.key] = Array.isArray(doc[s.key]) ? (doc[s.key] as Row[]).length : 0;
  return out;
}

export function buildArchive(doc: Record<string, unknown>, generatedAt: Date): ArchiveFile[] {
  const files: ArchiveFile[] = [];
  const counts = countsOf(doc);
  files.push({
    name: 'README.txt',
    content: [
      'Your data in this college',
      `Prepared: ${generatedAt.toISOString()}`,
      '',
      'This archive holds the data the college keeps ABOUT YOU, in the college where you asked for it:',
      '  account.json                  your account, your membership and your profile',
      ...SECTIONS.map((s) => `  ${s.file.padEnd(30)}${counts[s.key]} row(s)`),
      '',
      'What it does NOT hold, on purpose:',
      "  - other people's data (classmates, instructors, anyone else);",
      '  - grades and quiz scores that have not been released to you yet (you see them when they are);',
      "  - your instructors' private notes, and reasons recorded for accommodations, extensions or overrides;",
      "  - integrity logs of quizzes, the college's audit log, and e-mails that were sent to you;",
      '  - your data in any OTHER college you belong to (ask there).',
      '',
      'The CSV files open in a spreadsheet. A value that starts with = + - or @ is written with a leading apostrophe so that',
      'it stays text. This file is a copy: it will be deleted from our servers 7 days after it was prepared.',
      '',
    ].join('\r\n'),
  });
  files.push({
    name: 'account.json',
    content: `${JSON.stringify(
      {
        account: doc.account ?? null,
        membership: doc.membership ?? null,
        profile: doc.profile ?? null,
      },
      null,
      2,
    )}\n`,
  });
  for (const s of SECTIONS) {
    const rows = Array.isArray(doc[s.key]) ? (doc[s.key] as Row[]) : [];
    files.push({
      name: s.file,
      content:
        csvLine(s.columns.map(([h]) => h)) +
        rows.map((r) => csvLine(s.columns.map(([, f]) => cell(r[f])))).join(''),
    });
  }
  return files;
}
