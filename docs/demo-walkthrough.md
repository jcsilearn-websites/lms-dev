# JCS iLearn: demo walkthrough (20 minutes)

For the person presenting to a college decision-maker. The demo runs on one laptop. Part A sets it up, Part B is the script,
Part C is the pre-demo checklist, Part D is what not to show or promise.

Everything in the demo college is invented: the college, the people, their marks. Their addresses end in `.example`, which can never
receive mail. Say so if anyone asks whose data it is.

## A. Setup

### A1. The demo college

Needs: PostgreSQL 17 running, `pnpm db:migrate` done, ffmpeg on the PATH, the usual `.env`.

```bash
pnpm demo:seed     # first time: about 40 seconds
pnpm demo:reset    # removes the demo college and makes it again (before every rehearsal and before the real demo)
```

Both print the sign-in details and save them to `.demo/demo-nilgiri.json` (never committed). Options: `--password <12+ characters>`
to keep the same password across resets, `--slug demo-<name>` for another college.

Both refuse to run with `NODE_ENV=production`, on Cloud Run, against a database host that is not this machine (or listed in
`DEMO_ALLOWED_HOSTS`), or with a slug that does not start with `demo-`. **Stop the app first if the seed says the set-up link was not
sent**: a running worker took the e-mail.

**What is in it.** Nilgiri College of Engineering (Demo) at `http://demo-nilgiri.localhost:5173`:

| Who               | Address (`@demo-nilgiri.example`) | Notes                                 |
| ----------------- | --------------------------------- | ------------------------------------- |
| Institution admin | `principal`                       | Dr. Meena Raghavan. Two-step sign-in  |
| Instructor        | `arjun.nair`                      | Data Structures (CS201)               |
| Instructor        | `farida.sheikh`                   | Engineering Mechanics (ME101)         |
| Assistant         | `karthik.iyer`                    | Data Structures                       |
| Learner           | `ananya.krishnan`                 | The learner of the script (one of 30) |

All accounts have the same password. Two courses with lectures (30-second placeholder clips), readings, quizzes, assignments with
rubrics and gradebooks; 30 days of activity; 11 learners flagged in Data Structures; the CS201 gradebook waiting for approval; ME101
hand-ins waiting to be graded; five new students to import in `.demo/demo-nilgiri-new-students.csv`.

### A2. Two-step sign-in in the demo

**Two-step sign-in stays enforced.** The seed enrols the administrator through the product's own set-up (password, e-mailed link, first
code) and prints the authenticator secret and ten one-time recovery codes. Nothing is switched off and no special demo path exists.
Instructors and learners do not have a second step.

- After each `demo:reset` the secret is **new**. In your authenticator app (Google Authenticator, Microsoft Authenticator, Aegis):
  delete the old entry, add a new one with "enter a setup key", account `Nilgiri demo`, the printed key, time based.
- No phone at hand: on the code screen choose "Use a recovery code instead". Each code works once.
- The secret and codes are in `.demo/demo-nilgiri.json`. Never show that file or the terminal on the projector.

### A3. Your own recorded lectures

```bash
pnpm demo:video "D:\lectures\trees.mp4" --course CS201 --item "Lecture 2: Stacks and queues"
pnpm demo:video "D:\lectures\trees.mp4" --course CS201 --item "Lecture 3: Trees" --module "Unit 3: Trees"
```

The first replaces the recording of an existing video item; the second makes a new item in that module (when no item has that title).
It uses the product's real pipeline: resumable upload, ffmpeg to 360p / 480p / 720p (never enlarged), signed HLS playback. Works
whether or not the app is running. **Run it again after every `demo:reset`**, which removes the college and its videos.

| Accepted                                             | Limit                                                     |
| ---------------------------------------------------- | --------------------------------------------------------- |
| `.mp4`, `.mov`, `.mkv`, `.webm` with one video track | 2 GB, 3 hours, each side 64 to 4096 pixels, up to 120 fps |

**Time** (measured on the development laptop, 720p source): a slide-style lecture takes about a quarter of its length (an hour of video
in about 15 minutes); a high-motion recording up to two thirds of it (about 40 minutes per hour). A 1080p source has not been measured and
will be slower. Add your lectures the day before, with the laptop plugged in. The local pipeline is for development and demos only.

### A4. A hosted demo later

These commands are for this laptop. `DEMO_ALLOWED_HOSTS` lets them reach another database, but they write files through the local
storage driver of the machine they run on, and production refuses both them and the local video provider. A hosted demo needs the GCP
storage and video work first (Part D).

## B. The script

**Windows, opened and signed in before the audience arrives** (one browser can hold only one account per college, so use three):

| Window               | Account                     |
| -------------------- | --------------------------- |
| A: Chrome            | `principal` (admin)         |
| B: Edge              | `arjun.nair` (instructor)   |
| C: Chrome, incognito | `ananya.krishnan` (learner) |

Have ready: a **short** video file (under 2 minutes) on the desktop, and `.demo/demo-nilgiri-new-students.csv`.

Open with (30 s): "This is a learning management system built for colleges. One college sees only its own data. I will follow one
course from the administrator's desk to the learner's phone-sized screen and back." Everywhere: **never** open the terminal, `.demo/`,
developer tools (except the one step below) or the database.

### 1. The administrator sets up the college and imports members (3 min, window A)

| Click                                                            | Say                                                                                    | Avoid                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **College settings**: show the name and colour                   | "Each college has its own address, name and colour."                                   | Uploading a logo: not built                                    |
| **Academic setup**: departments, batches, sections               | "Your structure: department, programme, batch, section."                               | Editing anything here                                          |
| **Import** → choose the new-students file → **Upload and check** | "Nothing is written yet. It checks every row first and tells you what is wrong."       | A real file with real students                                 |
| **Import 5 people**                                              | "It runs in the background; each person gets an invitation to set their own password." | Waiting on the screen: move on, mention it finishes in seconds |

### 2. The instructor builds a course and uploads a lecture (3 min, window B)

| Click                                                                                                                           | Say                                                                         | Avoid                                                   |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| Data Structures → **Edit content**                                                                                              | "Modules and items: video, reading, file, link, quiz, assignment."          | **Unpublish course**, **Delete**                        |
| **Add video** under Unit 3: title, pick the short file, tick **Visible to learners**; when processing ends, press **Add video** | "Uploads resume if the connection drops. It makes versions for slow links." | A long file: the button stays off until processing ends |
| While it processes (about 20 s for a one-minute clip), keep talking; then show the ↑ ↓ buttons and **Copy content from…**       | "Next semester you copy the course and move the dates."                     | Running the copy                                        |

### 3. The learner watches, and progress is tracked (2 min, window C)

| Click                                                                | Say                                                                                                      | Avoid                                               |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Home: progress bars and "Coming up"                                  | "The learner sees what is due and where to continue."                                                    |                                                     |
| Data Structures → **Lecture 2: Stacks and queues** → play to the end | "Only seconds actually played count; skipping ahead adds nothing. The name on the video deters sharing." | Saying it cannot be recorded: a screen recorder can |
| Back to the course: Lecture 2 shows **Completed**                    | "The instructor sees the same, per learner, and can export it."                                          |                                                     |

### 4. A timed quiz with autosave and a dropped connection (3 min, window C)

| Click                                                                                   | Say                                                                      | Avoid                                                                 |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| **Timed quiz: stacks and queues** → **Start**; answer question 1                        | "Ten minutes, counted by the server. Answers save as you go."            |                                                                       |
| Press F12 → **Network** → throttling **Offline**; press **Next** and answer question 2  | "The college Wi-Fi just dropped." Point at "Offline — answers will sync" | Turning the laptop's Wi-Fi off: the demo is local and nothing changes |
| Set throttling back to **No throttling**; wait for **Saved**; close the developer tools | "Nothing lost, nothing to redo."                                         | **Reloading the page while offline**                                  |
| **Submit** → **Submit now**; show the result                                            | "Marked at once; the instructor decides what learners see."              | Calling it proctoring: it is not                                      |

### 5. Hand-in, and grading with a rubric (3 min, windows C then B)

| Window and click                                                                             | Say                                                                             | Avoid                                         |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------- |
| C: **Assignment 2: a queue from two stacks** → type two lines in **Your text** → **Hand in** | "Every hand-in is kept as a version. The server's clock decides lateness."      | Uploading an unknown file (no virus scanning) |
| B: the course → **Edit content** → **Grading** under Assignment 2 → open **Ananya Krishnan** | "A rubric keeps marking consistent between graders. Blind grading is possible." |                                               |
| Choose a level for both criteria → **Save grade** → **Release all graded** (confirm)         | "Learners see nothing until you release it."                                    | **Download all submissions** (opens a ZIP)    |
| C: reload; the assignment shows the grade; open the bell                                     | "They are told at once."                                                        |                                               |

### 6. The gradebook: approve and lock (2 min, window A)

| Click                                                                   | Say                                                                                                     | Avoid                                                           |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **Gradebook approvals** → **CS201 · Data Structures**: read the summary | "The instructor submitted it. You see averages, the grade spread and anyone left out, before deciding." | Dwelling on the failing count: the data is invented             |
| **Approve and lock** → **Approve and lock**                             | "A permanent snapshot. Later changes never alter it."                                                   |                                                                 |
| Show **CSV** and **Excel** beside the approved version                  | "This is what goes to the examination office."                                                          | **Unlock**: it asks for a second-step code and a written reason |

### 7. Analytics and learners at risk (2 min, windows B then A)

| Window and click                                                                  | Say                                                                                                     | Avoid                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| B: **Home** → **Teaching dashboard** → **Flagged learners** under Data Structures | "Four plain rules: behind, missed deadlines, low released marks, no activity. Each shows its evidence." | "AI" or "prediction": there is no score and no ranking |
| A: **College dashboard**                                                          | "Activity and course health across the college. Every table says how fresh it is and exports."          | Reading the invented numbers as typical results        |

### 8. Notifications (1 min, window C)

Open the bell, then the account menu → **My notification settings**. Say: "Each person chooses e-mail and in-app per kind of message;
account security cannot be switched off. Quiet hours hold e-mail at night." Avoid: showing e-mails (the demo sends none) and promising
SMS, WhatsApp or push notifications: not built.

### 9. "Download my data" and an erasure request (2 min, windows C then A)

| Window and click                                                                                  | Say                                                                                              | Avoid                                                    |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| C: account menu → **My data** → password → **Prepare my data**; after a few seconds **Download**  | "Their own data, in files a spreadsheet opens. Never other people's, never unreleased marks."    | Opening the files on the projector                       |
| C: same page, **Erase me from this college**: password, tick "I understand", **Ask to be erased** | "It lists what is removed and what a college must keep."                                         | **Ask to erase my whole account**                        |
| A: account menu → **Erasure requests** → **Approve** → **Approve**                                | "A second person decides. Seven days to change your mind. Approved grade records keep the name." | Saying it is legally complete: counsel has not confirmed |
| A: **Cancel** on the same request                                                                 | "Cancelled in time: nothing was changed."                                                        |                                                          |

### 10. Two-step sign-in (1 min, window A)

Sign out, sign in as `principal` with the password, then type the code from the phone. Say: "Administrators cannot get in with a stolen
password alone. Sensitive actions ask again." Avoid: showing the secret or a recovery code on screen.

Close (30 s): "That is one course, end to end. Which of these matters most for your first semester?"

## C. Pre-demo checklist

### The day before

- [ ] `git pull`, `pnpm install`, `pnpm db:migrate`.
- [ ] `pnpm demo:reset`; add the new key to the authenticator app; copy the recovery codes somewhere private.
- [ ] `pnpm demo:video ...` for each real lecture (Part A3), and play each one once.
- [ ] A full rehearsal of Part B. Then `pnpm demo:reset` and the lectures again: a rehearsal uses up the import, the hand-in and the
  approval.
- [ ] Turn off Windows Update restarts and sleep; charger in the bag.

### One hour before

- [ ] PostgreSQL running. Start the app with `pnpm dev` and **wait for both** `Server listening` (API) and `worker started` (worker).
  If only the web server speaks, stop it and run `pnpm --filter @lms/backend run dev` and `pnpm dev:worker` in two terminals of
  their own, beside `pnpm --filter @lms/frontend run dev`.
- [ ] `http://demo-nilgiri.localhost:5173` shows the college name.
- [ ] Sign in all three windows. The phone shows a code for the entry and its clock is set automatically.
- [ ] Play 10 seconds of one lecture in window C.
- [ ] The CSV and the short video file are where you expect.
- [ ] Notifications of other programs off; terminal minimised; browser zoom 110 to 125 %.
- [ ] No internet is needed. Do not depend on the venue's network.

### If something fails during the demo

| What you see                         | Do                                                                                                     | Say                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Pages show an error or never load    | Check the API terminal off screen; restart `pnpm dev`; reload                                          | "Let me restart my laptop's copy." |
| An upload or import stays "waiting"  | The worker is not running: `pnpm dev:worker`                                                           | Move to the next step; come back   |
| The code is refused                  | Wait for the next code; check the phone's clock; use a recovery code                                   |                                    |
| "Too many attempts"                  | Wait one minute                                                                                        | "It slows down password guessing." |
| The video will not play              | Reload; use the other lecture                                                                          |                                    |
| Signed out unexpectedly              | Sign in again; check each window really is a separate browser                                          |                                    |
| A step was already done in rehearsal | Show the result instead; `demo:reset` takes 40 s but **changes the two-step key**: not during the demo |                                    |
| Anything else                        | Skip it. Offer to show it in a follow-up. Do not debug in front of the client                          |                                    |

## D. Do not show or promise yet

- **Hosting on Google Cloud**: not deployed. No uptime, region or backup promise from a running system.
- **Video at college scale**: the demo's video processing is a development tool. The production video provider and CDN are not built, and
  their price is not known.
- **Capacity**: no full-scale load test. Do not quote a number of simultaneous learners.
- **Malware scanning** of uploaded files: **not built**. Assignment uploads are the highest-risk path.
- **Legal and privacy sign-off** (`docs/legal-questions.md`): open are who is the data fiduciary and the processing agreement, the privacy
  notice and consent, **learners under 18 and parental consent** (a college with under-18 learners should not go live yet), and the
  other undecided points. Retention choices are ours and await counsel. Do not say "DPDP compliant".
- **E-mail delivery** with the college's own address: needs a provider, DNS records and a test.
- Not built at all: logos, SMS / WhatsApp / push, proctoring, plagiarism checks, group assignments, GPA or transcripts across courses,
  a mobile app, certificates, fee payment, importing from another LMS.
