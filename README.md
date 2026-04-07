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

The frontend runs with Vite. The backend defaults to `http://localhost:3001`.

## Build

```bash
npm run build
```

## Environment

Supported environment variables:

- `PORT`: backend port, default `3001`
- `PYTHON_PATH` or `PYTHON`: optional explicit Python executable for auto-schedule

See `.env.example`.

## Local Data

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
