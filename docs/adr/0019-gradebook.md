# ADR 0019: The gradebook (Step 11)

Status: accepted (Step 11). Builds on [ADR 0013](0013-courses-content-storage.md) (offerings, participants), [ADR 0017](0017-assessments.md)
(attempts, `results_visible`) and [ADR 0018](0018-assignments.md) (grades, release, the final-scores interface).

## Context

A gradebook turns the marks of many sources (quizzes, assignments, marks earned outside the LMS) into ONE number per learner, and that
number goes into a record a college keeps for years. Four things are hard and are decided here: what "exact" means when marks are
divided; how a learner is shown a number that never depends on something they may not see; what "locked" means; and who may approve.

## Decision

### One calculation, in SQL, with exact fractions

`lms.gradebook_compute(tenant, offering, mode, participants, explain)` is the ONLY place a number is made. The instructor's grid, the
learner's page, the explanation of a final and the lock snapshot all call it, so they cannot disagree, and the explanation is built from the
same intermediate rows as the number (it is not recomputed in TypeScript).

- **No division before the end.** `numeric` divides inexactly (1/3 + 1/3 + 1/3 = 0.999...), and a tie such as "0.5 marks" must be decided on the
  true value. Earned points travel as fractions (`lms.frac`), added by an aggregate that only multiplies; a category percent, the weights and
  `out_of` are combined as one fraction; the SINGLE rounding at the end uses `div` and `mod` of numerics, which are exact
  (`lms.round_frac`: half up, half to even, down, up; 0 to 2 decimals). Percentages shown to the eye are divisions rounded for display and
  never feed a later step.
- **Rules.** Category percent = sum of what counts / sum of the maximum of what counts. Extra credit adds to earned, not to the maximum, and is
  never dropped. Drop-lowest removes the N lowest percents (ties: smaller maximum, then position), never the last counted item. Weighted: the
  weights of the categories that have something to count are renormalised ("weights that add up to 100" is a submit precondition, not a
  calculation assumption). Missing work is `exclude` or `zero_after_due` per category; "after due" is the learner's own deadline (an extension
  or accommodation moves it). A missing MANUAL mark counts as zero only after the item is released or its `due_at` has passed (so a new manual
  column never lowers anybody's provisional total). Work handed in but not graded is "pending", never zero.
- **The grade** is the band of the scale with the highest floor not above the ROUNDED final as a percent of `out_of` (cross-multiplied, exact):
  what the learner reads and the letter always agree.
- **Verification.** `gradebook.calc.test.ts` has every rule as a test and a property test (fast-check): random weights, drops, missing
  policies, extra credit, overrides and rounding against a deliberately simple TypeScript reference with BigInt rationals; the database and the
  reference must agree EXACTLY, in the staff view and in the learner view.
- **Auto items are linked explicitly** with a `points` value (an assessment's or assignment's maximum by default) and scaled: earned =
  score / max x points, as a fraction. The released flag of an assessment follows the rule of the LEARNER's own page (`results_visible`: immediate,
  after the close date, manual release), per attempt, and an item counts as released only when EVERY graded attempt it is based on is visible.
  (Step 9's `assessment_final_scores` reports only the manual release, so a quiz with immediate results would look unreleased for ever; it is
  left as it is and the gradebook has its own function, `gradebook_assessment_scores`.)

### What a learner can see

`gradebook_me` (definer, 2 round trips) calls the same function in `learner` mode: an item that is not released does not exist for the
learner. It has no state, no title, no count, no mention in the explanation; a missing mark of an unreleased manual item is not a zero; a final
override and every override reason are invisible; the "grade" of a provisional total is not shown. Locked and approved: the learner sees the
frozen record. After an unlock they see provisional figures with an "under revision" notice, never the old final. The sentinel test
(`gradebook.learner.test.ts`) plants an unreleased mark with a recognisable name in every source (quiz, assignment, manual item, item override,
final override) and greps everything a learner receives.

### Workflow, lock, versions

`draft` -> `submitted` -> `returned` (back to the instructor with a comment) or `locked`. Structure, marks and overrides change only in `draft`
and `returned`. Submitting needs: an item, weights of 100 (weighted), a scale, and every item with marks released or published, so a final
never depends on something a learner cannot see. Approving freezes, in ONE statement, a version row (the structure, scale and bands as they
were) and one snapshot row per learner (identity at that moment, every cell, category totals, final, grade, the explanation).
`gradebook_versions`, `gradebook_snapshot_rows`, events and mark history are append-only for EVERYONE (a trigger refuses UPDATE and DELETE for
the owner too; `lms_app` also lacks the privilege). An unlock needs an admin and a reason (audited), opens version n+1 as a draft and keeps
the old snapshot. Later changes to scores or policies never alter a locked snapshot (tested: change a mark and an attempt score after the lock).
Foreign keys into history are `ON DELETE RESTRICT`.

**Left out of a snapshot**: learners removed from the offering or from the college. The approval screen lists each with the reason before
the admin approves (a confirmation is required), and the same list is stored in the version.

### Approval

Permissions: `gradebook.read` (instructors, assistants, administrators), `gradebook.manage` (instructors), `gradebook.enter_marks` (instructors;
assistants only in items that allow it), `gradebook.override`, `gradebook.approve` and `gradescale.manage` (institution admins). A college
setting `allowSelfApproval` (default OFF) lets the person who submitted also approve or return. When off, the attempt answers 403 with a clear
message and is audited anyway (the function returns normally so the audit row is committed); an allowed self-approval is recorded as such in
the event, the version and the audit entry.

### Marks, CSV, export

- The grid saves batches (<= 5,000 cells) in one statement with the stale-cell check (`expected`): a cell changed by someone else meanwhile is
  reported, not overwritten; every change is written to the mark history in the same statement; the answer carries the recomputed rows of the
  learners touched, so the screen updates in place.
- The CSV import stages cells (`mark_import_cells`), validates them in one set-based UPDATE (register number, number format, maximum, who may
  write the column) and applies in one statement; a row with any error is skipped as a whole. Formula-looking cells never become marks.
- **XLSX has no library.** The sheet XML is written next to `core/zip.ts`: marks are numeric cells, text is an inline string, and no code path
  emits `<f>`. That, not escaping, is the injection protection of XLSX; CSV keeps the apostrophe rule. CI opens the file in LibreOffice headless.
  The layout (columns, order, headings) is stored per offering.

### Performance

See `docs/benchmarks.md` (Step 11). The statement is linear in cells and stable with and without statistics once the planner is kept from
choosing nested loops (`SET enable_nestloop = off` on the function: with the parameters unknown a fresh college took 47 s instead of 1 s).
It does not reach the hoped-for ~100 ms for 500 x 60: that is a known gap.

## Consequences

- The calculation cannot be changed without changing the property test's reference, on purpose.
- A gradebook of 1,200 learners computes in a few seconds of database time; the grid streams it in chunks of 500.
- Copying an offering does not copy the gradebook (nothing asks for it yet).
