import { describe, expect, it } from 'vitest';
import { buildArchive, countsOf } from '../privacy.archive';

const AT = new Date('2026-03-10T09:00:00Z');

describe('the archive builder (pure)', () => {
  it('makes a README, the account file and one CSV per section, even for an empty person', () => {
    const files = buildArchive({}, AT);
    const names = files.map((f) => f.name);
    expect(names).toContain('README.txt');
    expect(names).toContain('account.json');
    expect(names.filter((n) => n.endsWith('.csv'))).toHaveLength(9);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[A-Za-z0-9._-]+$/);
    // an empty section is a CSV with its header only
    const enrol = files.find((f) => f.name === 'enrolments.csv');
    expect(enrol?.content.trimEnd().split('\r\n')).toHaveLength(1);
  });

  it('writes a value that would run as a formula as text (apostrophe), and quotes commas, quotes and line breaks', () => {
    const files = buildArchive(
      {
        enrolments: [
          {
            courseCode: '=HYPERLINK("http://x")',
            courseTitle: '+1+1',
            offering: '@SUM(A1)',
            term: '-2+3',
          },
          { courseCode: 'a,b', courseTitle: 'say "hi"', offering: 'two\nlines', term: '\tTAB' },
        ],
      },
      AT,
    );
    const csv = files.find((f) => f.name === 'enrolments.csv')?.content ?? '';
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain("'+1+1");
    expect(csv).toContain("'@SUM(A1)");
    expect(csv).toContain("'-2+3");
    expect(csv).toContain('"a,b"');
    expect(csv).toContain('"say ""hi"""');
    expect(csv).toContain('"two\nlines"');
    expect(csv).toContain("'\tTAB");
  });

  it('counts the rows of each section and says so in the README, with what the archive leaves out', () => {
    const doc = { enrolments: [{}, {}], progress: [{}] };
    expect(countsOf(doc)).toMatchObject({ enrolments: 2, progress: 1, quizAttempts: 0 });
    const readme = buildArchive(doc, AT).find((f) => f.name === 'README.txt')?.content ?? '';
    expect(readme).toContain('2026-03-10T09:00:00.000Z');
    expect(readme).toMatch(/enrolments\.csv\s+2 row/);
    expect(readme).toContain('other people');
    expect(readme).toContain('not been released');
    expect(readme).toContain('7 days');
  });

  it('writes booleans as yes / no and documents as JSON text', () => {
    const files = buildArchive(
      {
        courseGrades: [{ isPass: true }],
        assignmentGrades: [{ feedback: { type: 'doc' } }],
      },
      AT,
    );
    expect(files.find((f) => f.name === 'course-grades.csv')?.content).toContain('yes');
    expect(files.find((f) => f.name === 'assignment-grades.csv')?.content).toContain(
      '""type"":""doc""',
    );
  });
});
