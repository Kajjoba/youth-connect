# YouthConnect Platform (YCP)

MIT723 Web Application Engineering. Level One Virtual Exchange, complete
and working end to end. The Level Two data model is already in place
behind a feature flag.

```
ycp/
├── package.json          npm workspace root
├── server/               Node + Express + PostgreSQL API
│   ├── db/               schema, migrations, seed data
│   ├── docs/             test log, bandwidth measurement script
│   └── src/
│       ├── lib/          tokens, HTTP helpers, audit, errors
│       ├── middleware/   authenticate, authorize, validate, errors
│       └── routes/       auth, activities, assessments, participant
└── client/               React + Vite progressive web app
    ├── public/           service worker, manifest
    └── src/
        ├── lib/          API client, auth context, hooks
        ├── components/   layout, shared UI
        └── pages/        one per screen
```

## Running it

```bash
cd ycp
cp server/.env.example server/.env     # fill in DATABASE_URL and both secrets
npm install                            # installs both workspaces
npm run setup                          # migrate + seed
npm run dev                            # API on :4000, web on :5173
```

Generate each secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Demo accounts, all with password `YcpDemo2026!`:

| Role | Email |
|---|---|
| admin | admin@ycp.africa |
| facilitator | facilitator@ycp.africa |
| mentor | mentor@ycp.africa |
| participant | amina@ycp.africa |
| participant | kwame@ycp.africa |
| participant | joseph@ycp.africa |

## The participant journey

The brief specifies: Register, Create Profile, Discover Activities,
Enrol, Participate, Complete Assessment, Receive Feedback, Monitor
Progress. Each stage has one screen and one endpoint.

| Stage | Screen | Endpoint |
|---|---|---|
| Register | `/register` | `POST /api/auth/register` |
| Create profile | `/profile` | `PATCH /api/profiles/:id` |
| Discover | `/` | `GET /api/activities` |
| Enrol | `/activities/:id` | `POST /api/activities/:id/enrolments` |
| Participate | `/activities/:id` | `PUT .../modules/:moduleId/progress`, `POST .../threads` |
| Complete assessment | `/assessments/:id` | `POST /api/assessments/:id/submissions` |
| Receive feedback | `/assessments/:id` | `GET /api/assessments/submissions/:id/feedback` |
| Monitor progress | `/progress` | `GET /api/me/progress` |

## Architecture decisions

Each ADR sits at the top of the file it governs, so the reasoning lives
next to the code rather than rotting in a separate document.

| ADR | Decision | Where |
|---|---|---|
| 001 | Model both levels now, implement Level One only | `server/db/schema.sql` |
| 002 | UUID primary keys, never sequential | `server/db/schema.sql` |
| 003 | Fail-fast config, no silent development defaults | `server/src/config.js` |
| 004 | Bounded connection pool sized for managed Postgres | `server/src/db.js` |
| 005 | Authorisation denial returns 404, not 403 | `server/src/lib/errors.js` |
| 006 | Short access token plus rotating refresh token | `server/src/lib/tokens.js` |
| 007 | Client-rendered SPA rather than server rendering | `client/vite.config.js` |
| 008 | System font stack, no downloaded typeface | `client/src/styles.css` |
| 009 | Hand-written CSS, no framework | `client/src/styles.css` |
| 010 | Numbered, transactional, tamper-evident migrations | `server/db/migrate.js` |
| 011 | Structured JSON logs with automatic redaction | `server/src/lib/logger.js` |

## Verification

```bash
cd server
npm test              # 35 tests
npm run test:security # the brief's attack, run as assertions
```

35 automated tests against a real PostgreSQL database, zero test
dependencies. Mocking was rejected on purpose: row locks, unique
constraints, the authorisation joins and the versioning trigger all live
in the database, so a mock would pass while the system was broken.

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

CI (`.github/workflows/ci.yml`) runs these on every push and fails the
build if the first-load bundle exceeds 150 KB compressed. A performance
budget that is not enforced is a wish.

`server/load/participant-journey.js` is a k6 script for the scalability
claim. Read the note at the top before quoting results: 4,000 registered
participants do not mean 4,000 concurrent users, and the honest model is
100 to 200 virtual users.

## The three incidents in section 5 of the brief

The brief's testing incident names three distinct vulnerability classes.
All three are designed against and verified. Evidence in
`server/docs/test-log.md`.

**"Another user changes a project identifier and gains access to another
team's information."** Insecure Direct Object Reference, OWASP A01.
Defeated by `server/src/middleware/authorize.js`, a central policy layer
that resolves the caller's actual relationship to a record before any
handler runs, defaults to deny, and writes every decision to
`access_audit`. Verified: a participant pasting another participant's
submission id gets 404, and the attempt appears in the security console.

The client-side route guard in `client/src/App.jsx` is documented as a
convenience, not a control. Hiding a link hides the link, not the data.

**"One member cannot see the updated feedback."** Stale cache, partial
visibility and silent failure. Defeated by feedback versioning via a
database trigger, `visible_from` for atomic release, and per-version read
receipts. The client half is the ETag store in `client/src/lib/api.js`.
Verified: revising feedback invalidates a held ETag immediately and the
participant sees a "Revised" badge.

**"Repeatedly refreshing consumes excessive data."** No conditional
requests. Defeated by strong ETags with `If-None-Match`, gzip, keyset
pagination, optional field selection and route-level code splitting.
The live data meter in the masthead shows bytes used and bytes saved,
which makes this demonstrable in about ten seconds during the defence.

## Measured performance

First load, gzipped, from an actual `vite build`:

| Asset | Size |
|---|---|
| index.html | 1.12 KB |
| stylesheet | 2.18 KB |
| app entry | 5.67 KB |
| react + react-dom | 44.38 KB |
| router | 4.82 KB |
| **First load total** | **58.17 KB** |
| Deferred route code | 13.19 KB, fetched only when visited |

Budget was 150 KB. React is 76% of what remains, which is the honest
cost of ADR-007 and the number to quote if the committee asks what the
SPA decision cost.

API payloads, measured with `npm run measure`:

| Condition | Body |
|---|---|
| First load, uncompressed | 1682 bytes |
| First load, gzip | 779 bytes |
| Refresh unchanged (304) | 0 bytes |
| Narrowed with `?fields=` | 480 bytes |

The 304 carries no body but still costs roughly 200 bytes of headers.
State it as "refresh drops to header-only", not "to zero".

## Low bandwidth and unreliable connectivity

The brief calls this out twice, so it is treated as a first-class
requirement rather than an optimisation:

- Every activity displays its data weight before you open it
- On a 2G connection the catalogue defaults to hiding heavy activities
- A live meter shows data used and data saved this session
- Progress writes made offline are queued and replayed on reconnect,
  which is safe because the progress endpoint is idempotent
- The service worker serves the shell from cache and falls back to the
  last known API response when the network is gone
- Search input is debounced so typing does not fire a request per keystroke

## What is deliberately not here

- **Level Two routes.** Schema and the project authorisation resolver are
  ready. Routes ship when the CAT 2 brief is confirmed. Keep this work on
  a `level-two` branch so the git history evidences extension without
  redesign.
- **File upload for project evidence.** Level Two concern.
- **Load test.** The brief says 4,000 users. Do not claim scalability in
  the report until this has actually been run. It is listed as
  outstanding in the test log.
- **Facilitator authoring UI.** The endpoints exist and are tested;
  no screen yet.

## Notes for the report

- Grep for `REQ-` to build the traceability matrix. 24 requirement IDs
  are currently referenced in code.
- `npm run measure` regenerates the bandwidth evidence.
- The demo password is in `server/db/seed.js` in plain text. Fine for a
  marked submission, not fine if this repository ever goes public.
