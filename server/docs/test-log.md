# YCP Test Log

Append to this as you build. Every row is evidence for the evaluation
chapter and ammunition for the viva. Date everything.

---

## 2026-09-19 Incident defences verified against a live instance

Environment: Node 22, PostgreSQL 16, seeded dataset (6 users,
4 activities, 1 assessment, 1 graded submission).

### Incident 2, URL tampering / IDOR

Brief section 5: *"Another user changes a project identifier in the
browser and gains access to information belonging to another team."*

Reproduced against `GET /api/assessments/submissions/:id/feedback`
using a submission belonging to Amina Uwase.

| Actor | Request | Result | Correct? |
|---|---|---|---|
| Amina (owner) | her own submission id | 200 with feedback | yes |
| Kwame (other participant) | Amina's submission id pasted in | **404 NOT_FOUND** | yes |
| Kwame | malformed id `not-a-uuid` | 404 NOT_FOUND | yes |
| Nobody (no token) | Amina's submission id | 401 UNAUTHENTICATED | yes |

The 404 rather than 403 is deliberate (ADR-005). Kwame cannot tell from
the response whether the record exists, so the endpoint gives him no
existence oracle to enumerate with.

**Detection also verified.** After the two denied attempts,
`GET /api/admin/security/suspects` as an admin returned:

```
actor_id: 679db107-...  resource_type: submission
distinct_targets: 2     denied_attempts: 2
```

So the attack is both blocked and observable. This is the strongest
version of the answer: a control that fails silently cannot be audited.

### Incident 1, stale feedback

Brief section 5: *"One member cannot see the updated feedback."*

| Step | Result |
|---|---|
| Amina reads feedback, client stores ETag | 200, ETag `"zaizDAd0_NnK1TFdwbHC-vYMrww"` |
| Amina refreshes with `If-None-Match` | **304**, no body, nothing changed |
| Facilitator revises the feedback body | version trigger fires, v1 becomes v2 |
| Amina refreshes with the **same old ETag** | **200**, cache correctly busted |
| Response now contains | v2, `isUnread: true` |

The old ETag no longer matches because the payload changed, so the stale
copy is invalidated deterministically rather than by waiting for a
time-to-live to lapse. The unread flag is per version, so a member who
read v1 is still shown v2 as new.

### Incident 3, excessive data on refresh

Brief section 5: *"repeatedly refreshing the project page consumes
excessive data."*

`GET /api/activities?limit=20`, 4 activities seeded:

| Condition | Body size | Saving |
|---|---|---|
| First load, uncompressed | 1682 bytes | baseline |
| First load, gzip | 779 bytes | 53.7% |
| Refresh, unchanged, 304 | 0 bytes | 100% of body |
| Narrowed with `?fields=id,title,payload_kb` | 480 bytes | 71.5% |

Honest caveat for the report: the 304 carries no body but still costs
roughly 200 bytes of response headers on the wire. State the claim as
"refresh drops from ~1.7 KB to header-only", not "to zero".

Re-run `docs/measure-bandwidth.sh` once the catalogue is fuller. The
saving scales with payload size, so the current figures understate the
effect at realistic data volumes.

---

## 2026-09-19 Frontend built and contract-verified

### Client / server contract

56 automated checks confirming every field the React client destructures
is actually present in the API response: activity list rows, activity
detail with modules and permissions, progress summary and enrolments,
discussion threads, profile, and versioned feedback. All 56 pass.

Worth stating in the viva: this is the check that catches the class of
bug where the frontend renders `undefined` because someone renamed a
column. It should be re-run after any schema change.

### Bundle budget, from a real `vite build`

| Asset | gzipped |
|---|---|
| index.html | 1.12 KB |
| stylesheet | 2.18 KB |
| app entry | 5.67 KB |
| react + react-dom | 44.38 KB |
| router | 4.82 KB |
| **first load** | **58.17 KB** |
| deferred route code | 13.19 KB |

Budget was 150 KB, so there is headroom. React is 76% of the remaining
first load, which is the measured cost of choosing an SPA (ADR-007).

One defect found and fixed during this build: the initial `manualChunks`
object form left the vendor chunk at 0.03 KB because Rollup hoisted
React into the router chunk. Switching to the function form split them
correctly. Without the measurement this would have shipped, and every
deploy would have forced a 45 KB re-download of React.


### Defect found while verifying the packaged copy

`GET /api/activities?limit=2&fields=title` returned
`nextCursor: "e30"`, which decodes to `{}`. The handler paginated the
rows *after* `selectFields` had narrowed them, so the keyset cursor was
built from a row that no longer had `opens_at` or `id`.

Effect: pagination silently stopped working for any client using field
selection, which is exactly the low-bandwidth client the feature exists
to serve. Page 2 would have returned page 1 again.

Fix: paginate the raw rows, then narrow. Verified page 2 now returns the
correct next results both with and without `?fields=`.

Worth naming in the viva as an example of why the evaluation step is
not ceremonial: the endpoint returned HTTP 200 with a well-formed body
throughout. Only decoding the cursor revealed it.


---

## 2026-09-25 Automated test suite added, two critical defects found

35 tests, zero dependencies (Node's built-in runner and fetch), running
against a real PostgreSQL database. Mocking was rejected deliberately:
most of what these tests verify (row locks, unique constraints, the
authorisation resolvers' joins, trigger-driven versioning) lives in the
database, so a mock would pass while the system was broken.

`npm run test:security` runs the brief's section 5 attack on every
execution.

### CRITICAL: assessment submission was completely broken

`POST /api/assessments/:id/submissions` returned HTTP 500 for every
request. Cause: parameter `$6` was used both as a value for the
`status` column (type `submission_status`) and inside a comparison
against the literal `'graded'` (type `text`). Postgres refused with
"inconsistent types deduced for parameter $6".

**Complete Assessment is a named stage of the participant journey in the
brief. It had never worked.** The 56 contract checks from the previous
session missed it because they only exercised GET requests.

Fixed by casting explicitly to `$6::submission_status`. Verified end to
end: a submission now returns 201, is marked graded, and scores 66.67.

### The test that nearly hid it

The first version of the attempt-limit test asserted only
`accepted <= 2`. Every submission was failing with a 500, so zero
attempts were accepted, and zero is less than two. **The test passed
while the endpoint was entirely broken.**

Adding the lower bound (`accepted >= 1`) exposed it. This belongs in the
viva: an assertion that can only fail in one direction is a test that
agrees with you rather than checking you.

### Dead field-level access control

`GET /api/profiles/:id` ran `delete profile.phone` for non-owners, which
looked like a working field-level control. The SELECT never included
`phone`, so the delete was a no-op and the owner could not see their own
number either. The control was decorative. Fixed by selecting the
column, which makes the redaction real.

### Migration runner replaced

The old runner applied schema.sql wholesale and offered a `--reset` that
dropped the public schema. Replaced with numbered, forward-only,
transactional migrations tracked in `schema_migrations`, with checksum
tamper detection and a Postgres advisory lock so two deploying instances
cannot race. Verified idempotent: a second run reports "already up to
date".

This matters directly for the maintainability criterion. Level Two now
adds `002_level_two.sql` rather than requiring a database rebuild.

### Coverage

| Area | Tests |
|---|---|
| IDOR and access control | 10 |
| Audit and detection | 2 |
| Mass assignment, privilege escalation | 4 |
| Injection and input handling | 4 |
| Security headers | 1 |
| Conditional requests and bandwidth | 6 |
| Feedback versioning | 3 |
| Concurrency races | 3 |
| Query efficiency | 2 |


---

## 2026-09-25 Profile management added, 52 tests

Migration 002 applied incrementally. 001 was not touched, and the runner
reported "1 migration applied" against a database that already had 001.
This is the maintainability claim working in practice rather than in a
paragraph.

### Avatar upload, tested as an attack surface

File upload is where profile pages usually break. Both attacks are
rejected and locked in by tests:

| Attack | Result |
|---|---|
| SVG containing `<script>` uploaded as an avatar | 400, magic-byte check refuses it |
| HTML sent with `data:image/png;base64,` prefix | 400, the claimed type is ignored |
| Another participant overwriting your picture | 403/404, and the original survives |
| Another participant deleting your picture | 403/404 |

The SVG case matters most. An SVG can carry script, and an avatar served
from our own origin executes in our security context, so accepting one
is stored cross-site scripting delivered through a profile picture. The
database CHECK constraint permits only webp, jpeg and png, and the route
verifies the actual bytes rather than the declared MIME type.

Images are downscaled in the browser to 256px WebP, roughly 6 KB, before
upload. A phone photo is 3 to 8 MB, so uploading one raw would have cost
a participant more data than everything else in the system combined.
The server still validates independently: client-side processing is a
courtesy to someone's data bundle, never a control.

### Password change

| Property | Why it is tested |
|---|---|
| Current password required | Being signed in is not proof of ownership. Thirty seconds with an unlocked laptop would otherwise take the account permanently. |
| All other sessions revoked | Someone changing a password believes it is compromised. If the attacker's session survives, the change achieved nothing. Verified: two live sessions, one survives. |
| This device re-issued | Revoking everything would sign the person out of the device they are holding. |
| New password must differ | Accepting a no-op leaves someone believing they rotated a credential they did not. |
| Change recorded | "When was it last changed, and from where" is the first question in any account dispute. |

### Disciplines moved to a controlled vocabulary

Free text produced "Software Development", "software dev" and "coding"
as three unrelated values. Level Two has to assemble multidisciplinary
teams, which is a query across comparable values, and that is impossible
over free strings. 26 disciplines in 6 categories, validated server-side
against the table so adding one is a data change rather than a deploy.

Tested: a known slug is accepted, an invented one is refused by name.

### Coverage now 52

| Area | Tests |
|---|---|
| IDOR and access control | 10 |
| Audit and detection | 2 |
| Mass assignment, privilege escalation | 4 |
| Injection and input handling | 4 |
| Security headers | 1 |
| Conditional requests and bandwidth | 6 |
| Feedback versioning | 3 |
| Concurrency races | 3 |
| Query efficiency | 2 |
| Discipline vocabulary | 4 |
| Password change | 5 |
| Avatar upload | 8 |


---

## 2026-09-25 Two defects found by running against a hosted database

Both passed against local PostgreSQL and failed against Neon. Neither
was a Neon problem. Latency made them visible.

### DEFECT: a GET that mutated state, breaking its own cache

`GET /api/assessments/submissions/:id/feedback` recorded a read receipt
as a side effect. That made the response non-idempotent: the first
request returned `isUnread: true`, the receipt landed, and the identical
second request returned `isUnread: false`. A different body is a
different ETag, so `If-None-Match` never matched and the conditional
request layer on this endpoint was silently dead.

**It passed locally purely because the loopback connection was too
fast.** The fire-and-forget write had not landed before the next request
arrived, so the two bodies happened to match. At roughly 250ms round
trip it lands in time and the bug appears.

The underlying mistake predates the symptom: HTTP defines GET as safe,
meaning it must not change server state. Marking something read is a
state change. It now has its own endpoint, `POST .../feedback/read`,
which the client sends after the feedback is actually displayed. That is
also more honest, since a response being fetched is not evidence a human
read it.

Two regression tests pin it: an unchanged GET must still return 304
after a 600ms pause, and the read endpoint must be idempotent.

Worth stating plainly in the viva: this is a caching feature that was
measured as working, demonstrated as working, and was not working on any
endpoint where the handler also wrote. Local testing cannot find this
class of bug.

### DEFECT: the test suite throttled itself

`tests/access-control.test.js` reported zero tests in 753ms. The cause
was the login rate limiter: 10 attempts per IP per 15 minutes, against a
suite that signs in thirteen times across three files plus more inside
individual tests. The first file to run absorbed the 429s and its setup
hook failed, which reads as a broken application when nothing is wrong.

The limit is now configurable and raised under `NODE_ENV=test`. That is
a real trade-off rather than a free fix: relaxing a control in the test
environment means the suite no longer exercises it. Two tests compensate.
One pins the production value at 10 by reading the source, so raising
the real limit fails the build. The other verifies the per-account
lockout, which is a separate control that follows the account rather
than the IP and therefore cannot be evaded by rotating addresses.

### Coverage now 56

Added: 2 feedback caching regressions, 2 rate limiting.


---

## 2026-09-25 Facilitator and admin surfaces added, 75 tests

### The gap

The brief states that "facilitators and administrators should be able to
manage relevant programme information and participant activities". Until
now there was no interface for either. Signing in as `admin@ycp.africa`
landed on the participant Discover page with no route to anything an
administrator exists to do. The server enforced the roles correctly; the
client simply did not acknowledge they existed.

### What was built

Facilitator: activity list with a grading backlog, section authoring,
assessment authoring with answer keys, a participant progress view, and
a grading queue that sorts ungraded work first.

Admin: platform overview, searchable user management with role and
status changes, and the security console that surfaces the section 5
incident.

### Guards worth naming in the viva

| Guard | Why it exists |
|---|---|
| An admin cannot change their own role or status | A misclick would lock you out of the system you administer, with no way back in |
| The last active admin cannot be demoted or suspended | Leaves the platform with nobody able to appoint another admin. Checked inside a transaction with the row locked, because two admins demoting each other simultaneously would both pass a naive count |
| A role change revokes all sessions | The old access token carries the old role until it expires |
| Suspension revokes sessions | A suspension that leaves sessions working is not a suspension |
| Module positions assigned server side | Two facilitators adding a section at once would otherwise claim the same position |
| New sections backfill progress rows | Otherwise everyone already enrolled sees a section that can never count towards completion |
| Quiz answer keys validated against options | A question whose correct answer is not one of its options is unpassable, and nobody finds out until a participant has used every attempt |

### Double gating

Every management route is gated twice. `requireRole` answers "is this
the kind of account that may author content at all". `can()` answers
"does this caller own THIS activity". A facilitator who only passed the
role gate could edit a colleague's activity by changing the id in the
URL, which is the brief's section 5 incident wearing a different hat.
Tested: a participant posting a section gets 403 and no row is created.

### Coverage now 75

Added 19: facilitator workspace 8, admin console 11.


---

## 2026-09-25 Course structure (migration 003), 93 tests

Content was flat: an activity held modules, a module held one blob of
text. That cannot express a course where a week contains a reading, then
a video, then a quiz, each with files.

Now: Activity -> Module -> Item -> Material, the shape Coursera and
similar platforms use.

### The structure is borrowed. The media priority is inverted.

Coursera is video-first. Video is the wrong default for this brief. Ten
minutes of 480p video is roughly 50 MB, more than many participants'
weekly mobile bundle. So:

- reading is the default item kind, not video
- video and audio are EXTERNAL links only, never uploaded, so the
  platform never serves 50 MB itself
- video items carry a transcript field, offered to the participant
  beside the video as "read transcript instead". Roughly 8 KB against
  50 MB, and the accessible option and the cheap option turn out to be
  the same option
- the authoring form lists reading first and warns when a video has no
  transcript

### payload_kb is now measured, not typed

It used to be a number a facilitator entered. A typed number drifts from
reality the moment content changes, and the platform's entire
low-bandwidth promise rests on it being true. A trigger now recomputes
it from actual stored bytes plus text length.

### DEFECT: the same enum-cast bug, three times

`PUT /items/:id/progress` returned 500: "inconsistent types deduced for
parameter $3". Identical in shape to the defect that broke assessment
submission earlier. Then a second variant appeared in the same handler
("column status is of type progress_status but expression is of type
text") from an uncast CASE result, and a grep found a third latent
instance in the module progress endpoint.

The pattern, stated once so it stops recurring: **any parameter or CASE
expression that is both an enum column value and compared against a
string literal needs an explicit cast.** Three occurrences is not three
accidents, it is one habit.

### Backward compatibility held

module_progress was kept and is now derived from item_progress rather
than replaced. Every existing endpoint, query and test still works, and
a module with no items behaves exactly as before. The client renders the
old shape when a module has no items.

That is the maintainability criterion demonstrated rather than asserted:
a substantial content-model change that broke nothing.

### Coverage now 93

Added 18: lesson items 6, materials 8, derived weight 1, progress
rollup 3.


---

## 2026-09-25 Course player and certificates (migration 004), 117 tests

### Certificates that are actually worth something

Three properties, each tested:

**Cannot be obtained without earning it.** Completing sections is not
enough when the activity requires a pass; every attached assessment must
also be passed. The refusal says which part is missing, because "not
eligible" tells someone who thinks they finished nothing useful.

**Cannot be altered after issue.** ADR-017: the recipient name, course
title, score and hours are SNAPSHOT into the recognition row. The
obvious implementation joins to users and activities at render time,
which produces a certificate whose text changes retroactively when a
course is renamed. A credential that can be edited after the fact is not
evidence. Two tests rename the course and the participant and assert the
issued certificate is unchanged.

**Can be checked by someone with no account.** `GET /api/verify/:code`
is public and rate limited. An employer in Kampala with a printed
certificate needs ten seconds and no signup. A credential only verifiable
behind a login is not a credential.

Verification discloses the achievement and nothing else. Tested
explicitly: no email, no country, no internal id, no other awards.
Someone holding one code learns about one achievement.

Codes are `YCP-XXXX-XXXX-XXXX` from an alphabet excluding 0, O, 1, I and
L, because these get read off paper and typed.

**Revocation, not deletion.** Deleting a certificate leaves an employer
holding the PDF with a code returning "no such certificate", which is
indistinguishable from a forgery. Revoking tells them the truth: it
existed and was withdrawn, with a reason and a date.

The PDF is generated on demand (about 4 KB) rather than stored: it is a
pure function of the snapshot columns, so storing it would mean keeping
two representations of one fact in sync for no benefit.

### DEFECT: migration ordering

Migration 004 set `awards_certificate = TRUE` on published activities.
On a fresh database this matched nothing, because migrations run BEFORE
seeding. Every certificate test failed with "this activity does not
award a certificate".

Fixed in the seed, and the migration comment now states plainly that
both paths are needed and neither substitutes for the other. Worth
naming as a class: a migration that updates data can only touch rows
that already exist at the moment it runs.

### The course player

Sidebar plus content pane, the layout Coursera established, because a
learner's two questions are always "where am I" and "what is next" and
both are answered without navigating away. On a phone the sidebar is a
drawer: fixed at 360px it would leave about 140px for content.

It opens at the first incomplete item rather than the beginning, and
video items show the estimated data cost before the tap, with the
transcript offered as the alternative.

### Coverage now 117

Added 24: eligibility 5, snapshot integrity 2, download 5, public
verification 5, revocation 5, participant view 2.


---

## 2026-09-26 The suite poisoned itself, and the repair repeated a known bug

### DEFECT: cleanup is not a precondition

Every suite failed with `sign in failed for joseph@ycp.africa: 401 "This
account is not active"`, cancelling 59 of 117 tests. Nothing in the
application was broken.

Several tests deliberately suspend an account or demote an admin, and
restore it at the end. That works only when the test FINISHES. An
earlier run had been cancelled partway through by a DNS failure, so the
restore never executed and the account stayed suspended. Every run after
that died in its setup hook.

The underlying mistake is relying on cleanup to establish preconditions.
Cleanup is best-effort by nature: a crash, a Ctrl-C, a network drop or a
failing assertion all skip it. Setup is the only place a precondition
can be guaranteed.

Two fixes, in that order of importance:

1. `restoreDemoAccounts()` runs in `startServer()` before every suite.
   It reactivates the demo accounts, restores their roles, clears
   lockouts, and deletes accounts that individual tests invent. The
   suite now asserts the state it needs rather than hoping the previous
   run tidied up.

2. The two destructive tests wrap their mutations in `try/finally`, so a
   failing assertion still restores. Their restore goes straight to the
   database rather than through the API, because if the failure was an
   authorisation problem then the API route is exactly what is not
   working.

Verified by deliberately poisoning the database the same way an
interrupted run does (two accounts suspended, two admins demoted, one
account locked out, a stray admin left behind) and then running the
suite: 117 of 117 pass, and the accounts come out correct.

### DEFECT: the same enum cast, a FOURTH time

The repair function itself failed with `column "role" is of type
user_role but expression is of type text`. A VALUES list yields text,
and assigning text to an enum column is rejected.

This is the fourth occurrence of this exact mistake in the project. The
first three are already written up above as a named pattern. **Writing
the rule down did not stop me repeating it.** The test suite caught it
within seconds, which is the argument for having one.

The precise rule, since the earlier statement of it was too loose:

- A bare string literal is fine. `SET status = 'returned'` works,
  because Postgres coerces an unknown-typed literal to the column type.
- A PARAMETER needs a cast: `$3::progress_status`.
- A `VALUES` column needs a cast: `v.role::user_role`.
- A `CASE` result needs a cast on the whole expression:
  `(CASE ... END)::progress_status`.

A sweep of the codebase for the remaining cases found only bare
literals, which are safe.

### For the report

This is the most useful failure in the project so far, because it was
entirely self-inflicted and entirely invisible to code review. The tests
passed for days. They only broke once a run was interrupted, and then
they broke permanently and blamed the application.


---

## 2026-09-26 Public course landing page (migration 005), 136 tests

### The decision worth defending

A Coursera course page is PUBLIC. You read the syllabus before you have
an account, and that is how courses get found and shared. A catalogue
that requires a login cannot be posted in a WhatsApp group, which is
the main way a youth programme in this region actually reaches people.

So the landing page is reachable signed out. But public must not mean
the course is readable without enrolling, so the page is a
MINIMUM-DISCLOSURE PROJECTION (ADR-018):

| Disclosed | Withheld |
|---|---|
| module and item titles | reading bodies |
| item kinds and durations | transcripts |
| attachment count and size | attachment contents |
| whether a transcript exists | video and resource URLs |
| total time, derived from content | assessment questions |

The split is enforced by `course_preview_items`, a database VIEW that
does not contain body, transcript or external_url. A future handler
cannot leak a reading by selecting the wrong column, because the column
is not in the view. That is the difference between a rule and a
control: a rule is followed by whoever remembers it, a control cannot
be forgotten. One test asserts the view's column list directly.

Nine tests attack the page rather than exercise it: a canary string is
planted in a reading and the public response is checked for it, the
response shape is checked for content-bearing field names, and a draft
course is confirmed indistinguishable from one that does not exist.

### DEFECT: test residue, three more instances in one session

Yesterday's write-up covered a suspended account left behind by an
interrupted run. Today the same class appeared three more times, all in
code written to test a new feature:

1. The landing-page edit test mutated the seeded course and never
   restored it. Passed on a fresh database, failed on every run after.
2. Adding `try/finally` was NOT enough. By then the damage from the
   earlier broken run was the state the restore captured as "original",
   so it faithfully restored the wrong thing. **A cleanup can only
   return you to where the test started, and where it started was
   already wrong.**
3. The test created a canary lesson item every run and never deleted
   it, so the seeded syllabus filled with duplicates and the derived
   minute count climbed forever.

The rule, now stated once and completely:

- If a test CREATES a row, the same file deletes it.
- If a test CHANGES a row, the same file restores it, capturing the
  original first rather than hardcoding an assumption.
- Anything a test DEPENDS ON, its setup arranges. Never assert against
  fixture data you did not establish, because you cannot guarantee what
  a previous run left behind.

Verified by running the file three times consecutively and the full
suite twice: 136 pass each time, with no rows left behind.

### DEFECT: the migration-ordering trap, a second time

Migration 005 sets landing-page content with an UPDATE. On a fresh
database that matched zero rows, because migrations run BEFORE seeding,
so `weeks` and `hours_per_week` came back null on the very page the
migration was written for.

Identical to migration 004 and `awards_certificate`, already written up
above. The rule: a data migration can only touch rows that already
exist when it runs. It is for databases that are already populated.
Anything the seed creates, the seed must also populate. Both paths are
needed; neither substitutes for the other.

### The seed now produces a readable course

The seed predated the item model (migration 003), so seeded courses had
modules containing nothing. Fine for the API tests, which create their
own items, and useless for anyone opening the platform: the landing
page syllabus rendered as four empty headings.

Seeded courses now carry a reading per module plus one video with a
transcript, which puts ADR-016 into the default data rather than only
into a comment.

### Coverage now 136

Added 19: public catalogue 5, disclosure attacks 8, facilitator
maintenance 4, derived figures 2.


---

## 2026-09-27 DEFECT: passing a quiz did not complete the course

### The symptom, as a participant experiences it

Finish every reading in a course. Take the final quiz. Pass it. Then be
told: **"Finish every required section first."** No certificate, and an
explanation that contradicts what you just did.

Reproduced exactly: five readings completed, quiz submitted, scored
66.67 against a 60 pass mark, `passed: true` in the response. Enrolment
still `in_progress`, one required item outstanding, and that item was
the quiz that had just been passed.

### The cause

`lesson_items` of kind `quiz` carry an `assessment_id`. But
`POST /api/assessments/:id/submissions` never looked at `lesson_items`
at all. Submitting and grading an assessment was one code path;
completing a lesson item was another; nothing joined them.

So the quiz item sat at `not_started` permanently. The module never
completed, the enrolment never completed, and
`issue_certificate_if_earned` correctly returned NULL every time.

**Every component worked. Each had passing tests. The join between them
did not exist.** Unit tests per endpoint structurally cannot find this,
which is why `tests/journey.test.js` now walks the entire path in order
and asserts the thing a participant actually cares about at the end.

### The fix, and the decision inside it

The obvious fix was to copy the progress rollup into the assessment
handler. That would have been the second copy of "what counts as
finished", and two copies drift. The symptom of that drift is a
participant who has finished a course the system thinks they have not,
which is the defect we were fixing.

So ADR-019: **the rollup is one database function,
`recalculate_progress(enrolment_id)`, called by every path that can
change progress.** The forty lines of inline rollup in the item handler
were deleted and replaced with a call to it. Same reasoning as
`issue_certificate_if_earned` in migration 004: a rule about what the
data means belongs with the data, not in whichever handler runs.

Three callers now: the item-progress endpoint, the module-progress
endpoint, and a trigger on `submissions`.

What counts as done differs by assessment type, and the difference
matters to the participant:

| Type | Item completes when | Why |
|---|---|---|
| quiz (auto-marked) | they PASS | failing has not demonstrated the thing the item exists to demonstrate |
| submission, reflection | they SUBMIT | their part is done; progress must not hang on how fast someone else grades |

The certificate is still withheld until a grade arrives, because
`issue_certificate_if_earned` checks pass marks separately. So the
progress bar is honest and the credential is still earned properly.

A second trigger fires on `feedback`, because a facilitator's grade can
be the final requirement: someone submits an assignment, finishes
everything else, and waits. The grade landing is the moment they earn
the certificate, and they should not have to revisit the course to
trigger a recalculation nobody would think to ask for.

### Repair for existing data

Migration 006 ends with a DO block that recalculates every enrolment
holding a passing submission. Anyone already stuck in this state has met
every requirement and holds no certificate; this issues what they
already earned. Safe on a populated database, because
`recalculate_progress` only moves an enrolment towards the truth and
issuance is idempotent.

### Proving the test tests the fix

Dropped `trg_submission_completes_item` and re-ran: 5 of 10 journey
tests fail. Restored it: 10 of 10 pass. A test that does not fail when
you remove the thing it tests is not testing it.

### More cross-file test residue

The new journey file EARNS a certificate, and `certificate.test.js`
assumes Joseph holds none, so it started returning 201 where it
expected 400. The cleanup rule needed widening: it now covers rows
created INDIRECTLY, as a side effect of the behaviour under test, not
only rows a test inserts deliberately. Both sides were fixed: the
journey file deletes what it earns, and the certificate test arranges
its own precondition rather than assuming one.

### Interface gap closed

Finishing a course by taking its final quiz left the participant on the
assessment result screen with no mention of the credential they had
just earned. The result screen now shows it, matched on the activity so
someone with several certificates is not shown an unrelated one.

### Coverage now 146

Added 10: the full journey 7, failure behaviour 1, ADR-019 structure 2.


---

## 2026-09-27 Studied Coursera, adapted rather than copied. 164 tests

Researched Coursera's current course page and learner experience, then
decided feature by feature what transfers to this brief and this
population.

### Taken

| Feature | Why it transfers |
|---|---|
| Skills you will gain | Serves the employability aim directly, and Level Two team matching has to query complementary skills. Kept distinct from tags: tags are topical and used for browsing, skills are what a participant can claim afterwards. |
| Per-module content breakdown | "1 reading, 1 video · 34 min" tells someone whether a week is heavy. "2 items" does not. |
| Per-module learning objectives | Cheap to store, pedagogically real, collapses under the module heading. |
| Course timeline with deadlines | The brief's Level One journey ends at "monitor progress" and had no sense of pace at all. |
| Grades page | Marks lived inside whichever assessment produced them. There was nowhere to see them together, or to see what you still owe. |

### Left out, with reasons

**Ratings and reviews.** A four-person cohort produces no signal, and
inventing stars would be fabricating evidence in a system whose whole
argument is that its claims are measured.

**Specializations, employer logos, video player features.** Large scope,
social proof this programme has not earned, and a platform that
deliberately does not host video.

### ADR-020: deadlines are personalised and soft

The adaptation that matters. Coursera anchors deadlines to the date a
learner enrolled, not to a cohort calendar, and missing one carries no
penalty. Copying that here is the right answer for this population
rather than imitation.

A fixed cohort date punishes a participant for their electricity
supply. Someone who loses power for four days falls behind a date they
never had a fair chance at, and the system tells them they failed.

So due dates are DERIVED and never stored per participant: a week
offset on the module, an enrolment date, and a view computing the two.
Nothing to backfill, nothing to migrate, and no way for a stored date
to drift from the schedule it came from. Resetting a schedule is one
UPDATE to one column instead of a row per module.

The interface language follows: never "late", which judges the person,
but "behind your suggested pace", which describes a suggestion, offered
alongside a button to move the suggestion.

One test asserts structurally that no per-participant due date column
exists, so anyone who later moves deadlines into a table has to justify
it.

### DEFECT: the rollup could never complete a course with missing rows

Found by the suite, not by reading code.

`recalculate_progress` UPDATEd `module_progress` and counted modules by
counting rows in that table. Both assume a row exists per module. When
the rows were missing the UPDATE matched nothing, the count returned
zero, the `module_total > 0` guard failed, and **the enrolment could
never complete. Silently.** The participant finishes every item, sees
everything ticked, and the course stays open forever with no error
anywhere.

The rows go missing in several ways: a module added to a course after
someone enrolled, any code path that creates an enrolment without
seeding progress rows, or a partial restore.

ADR-021: derive the denominator, do not trust it. The rollup now counts
modules from `activity_modules`, which is the definition of how many
modules a course has, and UPSERTs `module_progress` rather than
updating it, so a missing row is created with the right status.

The generalisation is worth stating: `module_progress` is a CACHE of
something derivable from `item_progress`. Reading a cache as if it were
the source of truth means an incomplete cache reads as incomplete
truth, and here that meant telling someone they had not finished when
they had. Migration 008 ends by recalculating every live enrolment,
which repairs anyone already stuck.

### Test residue, again

The pacing tests delete an enrolment to check that a non-enrolled
person cannot read grades, then re-insert a bare one. That cascade
deletes the progress rows, which is precisely how the rollup defect
surfaced. Fixed on both sides: the test restores properly and calls the
repair function, and the rollup no longer depends on rows existing.

Also: the reset test depended on the test before it not having
completed the course. It now arranges its own precondition. And the
file restores the enrolment dates it shifts, because those dates drive
every derived deadline in the system.

### Coverage now 164

Added 18: personalised scheduling 8, grades 5, skills and objectives 5.


---

## Still to test

- [ ] RUN the load test (script now exists at server/load/participant-journey.js)
- [x] Enrolment capacity race under parallel requests (passing)
- [x] Attempt-limit race on assessment submission (passing)
- [ ] Refresh token reuse detection revoking a whole token family
- [ ] Rate limiter behaviour behind the Render proxy
- [ ] Lighthouse run on throttled 3G once the frontend exists
