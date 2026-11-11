# ADR 0018: Assignments (Step 10)

Status: accepted (Step 10). Builds on [ADR 0013](0013-courses-content-storage.md) (content items, files),
[ADR 0016](0016-learning-progress.md) (progress, the learner gate) and [ADR 0017](0017-assessments.md) (versions, definer functions
for learners, accommodations, the final-scores interface).

## Context

An assignment is the one graded activity where the learner's work is a FILE: large, arriving in a wall at the deadline, written by a
person the grader may know. Four things are hard and are decided here: what "on time" means when the network is slow; what a late
penalty is and when it is frozen; how a grader can be blind in a way that cannot leak; and how to hand 500 submissions to an
instructor without holding them in memory.

## Decision

### Submissions are history

- A hand-in writes a new immutable **version** (`submissions`; `lms_app` can neither update nor delete it). The version with the
  highest number counts. Files of a version are `submission_files` (`ON DELETE RESTRICT`); nothing that holds academic history
  cascades from a participant, an item or a file. The files purge keeps every file that a version, an attachment or a feedback
  file refers to.
- Uploads first: `POST .../files` records a pending file and a **draft** entry (`assignment_uploads`, ephemeral, it MAY cascade) in
  one call; the browser PUTs the bytes to the signed URL (the API streams them to storage and never buffers them); `.../confirm`
  reads the bytes, checks size and type against the content, and the file becomes `ready`. A draft nobody hands in is purged with
  its file after the grace period of the files purge.
- Handing in (`assignment_submit`, one definer call, 2 round trips with the session lookup) takes the READY drafts, text and / or a
  link, and writes version n+1, the file links and the learner's progress in one transaction, under an advisory lock per learner
  and assignment. A client-made `request_key` (unique per learner and assignment) makes the same request sent twice ONE version.

### Deadline fairness: the server clock, and a grace for uploads that began in time

The server's finalize time decides. An upload that **began** before the due date (`assignment_uploads.created_at`) and is finalized
within `ASSIGNMENT_UPLOAD_GRACE_MINUTES` (default 10) counts **on time** (`on_grace` is kept on the version, so the instructor sees
why). The rule is in the database function and nowhere else; the learner's page states it, shows THEIR due date with a countdown
that follows the server's clock (the browser only measures elapsed time), and says what handing in right now would cost.
A per-learner **extension** moves the due date and, by the same amount, the hard cutoff. Its reason is private like an
accommodation's: only `assignment.view_extensions` (instructors, institution admins, not assistants) reads it; it is never in a
list, an export or the audit entry (the entry has the dates).

### Late penalty

`late_policy`: `none` (nothing after the due date) or `allowed` until a hard cutoff. The penalty is a percentage of the MAXIMUM
points: per started day (one second late is one day) or once, capped. The version stores `late_seconds`; the percentage is
computed from the policy until the grade is **released**, then frozen on the grade (`penalty_percent`), so changing the policy
afterwards never moves a released score. The grade shows raw score, penalty and final score separately; the penalty can be
**waived with a reason** (audited with the reason, instructors only: `grade.finalize`) and restored.

"Latest overall counts" has one sharp edge: a LATE version replacing an ON-TIME one would silently cost the learner points they had
already earned. So that case does not write: the call answers `confirm_late` with the exact figures the server computed (late
time, percent, points, the version it would replace), and only the same request repeated with `confirmLate` writes. A learner with no on-time
version, and a late version after a late one, are not asked.

### Rubrics

Per course, versioned like questions (`rubric_versions` immutable; criteria and levels have random ids kept through edits). An
assignment pins the VERSION when the rubric is attached (and cannot swap to another rubric once grades exist). Grading checks and
sums the selection IN SQL against the pinned version in the same statement that writes the grade, so a client cannot send a score
that the rubric does not give; a score that differs from the rubric is an **override** and needs a reason. Cross-course attachment
is impossible by composite foreign key.

### Blind grading

`anonymous_grading` makes the database NULL the name, e-mail and register number in every row that leaves it (queue, learner view,
ZIP index), until THAT learner's grade is released, or the setting is switched off (audited). Learners are addressed by a random
`learner_key` (`gen_random_uuid()`: a time-ordered id would reveal the order they were created in) and show an anonymous code.
The queue is ordered by the code or the submission time, never by anything that identifies a person: ordering by name is refused
(400) while blind. A grader's download of a file gets a neutral name (the file's own name may hold the learner's). A sentinel test
puts a name, e-mail, register number and the ids of every learner in everything a grader receives and asserts none appears; what a
grader reads inside a submission (a text that signs its name) cannot be scrubbed, and the instructions say so.

### Files from learners are the highest-risk path

Programs and scripts are refused for assignments whatever the instructor allows (a block list on top of the general allowlist; the
server decides the type from the extension AND the first bytes). A grader's download is an `attachment` for everything except PDF,
PNG and JPEG; the storage answers with `nosniff` and a sandboxing CSP. A ZIP inside a submission is accepted when the allowlist has
it and is never opened by the server. **There is no malware scanning yet: see the TODO in CLAUDE.md. This is the first path to
close before production.**

Previewing a PDF was tested before it was built: **Chromium refuses a PDF in a sandboxed `<iframe>`** (`chrome-error://`, with or
without our CSP; the default headless shell has no PDF viewer at all). The same file served with our headers (`inline`, `nosniff`,
`default-src 'none'; sandbox`) opens fine as a top-level page in a new tab. So the grading screen shows images (`<img>`) and plain text
inline and offers "Open in the browser viewer" for a PDF; pdf.js is not added. An E2E test in a FULL Chromium (`channel: 'chromium'`)
keeps both halves true: it fails the day a Chromium accepts the sandboxed iframe, and then the preview can be made inline.

### The bulk ZIP

`GET .../submissions.zip`: every learner's LATEST version, a folder per learner (register number; the anonymous code while blind),
the files, `submission.txt` / `link.txt`, and a formula-safe `index.csv`. The writer (`core/zip.ts`) is our own, store-only (the
files are already compressed), with data descriptors and ZIP64, streaming from storage one object at a time: memory does not grow
with the number of submissions (measured in `docs/benchmarks.md`). Every name written into it goes through `safeFileName`
(separators, `..`, control and right-to-left characters, Windows device names, leading dots, length; unique per folder): a name
that is still unsafe at the writer throws instead of being written (zip-slip). The writer is validated by tools that are NOT ours:
`unzip -t` and Python's `zipfile` on generated archives (also the ZIP64 form), in CI as well as locally.

### Copying an offering

The copy brings assessments (settings, and the questions within the SAME course) and assignments (settings, instructions,
attachments as shared files, and the rubric within the same course) with their dates moved by the difference of the two terms'
start dates; the instructor sees a preview (`GET /offerings/:id/copy-preview`) and can change the shift or copy without dates
(visibility "after close" falls back to manual when the close date is cleared). Never copied: attempts, submissions, grades,
extensions, accommodations, drafts, blind keys, progress. The statement inserts the settings itself; the default-row triggers are
`ON CONFLICT DO NOTHING` fallbacks. A copy of more than 500 items still runs as a job and its payload carries the shift.

### Rate limits are per session

Computer labs share one public address. Authenticated requests are limited **per session** (a hash of the cookie), anonymous ones
per address; a forged cookie that resolves to no session counts against the address in a second limiter, so inventing cookies does
not buy a fresh budget. Tested with 60 users behind one address. A saturated database pool answers **503 `busy` with Retry-After**
(not a 500): every call of the hand-in flow is idempotent, so clients retry.

## Consequences

- The grading statement and the ZIP manifest are one statement each; the first open of the queue creates the random keys of the
  class (one more statement, once).
- The gradebook (step 11) reads `assignmentsService.finalScores()` / `lms.assignment_final_scores`: the score after the penalty,
  the penalty, whether it is released.
- Not built: malware scanning; per-learner late policies; group submissions; plagiarism checks; peer review; a grade history
  beyond the audit log; notifications of released grades; the instructor's per-item date overrides on copy (one shift for all).
