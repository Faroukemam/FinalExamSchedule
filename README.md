# ExamFlow

ExamFlow is a final exam scheduling system for managing exam data, building schedules, detecting student conflicts, and exporting final reporting packs.

## Features

- student and subject import
- exam slot and capacity management
- manual and automatic scheduling
- conflict detection
- final reports and export tools

## Tech Stack

- Backend: Node.js, Express, sql.js
- Frontend: React, Vite
- Reports: Excel export and Word-compatible export for selected forms

## Project Structure

```text
.
|-- client/              # React frontend
|-- server/              # Express API, database, reports, scheduling
|-- server/db/           # Local database files
|-- server/uploads/      # Generated exports
|-- package.json         # Root scripts
```

## Requirements

- Node.js 18+ recommended
- npm
- Python 3 for OR-Tools based auto-scheduling

## Installation

Install both backend and frontend dependencies:

```bash
npm install
cd client
npm install
```

Or use the root helper script:

```bash
npm run install-all
```

## Development

Run frontend and backend together:

```bash
npm run dev
```

Run the backend only:

```bash
npm run server
```

Run the frontend only:

```bash
npm run client
```

The frontend runs with Vite at `http://localhost:5173`. The backend defaults to `http://localhost:3002`.
The Vite API and upload proxies share the backend port configuration in `server/config.js`.
If you set `PORT`, run `npm run dev` with that variable so both processes use the same port.

## Build

```bash
npm run build
```

## Environment

Supported environment variables:

- `PORT`: backend port and Vite proxy destination, default `3002`
- `PYTHON_PATH` or `PYTHON`: optional explicit Python executable for auto-schedule

See `.env.example`.

## Local Data

Slots have two independent capacity pools, `major_cap` and `minor_cap`.
Subjects do not need a Major/Minor classification: the application chooses a
pool automatically, preferring Major and using Minor when needed. Each subject's
assigned students in an automatically scheduled slot must fit entirely within one pool. Pool limits apply
to the total students in that pool; pool space is never combined to fit one
oversized subject. For example, caps of 100 and 50 can hold subjects of 100 and
50, but cannot hold a single subject of 120, or two subjects of 60.

Pool allocation is calculated for current assignments as well as new ones.
Subjects can switch pools within a slot to find a valid allocation without
moving their exam periods or student registrations. The schedule API exposes
`capacity_pool` and `capacity_valid`; the Slots page and capacity reports use
these computed values. Legacy subject `capacity_type` data is ignored by the
schedulers and retained only for compatibility.

To limit individual subject sizes on selected slots, open **Slots And Caps**,
select the desired slot checkboxes, enable **Max students per subject**, enter
the limit, and click **Apply Limits To Selected**. Major and Minor limits can
also be updated this way; unchecked limits and unselected slots stay unchanged.
For example, a Major cap of 300, Minor cap of 100, and per-subject limit of 100
allow four subjects of 100 students: three in Major and one in Minor.

Blank limits mean unlimited; zero permits no students during schedule imports
and automatic scheduling. Manual assignment, moves, and additional program
placements can exceed Major/Minor period caps, including zero caps. Per-subject
limits still apply to manual assignments and affected split placements. Removing
a manual entry also allows the remaining period total to exceed its pool caps.
Over-capacity assignments remain visible in the schedule and reports. Schedule
imports and both auto-schedulers enforce all limits. Changes to slot limits that
would overflow existing assignments are rejected without changing those
assignments. Slot imports/exports support `major_cap`, `minor_cap`, and
`subject_cap` (also `Major_Cap`, `Minor_Cap`, and `Subject_Cap`).

Dates throughout the app and reports use `DD/MM/YYYY`. Stored dates and API
values use `YYYY-MM-DD` for chronological sorting and scheduling. Existing saved
dates use the same display format automatically. Audit timestamps use Cairo time.

Slot imports accept native Excel date/time cells, text dates in `DD/MM/YYYY` or
`YYYY-MM-DD` (and legacy `YYYY/DD/MM` files), and times in `HH:mm` or `h:mm AM/PM`. They also honor the Excel 1904
date system. Spaced capacity headers such as `Major Cap`, `Minor Cap`, and
`Max students per subject` are accepted. Unknown or duplicate columns are
reported as errors rather than silently ignored; exported slot registers can
be imported directly.

A blank cell in an included capacity column clears that limit to unlimited.
Omitting the column preserves its current value. Zero remains an explicit zero
limit. Equivalent date/time values match an existing slot instead of creating
a duplicate. Ambiguous pre-existing duplicates are reported for consolidation;
the importer does not merge their schedule assignments automatically.

Valid rows are imported even if other rows are rejected, with separate imported,
updated and rejected counts and spreadsheet row numbers. An entirely rejected
file returns HTTP 422 with `success: false`; malformed or empty requests return
400. The UI shows persistent row errors and warning/error feedback as appropriate.
Validation checks changed slots and other slots affected by allocation changes;
an existing overload in an untouched slot does not block an unrelated update.

On backend startup, the schema migrates automatically: existing slot caps become
Major caps, and newly introduced Minor/per-subject limits start unlimited.
Legacy `student_cap` API input remains an alias for `major_cap`.

Run capacity regression tests with `npm test`. The OR-Tools test runs when the
configured Python runtime has OR-Tools installed; the fallback is always tested.

## Final Reports

The reports page contains nine focused exports:

- **Exam Schedule:** detailed assignments and a date/time grid.
- **University Form:** the printable Word timetable, with subjects, room
  types and student counts. Major/Minor pool details are excluded from Word.
- **Program Schedule Grids:** a combined **Schedule Grid** as the first sheet,
  followed by one timetable grid per program. A selector also exports one program
  grid at a time. This workbook contains no detailed list sheets. The full Excel
  pack includes the shared Schedule Grid only once.
- **Student form:** an Excel workbook with dates in columns and actual start/end
  times in rows. The first sheet covers all programs, followed by one sheet
  per program. Each table has a report/program title above it, repeated on printed
  pages; subjects appear one per line, with zero-student assignments excluded.
- **Detailed Schedule Grid:** one detailed timetable sheet per
  department, with no combined sheet in this workbook. Rows show day/date and
  columns show time slots. Each subject block contains its code/name, programs
  and counts, room type, assigned student total, and available student ID ranges.
  Program-targeted entries for the same subject/slot are combined so the subject
  appears once with its full assigned count. Departments follow the subject's
  department; all sheets share the same calendar and time columns. Missing
  departments appear as Unspecified. The departmental sheets are also included
  in the full Excel pack.
- **Room Requirements:** TH, LAB and DH subject lists and counts by slot.
- **Capacity & Workload:** an overview, slot capacities and remaining pool space,
  per-subject violations, and daily/department workload.
- **Conflicts:** summary counts, detailed records and affected students.
- **Subject Status:** actual assignment status, assigned periods, outstanding
  subjects, no-final subjects and source-data inconsistencies.

**Export Full Excel Pack** includes every retained Excel sheet once. Separate
summary cards, period utilization, subject footprint, program distribution and
risk ranking cards were consolidated into the relevant exports or removed where
they duplicated data. Student risk levels and arbitrary heavy/normal slot labels
are no longer reported. Workload totals count student exam assignments rather
than unique students; the overview labels registered students separately.

Reports use automatic pool allocations and actual schedule rows instead of
assuming every subject is Major or trusting stale subject status flags. Empty
slots, zero caps and unlimited caps remain distinguishable. Missing program
information is reported as Unspecified, so student counts are not lost.

Excel exports include styled headers, alternating row colors, borders, wrapped
text, and filters. Schedule grids freeze the date columns and header row, widen
time-slot columns to their content, and size rows for subject details. Each subject
occupies one line within its time-slot cell, including in detailed department grids.
Split assignments for the same subject share one line with combined counts.
Schedule exports omit assignments with no students. Subject-status exports omit
subjects with neither enrolled nor assigned students; empty calendar slots remain.
Sheets print in landscape
with repeated headers and fit to one page wide.

The app stores runtime data in:

- `server/db/examflow.db`
- `server/uploads/`

These files are ignored in Git because they are machine-local runtime artifacts.

## Demo Accounts

On a fresh local database, the app seeds demo users:

- `admin` / `admin123`
- `coordinator` / `admin123`
- `viewer` / `admin123`

Change these immediately in any non-demo environment.

## First Push

```bash
git add .
git commit -m "Initial commit"
git remote add origin <your-repo-url>
git branch -M main
git push -u origin main
```

## Notes

- Do not commit local database snapshots or generated report exports.
- If auto-schedule falls back from OR-Tools, verify Python and solver dependencies on the host machine.
