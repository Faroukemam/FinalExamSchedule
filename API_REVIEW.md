# API review

Follow-up: the slot-import fixes address R2 (selected-slot URL variants), the
slot-import portions of R8 (input validation) and R12 (failure responses), and
the unrelated-slot capacity validation issue found after this review. Native
Excel parsing, blank limits, header validation and canonical slot matching now
have regression coverage. The original findings below are retained as review
history; the remaining endpoints have not all been remediated. The suite now
also includes automatic Major/Minor pool allocation without subject categories.
Each subject must fit entirely within one pool; capacity cannot be combined to
fit an oversized subject. Legacy subject category values do not control scheduling.

The report refresh also addresses R4 by forcing Word exports to `.doc`, adds
unique export filenames and case-insensitive worksheet names, validates export
data, and makes the remaining/no-final report endpoints follow actual schedule
rows. The reports UI now uses seven consolidated packs with updated capacity
and assignment-status data. Other original findings remain review history and
are not all fixed by these changes.

Reviewed 43 route registrations across nine routers, plus server middleware,
allocation helpers, capacity checks, and the Python scheduler.

The review used source inspection and targeted HTTP requests against an isolated
in-memory database with foreign keys enabled. Export testing used an in-memory
filesystem. Application source and the live database were not changed. The
existing 15 capacity regression tests pass; they do not cover all the failures
below. This is a code review with targeted reproductions, not a complete
penetration test or a load test.

## Findings, ordered by priority

### R1 — Critical: API access does not require authentication or authorization

`server/index.js:22` mounts every router without an authentication or role
middleware. `POST /api/auth/login` checks a password but creates no server session
or token. Student data, user listings, reports, settings changes, and destructive
operations are therefore accessible without logging in. The server also listens
on all network interfaces.

Confirmed with anonymous HTTP requests: `GET /api/students` returned 200;
`DELETE /api/students/all` returned 200 and removed the fixture's students.

Require an authenticated identity on protected routes and explicit permissions
for viewing student records, changing schedules/settings, and clearing data.
Protect generated downloads as well as their creation endpoints.

### R2 — High: selected-slot updates can silently update every slot

`server/routes/periods.js:61` determines scope using
`req.path === '/set-caps'`. Express accepts trailing slashes and different casing
by default, so `/set-caps/` and `/SET-CAPS` reach the same handler but use its
all-slots branch.

Confirmed: sending `{period_ids:[1], subject_cap:7}` to
`PUT /api/periods/set-caps/` changed both fixture slots to 7. Uppercase reproduced
the same failure. This bug was introduced in the selected-slot handler added
during the capacity change.

Give the selected-slots and all-slots routes explicit scope through separate
handlers or a handler factory; never infer update scope from request spelling.
Add real HTTP tests for route aliases, not only direct handler tests.

### R3 — High: importing student metadata can delete registrations

`server/routes/students.js:97` uses `INSERT OR REPLACE` on `students`. With foreign
keys enabled, replacing an existing student deletes that student's registrations
through `ON DELETE CASCADE`. The route then recreates only the supplied courses.

Confirmed: importing an existing student's ID and updated name without a courses
column reduced their registrations from two to zero, with 200 and no errors.

Use an actual update/upsert. Define whether an explicitly supplied course list
replaces or merges registrations; omitted courses should preserve existing data.

### R4 — High: Word export can publish executable HTML on the application origin

`server/routes/reports.js:65` retains caller-controlled filename extensions.
`POST /api/reports/export-word` writes untrusted HTML verbatim, and
`server/index.js:14` publicly serves the upload directory through `express.static`.

Confirmed with a mocked filesystem: a request using `filename: 'review.html'`
and a script element returned an `/uploads/...review.html` URL and stored the
script unchanged. Opening that public HTML URL can execute script on the
application origin. Browser execution itself was not tested.

Force the intended document extension and download content type/disposition.
Do not publicly serve arbitrary caller-specified file types as active content.

### R5 — High: subject status and actual schedule rows become inconsistent

Three independent HTTP reproductions returned success:

- `POST /api/schedule/assign` with `assignMode: 'add'` inserted a placement but
  left the subject `unscheduled` (`server/routes/schedule.js:454`).
- `DELETE /api/periods/:id` marked a split subject `unscheduled` even though it
  still had a placement in another period (`server/routes/periods.js:206`).
- `POST /api/subjects/import` with `no_exam: 'no'` marked a scheduled subject
  `unscheduled` without removing its schedule row (`server/routes/subjects.js:349`).

The dashboard and remaining-subject reports read status; auto-scheduling also
uses status to select candidates. These inconsistencies can therefore misreport
work and cause an existing placement to be rescheduled unexpectedly.

Update status transactionally from the remaining schedule rows, and preserve
scheduled status when an import merely confirms that a subject has an exam.

### R6 — High: manual assignment and schedule import bypass scheduling rules

`server/routes/schedule.js:425` reads the subject status but does not reject
`no_final_exam`; it also does not validate exam duration against the period.
The import route updates individual subjects without preserving same-period
groups (`server/routes/schedule.js:568`).

Confirmed: a no-final subject requiring 180 minutes was successfully assigned to
a 120-minute slot and became `scheduled`. In a separate fixture, importing one
member of a same-period group moved it to another slot while its partner stayed
behind. Subject duration and period-time edits can also invalidate an existing
placement without revalidation.

Centralize placement validation and use it for manual assignment, imports,
auto-scheduling, and edits affecting existing placements.

### R7 — High: auto-scheduling still permits clashes and undercounts grouped exams

`server/scripts/auto_schedule_ortools.py:288` adds simultaneous-exam penalties to
the objective rather than forbidding clashes. Both schedulers count a grouped
unit once per enrolled student rather than counting the student's actual exams:
`server/scripts/auto_schedule_ortools.py:205` and
`server/routes/schedule.js:253`.

The earlier isolated reproductions remain applicable: two simultaneous exams
can be reported as successfully scheduled, and three subjects in a group can
bypass the two-exams-per-day constraint. Capacity tests passing does not establish
that a schedule satisfies student-conflict rules.

Make impossible-to-attend combinations hard constraints, or explicitly return
them as unresolved placements. Count exam multiplicity within grouped units.

### R8 — Medium: invalid dates, times, durations, and policy values are accepted

`server/utils/date.js:23` returns arbitrary unrecognized date strings. Period
create/update/import paths largely validate presence, not actual dates or valid
clock times. Subject duration edits and settings changes also lack a consistent
schema or allowed-value checks.

Confirmed: creating a period with `exam_date:'garbage'`, `start_time:'25:99'`
returned 200 and stored the invalid period. Such data can break solver date/time
parsing or make conflicts disappear.

Validate real calendar dates, time format/ranges, duration rules, arrays, IDs,
and supported setting keys/values before mutation; return 400 for invalid input.

### R9 — Medium: cell conflicts disagree with the allocation-aware conflict list

`server/routes/conflicts.js:243` computes cell conflicts from all registrations
in the cell's subject codes, ignoring which students are allocated to those
particular program-specific placements.

Confirmed: one fixture returned zero global conflicts but one conflict from
`GET /api/conflicts/cell/1`, for a student whose A exam was actually in slot 2.

Use the same allocated student assignments in both conflict endpoints.

### R10 — Medium: subject imports reset fields that were omitted

`server/routes/subjects.js:367` always updates duration and room placement type.
Their import defaults are 120 minutes and TH, so an otherwise partial update
silently overwrites existing values.

Confirmed: importing only an existing subject's code and name changed its
duration from 180 to 120. Preserve existing values when those columns are absent;
apply defaults only when creating a subject.

### R11 — Medium: auto-scheduling blocks all API traffic

`server/routes/schedule.js:101` calls `spawnSync` inside the HTTP handler with a
30-second timeout per Python runtime attempt. While the call runs, Node cannot
serve other requests. This is a source-confirmed issue; no load test was run.

Use an asynchronous process or a job worker, and account for concurrent schedule
changes before committing the computed result.

### R12 — Medium: error responses and success counts are unreliable

Confirmed examples:

- `POST /api/subjects/bulk-update` with `{}` returns 500 (`data is not iterable`)
  instead of a validation response.
- Creating an existing subject returns success while `INSERT OR IGNORE` changes
  nothing (`server/routes/subjects.js:409`).
- Deleting a nonexistent period returns success without identifying a missing
  resource. Idempotent deletion can be intentional, but the API should document
  the contract.

Additional source findings: bulk period creation increments `created` for ignored
duplicates (`server/routes/periods.js:134`); imports commonly return
`success:true` even when every row failed; malformed Excel JSON is reported as
500. Define validation errors, partial import results, duplicate behavior, and
actual affected-row counts consistently.

## Route inventory and review coverage

All paths below use the `/api` prefix. All routes share R1. The table lists
additional findings relevant to each route; a dash means no additional finding
was identified in this review, not that the endpoint is proven defect-free.

| Method | Path | Additional findings |
| --- | --- | --- |
| GET | /students | — |
| GET | /students/:id | — |
| POST | /students/import | R3, R8, R12 |
| DELETE | /students/all | — |
| GET | /subjects | R5 affects returned status |
| GET | /subjects/same-period-groups | R6 affects group consistency |
| POST | /subjects/same-period-groups | R6: existing placements/durations/statuses not checked |
| DELETE | /subjects/same-period-groups/:id | — |
| GET | /subjects/:code | R5 affects returned status |
| PUT | /subjects/:code | R5, R6, R8 |
| POST | /subjects/import | R5, R8, R10, R12 |
| POST | /subjects | R8, R12 |
| POST | /subjects/bulk-update | R6, R8, R12 |
| DELETE | /subjects/all | — |
| GET | /periods | — |
| POST | /periods | R8, R12 |
| PUT | /periods/set-cap-all | R2: shared handler scope |
| PUT | /periods/set-caps | R2 |
| PUT | /periods/:id | R6, R8 |
| POST | /periods/bulk | R8, R12 |
| POST | /periods/import | R6, R8, R12 |
| DELETE | /periods/:id | R5, R12 |
| DELETE | /periods | — |
| GET | /schedule | R5/R6 affect data consistency |
| POST | /schedule/assign | R5, R6 |
| DELETE | /schedule/unassign/:subject_code | R12: nonexistent subject reports success |
| POST | /schedule/import | R6, R8, R12 |
| POST | /schedule/auto-schedule | R5, R7, R8, R11 |
| DELETE | /schedule/unassign-entry/:id | — |
| DELETE | /schedule/clear-all | — |
| GET | /conflicts | R8 affects time/date comparisons |
| GET | /conflicts/cell/:periodId | R9 |
| GET | /reports/schedule | R5/R6 affect data consistency |
| GET | /reports/remaining | R5 affects inclusion |
| GET | /reports/no-final | R5/R6 affect inclusion |
| POST | /reports/export-excel | R12: malformed JSON returns 500 |
| POST | /reports/export-word | R4 |
| POST | /auth/login | R1; malformed credential types can return 500 |
| GET | /auth/users | — |
| GET | /auth/settings | R8: arbitrary policy values can be stored |
| PUT | /auth/settings | R8 |
| GET | /audit | Actor is not populated by existing audit writers; many mutations have no audit entry |
| GET | /dashboard | R5 affects counts |

## Verification limits

- Read-only endpoints and straightforward destructive handlers received source
  review; targeted HTTP reproductions concentrated on the findings above.
- Export generation was tested with a mocked filesystem; public browser script
  execution was inferred from unchanged HTML and static hosting configuration.
- The review did not modify or initialize the live database, generate actual
  exports, test the deployed host, or benchmark production data volumes.
- Existing capacity tests exercise normal selected-slot requests, capacity
  rejection/rollback, imports, mixed groups, split allocations, schema migration,
  and both scheduler engines. Route-spelling variants were missing from them.
