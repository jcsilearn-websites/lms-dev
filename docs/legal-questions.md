# Legal questions for the client's counsel

Written for the lawyer who advises the college(s) and JCS iLearn. It lists the legal decisions we made while building the privacy
features, and the ones we have not made. No engineer is qualified to settle these. Where we chose something, we chose the safer or
more reversible option, and we say what changing it would involve.

Each item carries one of two labels:

- **Decided by us, needs legal confirmation.** The product already behaves this way. Counsel should confirm it, or tell us what to change.
- **Open.** We have not decided, and the product does not yet handle it fully. Counsel's answer is needed before real students use the system.

The product was designed with India's Digital Personal Data Protection Act, 2023 in mind. Nothing here is legal advice, and counsel should
check every point against the Act, its Rules as notified, and any college-specific obligations (university regulations, record-keeping
rules, funding conditions).

For the technical detail behind each item, see `data-retention.md`, written for engineers and reviewers.

---

## 1. Who is responsible for the data (data fiduciary and processor) — **Open**

A student's data is entered and used by a college, on a platform run by JCS iLearn. The Act distinguishes the party that decides why and how
personal data is used (the "data fiduciary") from a party that handles it on that party's behalf (a "data processor").

Our working assumption is that **each college is the data fiduciary** for its own students and staff, and **JCS iLearn is its processor**.
That assumption has consequences we have not worked through:

- Who answers a student's request to access or erase their data: the college, JCS iLearn, or both? The product currently sends erasure
  requests to the college's administrator for approval, which fits the assumption above.
- JCS iLearn also keeps some data of its own across colleges: the sign-in account of a person who belongs to several colleges, the list of
  addresses that bounced, security logs, and usage figures used for billing. In those cases JCS iLearn may itself be a data fiduciary.
- A written processing agreement between each college and JCS iLearn is needed. It should say what JCS iLearn may do with the data, how
  quickly it must report a breach, which sub-processors it uses (hosting, e-mail delivery, video), and what happens to the data when the
  contract ends.

**Question for counsel:** which party is the fiduciary for which data, and what must the agreement between the college and JCS iLearn say?

## 2. Consent and the privacy notice — **Open**

The product has no privacy notice, no consent text, and no "I agree" step. Under the Act, personal data is generally processed on the basis
of consent, or for certain "legitimate uses" the Act lists. A college may be able to rely on a legitimate use for data it needs to run a
course and keep academic records, but that is for counsel to say.

What we have built so far is the machinery that makes consent and notice workable: a person can download their data, can ask for erasure,
and can switch off optional e-mails.

What counsel needs to settle, so we can add the text and any screens:

- The notice itself: what is collected, why, for how long, who it is shared with, and how to complain.
- Whether a student must actively agree at first sign-in, or whether the college's admission terms already cover it.
- Which processing needs separate consent. Examples: the video watermark that shows a viewer's name and address; the log of tab switches
  during an online exam; the daily "activity" record used for engagement reports and the "at risk" flags shown to teachers.
- Whether the notice must be available in languages other than English.
- Who the person contacts, and the name and contact details of the officer who handles complaints.

## 3. Learners under 18, and parental consent — **Open**

The Act treats anyone under 18 as a child. It requires verifiable consent from a parent or guardian before a child's data is processed, and it
restricts tracking and targeted advertising aimed at children.

The product does not ask for a date of birth and cannot tell whether a learner is a minor. It has **no parental consent step**. Some colleges
enrol students under 18 (for example junior-college or bridge programmes), so this matters.

Questions for counsel:

- Is the college's admission process enough as parental consent, or does the platform have to collect and record it?
- If the platform must record it, what counts as "verifiable"?
- Do the progress tracking, the "at risk" flags and the activity record count as tracking or behavioural monitoring of a child, and if so
  what is permitted?
- Should the system refuse to enrol a learner under 18 until consent is recorded?

Until this is answered, we recommend that a college with learners under 18 does not go live.

## 4. Gradebooks keep names and register numbers as the academic record — **Decided by us, needs legal confirmation**

When an instructor and approver finalise a gradebook, the system freezes a copy of it. Each line of that copy holds the learner's name and
register number as they were at that moment. These frozen copies can never be changed, by anyone, on purpose: they are the college's
official record of the grades.

When a student is erased, the system replaces their name with a made-up label everywhere it is displayed. **It does not rewrite frozen
gradebooks.** A gradebook approved before the erasure still shows the real name and register number. A gradebook approved afterwards shows
the label.

The erasure screen and `data-retention.md` tell the member this plainly.

**Questions for counsel:**

- May a name and register number stay in an approved gradebook, as a record the college is required or entitled to keep?
- For how long? We have set no limit; the record stays as long as the college keeps its academic records.
- Should the college be able to replace the names after a period? That would be a deliberate, audited action and a new feature.

## 5. What the member's data download leaves out — **Decided by us, needs legal confirmation**

A member can ask for a copy of their own data. The download holds their profile, enrolments, progress, their own submissions, grades that
have been released to them, and their notification settings.

We deliberately **leave out**:

- the **integrity log** of an online exam (records of switching tabs, losing focus or going offline), because it is a teacher's working
  evidence about possible misconduct and is informational only;
- the **audit log** (the record of who did what in the college), because it concerns other people's actions as much as the member's, and
  because showing it could reveal how security and monitoring work;
- other people's data, grades not yet released, graders' private notes, and the private reasons recorded for accommodations, extensions and
  grade adjustments;
- e-mails already sent.

The download carries a note saying what is not in it.

**Question for counsel:** does the right of access under the Act require us to include any of this, in particular the integrity log, since it
is data about the member? If so, we would add it, possibly with the reason it was recorded.

## 6. Backups and how long erased people stay in them — **Decided by us, needs legal confirmation**

Backups are copies of the whole database. They cannot be edited, so a person erased today is still present in every backup taken before today,
until that backup expires.

The planned retention, which needs the client's agreement:

- continuous recovery history in the hosted database service: **7 days**;
- full backup files kept for restoring after a disaster: **30 days**.

So an erased person can remain in a backup for **up to 30 days** after erasure.

To prevent an erased person from coming back, the system keeps a separate **erasure ledger**. It holds only identifiers: the request, the
person, the college, the time. It holds no names and no addresses. After any restore from backup, the ledger is replayed so everyone erased
since that backup is erased again before the system is opened to users. The ledger is stored apart from the backups and is kept indefinitely.

**Questions for counsel:**

- Is it acceptable that erased data survives in backups for up to 30 days, given that it is not used and is erased again on any restore?
- Is 30 days an acceptable maximum, or should it be shorter?
- Is keeping the ledger indefinitely acceptable, given that it holds only identifiers? Counsel may want the identifiers to count as personal
  data.

## 7. The plain e-mail address kept for suppression — **Decided by us, needs legal confirmation**

When an address bounces, or its owner complains, the system stops mailing it and remembers that. An erased person's address must not be mailed
again, so the system cannot simply forget it.

We store a keyed one-way fingerprint of the address, which cannot be turned back into the address without the key. At the **college level**,
we **also keep the plain address** next to it for as long as the person's account exists. The reason is practical: the account may still
belong to other colleges, which could invite the same address again, and the protection against mailing a bouncing address would stop working
without it. When the **whole account** is erased, the plain address is replaced and only the fingerprint stays.

This is a deliberate deviation from "keep only the fingerprint", and **the owner has not yet confirmed it**.

**Questions for counsel:**

- Is it acceptable to keep the plain address, for this single purpose, until the account itself is erased?
- Is the fingerprint, which stays after account erasure, still personal data? If it is, is keeping it justified?

## 8. Time limits of the erasure process — **Decided by us, needs legal confirmation**

How an erasure request works:

1. The member asks, and enters their password again.
2. Another administrator of the college approves or rejects. **If nobody decides within 30 days, the request lapses.** The member is told in
   the app and by e-mail, and can ask again.
3. After approval there are **7 days of grace**, during which the member or an administrator can cancel.
4. After that the erasure is carried out and cannot be undone.

Questions for counsel:

- The Act requires erasure on request unless retention is needed for a legal purpose. Is a **30-day wait for an administrator** acceptable,
  or is there a shorter limit? Is the lapse after 30 days acceptable, or must an undecided request be treated as approved?
- Is the **7-day grace** acceptable? Its purpose is to stop a mistaken or coerced request from becoming permanent. Counsel may prefer a
  different period, or a way for the person to waive it.
- May the college refuse an erasure (for example while a disciplinary or grade dispute is open)? Today an administrator can reject, and the
  person is told, but no reason is required or recorded.

## 9. Two people for an account erasure (four-eyes approval) — **Decided by us, needs legal confirmation**

A person who has left every college can have their whole account erased. That is either combined with their last college's request, or filed
by a JCS iLearn platform administrator, who needs a **different platform administrator** to approve it. The same 7-day grace and 30-day
lapse apply. Nobody can approve their own request.

We chose two people so that one person at JCS iLearn cannot erase an account alone, by mistake or for bad reasons. The cost is that **JCS
iLearn needs at least two platform administrators in service at all times**, or the request cannot be approved.

**Questions for counsel:**

- Does JCS iLearn need to verify the identity of someone who asks us to erase their account when they no longer belong to any college (they
  cannot prove it by signing in to one)? What evidence is enough?
- Is it acceptable that an account can only be erased when the person has no college membership left, and that a platform administrator's own
  account cannot be erased this way?

## 10. Other points we noticed but have not decided — **Open**

- **Breach notification.** The Act requires telling the regulator and the affected people about a breach. We have logs and alerts, but no
  written procedure, no template notice, and no named person who decides. A procedure is needed before go-live.
- **Where the data is kept.** The plan is a hosting region in Mumbai, with the video, e-mail and file services chosen later. Counsel should
  say whether the Act, or any college's rules, restrict where data may be stored or processed, and whether the e-mail provider needs to be in
  India.
- **Records of teachers and staff.** Their data is handled by the same features as students' data. Counsel should confirm that the same
  notice, consent and retention approach suits employees.
- **Retention periods that no one has set.** Audit records, academic records and the college's own account records currently stay until the
  college decides. Counsel and the college should state a maximum for each.
- **Uploaded files are not scanned for malware yet.** This is a security matter, not a privacy one, but a breach caused by a malicious
  upload would be a reportable incident. It must be closed before a college hands in real work.

---

## Summary

| #   | Question                                                                | Status                                  |
| --- | ----------------------------------------------------------------------- | --------------------------------------- |
| 1   | Who is the data fiduciary, college or JCS iLearn, and the agreement     | Open                                    |
| 2   | Consent and the privacy notice                                          | Open                                    |
| 3   | Learners under 18 and parental consent                                  | Open                                    |
| 4   | Frozen gradebooks keep name and register number                         | Decided by us, needs legal confirmation |
| 5   | Data download leaves out the integrity log and the audit log            | Decided by us, needs legal confirmation |
| 6   | Erased people stay in backups until they expire (7 and 30 days)         | Decided by us, needs legal confirmation |
| 7   | Plain suppressed address kept until the account is erased               | Decided by us, needs legal confirmation |
| 8   | 7 days of grace, 30 days before an undecided request lapses             | Decided by us, needs legal confirmation |
| 9   | Two people for account erasure                                          | Decided by us, needs legal confirmation |
| 10  | Breach procedure, data location, staff data, retention periods, malware | Open                                    |
