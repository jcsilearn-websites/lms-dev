# ADR 0017: Quizzes and exams (Step 9)

Status: accepted (Step 9). Builds on [ADR 0013](0013-courses-content-storage.md) (content items, files),
[ADR 0016](0016-learning-progress.md) (progress, the learner gate) and the job queue ([ADR 0010](0010-job-queue-bulk-import-academics.md)).

## Context

An exam is the one place where the server must not trust the browser: the clock, the answers and the "I submitted" are all
claims. It is also the one place where load arrives in a wall: 1,500 learners start within a minute, save for an hour, and
hand in together. And it holds the most sensitive data of the product: the answer key (a leak ends the exam) and accommodations
(they can reveal a disability or a health condition).

## Decision

### Question bank and versions

- Questions belong to a **course** (`questions`, `course_id`), shared by every offering of it. The permission is granted by
  participation in **any offering of the course** (`scope: 'course'` routes, `courseAccessCte`): instructors manage, assistants
  and administrators read.
- Editing never changes a row: it adds a `question_versions` row (immutable; `lms_app` can only INSERT) and moves
  `current_version_id`. An attempt points at the exact versions it showed.
- A version has two halves in two columns: `presentation` (stem, options without correctness, images, word limit: what a
  learner may be sent) and `answer_key` (correct options, numeric value and tolerance, accepted answers, explanation: what must
  not leave before release). Every learner-facing function builds its output from `presentation` field by field.
- **Option ids are random** (12 hex characters), never the position or the authoring order. An option kept through an edit keeps
  its id (that is what lets a regrade re-score against a corrected key); a new option gets a new one. A test generates 40
  questions and checks the ids do not follow the authoring order.
- Types: single choice, multiple choice (optional partial credit: each right option earns a share, each wrong one takes one
  away, never below zero), true / false, numeric (absolute or percent tolerance), short answer (NFKC, trim, collapse spaces,
  lower case; a list of accepted answers, or manual), essay (manual). Scoring is ONE pure SQL function (`score_answer`) used set
  based at submit and at regrade.
- Images use the existing files system. Files carry no offering, so a question image needs no new owner scope: the upload route
  is course-scoped (`POST /courses/:id/files`, PNG / JPEG only), `question_files` references keep the purge away, and the
  **learner download route checks that the file is referenced by a version shown in THAT learner's own attempt**.
- CSV import of choice questions: synchronous, at most 1,000 rows, staged in `question_import_rows`, validated per row with the
  formula-injection rules of the member import (same `checkCell`), confirmed with `skipInvalid` when rows are bad; a staged
  import nobody confirms is removed after a day.

### The attempt engine (server authoritative)

An assessment is a content item of kind `assessment` (completion `on_submit`); its settings are in `assessments`, its questions
in `assessment_slots`: a **fixed** question, or a **pool** `(tag, difficulty, count)`. Several pools with different
difficulties give every learner a different paper with the **same mix**.

- **Start** is ONE call of the definer function `assessment_start` (2 round trips with the session lookup): the learner gate of
  Step 8, the window, the attempts allowed, the draw (`assessment_draw`: fixed + random picks, never the same question twice),
  the shuffles of questions and options, and the **server deadline** `least(start + limit + accommodation, close)`. With neither a
  limit nor a close date the attempt ends after 24 hours: nothing stays open forever. A partial unique index allows one
  in-progress attempt per learner and assessment, so two tabs starting at once get the same attempt.
- **Nothing the server sends contains the key**, by construction of the read functions; a test seeds sentinels in every key and
  explanation and asserts none appears in any learner response in any state. Learner reads are definer functions on an
  autocommit connection; `lms_app` can UPDATE only the grading columns of `attempts` / `attempt_questions`.
- **Autosave** (`attempt_save`, 2 round trips): a batch of changed answers. Each carries a **revision**; a change is applied only
  when `(rev, client_at)` is higher than the stored one, so a retry, an older tab or a stale device never overwrites a newer edit.
  Everything not applied comes back in `stale` with the server's value and the client adopts it. The attempt read returns each
  question's server revision and **a client always continues from it**. Saves are refused after `deadline + grace` (30 s, a
  setting) and the attempt is closed there and then.
- **Submit** (`attempt_submit`) locks the attempt row and finalises it; repeated or racing calls get the same answer.
  `attempts_finalize` scores a SET of attempts in one statement (objective questions; essays and manual short answers become
  `pending`), sets the totals, the status (`graded` or `submitted`) and marks the item completed in the learner's progress.
- **Auto-submit**: the scheduled handler `assessments.sweep` calls `assessment_sweep`, which closes attempts past
  `deadline + grace` in batches of 200 with `FOR UPDATE SKIP LOCKED` (any number of workers, each attempt closed once). Reads
  of an expired attempt close it lazily, so the page never shows an open attempt that is over.
- **Integrity log** (`attempt_events`, at most 300 per attempt): tab hidden / visible, window blur / focus, connection lost /
  back, page opened. It is information for the instructor and says so on screen. It **can** show that the page was left and
  when. It **cannot** show another device, another person, notes or a phone, and a hidden tab may be a call or a notification.
  It is not proctoring and never decides anything.

### Accommodations

Per learner: extra minutes and / or a later close date, set by instructors, audited. The reason is optional, carries a hint not to
write medical details, is readable only by instructors and institution administrators (`assessment.view_accommodations`: not
assistants), is never joined into a list or export, and is **not in the audit entry** (minutes and dates, before and after, and
who). Results that wait for the close date wait for the latest extended close too, so an extended learner is never still working
while others see the answers.

### Grading, regrade, release, analysis

- Grading by question or by student; points and feedback; a mark is validated against the question's points; the attempt becomes
  `graded` when nothing waits. Assistants grade; instructors regrade, release and see the analysis.
- **Regrade** (`rekey` with another version, `drop`, `credit`) is one set-based statement over every attempt that showed the
  question, with a dry run that returns before / after. A rekey is refused unless the option ids of the shown versions and the new
  one are the same (a different set of options is a different question: drop it or give credit). A mark a person gave is never
  replaced by a rekey. Runs and per-attempt changes are kept (`regrade_runs`, `regrade_changes`) and audited.
- **Release** (when results are manual) sets `released_at` on fully graded attempts and reports how many still wait. Result and
  answer visibility are two settings, decided in one SQL function (`results_visible`).
- Item analysis is aggregated from the rows when asked: percent correct, option distribution, average score and time.
- The score that counts (highest / latest / average of the fully graded attempts) is exposed to the gradebook of Step 11 as
  `lms.assessment_final_scores(tenant, offering)` and `assessmentsService.finalScores()`; no gradebook is built here.

### Frontend

The exam screen is its own small chunk (no editor, no validators). The **answer queue** is plain TypeScript, unit tested:
save on change (debounced about 1.8 s), at once on leaving a question, hiding the page, going online and before submit, never on
a timer when nothing changed; every change is written to `localStorage` before it is sent and removed only when acknowledged; on
load the stored queue is merged with the server's state (a higher revision wins) and flushed **before** the screen says "Saved".
The countdown uses the monotonic timer from the moment the server's clock arrived, so a device clock change moves nothing. The
paper and the session answer are also kept in this browser so that a reload **while the API is unreachable** still opens the
exam with the learner's answers (the page assets themselves must come from the browser's cache: a full offline start needs a
service worker, which is not built).

## Consequences

- Autosave, start and submit each cost 2 round trips and use only unique-key lookups; nothing scans the class per request.
  Measured numbers: `docs/benchmarks.md` (Step 9).
- A regrade cannot change what an attempt showed, only how it is scored, and only when the options did not change.
- A learner on a bad connection can keep answering and reload; what the browser cannot keep (a cleared storage, a different
  device while offline) is lost until the connection returns, and the 30 s grace is the only slack the server gives.
- Known gaps: no proctoring, no per-question time limits, no question bank sharing across courses, copying an offering brings
  assessment items with default settings (dates and questions are set again), no gradebook, no notifications.
