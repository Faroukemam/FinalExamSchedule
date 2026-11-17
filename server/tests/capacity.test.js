const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const initSqlJs = require('sql.js');
const { buildAllocatedScheduleEntries } = require('../utils/scheduleAllocation');
const { withCapacityTransaction, normalizeCap } = require('../utils/capacity');
const { allocatePools } = require('../utils/poolAllocation');

let SQL;
before(async () => { SQL = await initSqlJs(); });

// Exercise the actual schema/migrations without opening the application's database.
function migrate(db) {
    const source = fs.readFileSync(path.join(__dirname, '../db/db.js'), 'utf8');
    vm.runInNewContext(source.slice(source.indexOf('    // Create tables'), source.indexOf('    // Default settings')), { db, console });
    db.saveToFile = () => {};
    return db;
}

function fixture() {
    const db = migrate(new SQL.Database());
    db.run('PRAGMA foreign_keys=ON');
    db.run("INSERT INTO exam_periods (id, exam_date, start_time, end_time, major_cap, minor_cap, subject_cap) VALUES (1, '2026-12-01', '09:00', '11:00', 4, 2, 2), (2, '2026-12-03', '09:00', '11:00', 10, 10, 10)");
    return db;
}

function subject(db, code, count, type = 'major', programs = ['P']) {
    db.run('INSERT INTO subjects (subject_code, student_count, capacity_type) VALUES (?, ?, ?)', [code, count, type]);
    for (let i = 0; i < count; i++) {
        const id = `${code}-${i}`;
        db.run('INSERT INTO students (student_id, student_name, program) VALUES (?, ?, ?)', [id, id, programs[i % programs.length]]);
        db.run('INSERT INTO registrations (student_id, subject_code) VALUES (?, ?)', [id, code]);
    }
}

function call(router, routePath, method, db, body = {}, params = {}) {
    const layer = router.stack.find(item => item.route?.path === routePath && item.route.methods[method]);
    assert.ok(layer, `Missing route ${method} ${routePath}`);
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    layer.route.stack[0].handle({ app: { locals: { db } }, body, params, path: routePath, query: {} }, res);
    return res;
}

const schedule = require('../routes/schedule');
const periods = require('../routes/periods');
const subjects = require('../routes/subjects');
const students = require('../routes/students');
const assign = (db, code, period = 1, extra = {}) => call(schedule, '/assign', 'post', db, { subject_code: code, exam_period_id: period, ...extra });
const scalar = (db, sql) => db.exec(sql)[0].values[0][0];

test('legacy migration preserves old caps as Major, defaults subjects to Major and is repeatable', () => {
    const db = new SQL.Database();
    db.run("CREATE TABLE exam_periods (id INTEGER PRIMARY KEY, exam_date TEXT, start_time TEXT, end_time TEXT, student_cap INTEGER)");
    db.run("INSERT INTO exam_periods VALUES (1, '2026-12-01', '09:00', '11:00', 250)");
    migrate(db);
    assert.deepEqual(db.exec('SELECT major_cap, minor_cap, subject_cap FROM exam_periods')[0].values, [[250, null, null]]);
    db.run("INSERT INTO subjects (subject_code) VALUES ('A')");
    assert.equal(scalar(db, "SELECT capacity_type FROM subjects WHERE subject_code='A'"), 'major');
    db.run('UPDATE exam_periods SET major_cap=200, minor_cap=50, subject_cap=100');
    migrate(db);
    assert.deepEqual(db.exec('SELECT major_cap, minor_cap, subject_cap FROM exam_periods')[0].values, [[200, 50, 100]]);
    db.close();
});

test('manual assignments can exceed combined period capacity and remain visible as over capacity', () => {
    const db = fixture();
    for (const [code, count, type] of [['A', 2, 'major'], ['B', 2, 'major'], ['C', 1, 'major'], ['M', 2, 'minor'], ['N', 1, 'minor']]) subject(db, code, count, type);
    for (const code of ['A', 'B', 'M']) assert.equal(assign(db, code).statusCode, 200);
    assert.equal(assign(db, 'C').statusCode, 200);
    assert.equal(assign(db, 'N').statusCode, 200);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM schedule'), 5);
    assert.equal(scalar(db, "SELECT status FROM subjects WHERE subject_code='C'"), 'scheduled');
    const entries = buildAllocatedScheduleEntries(db);
    assert.equal(entries.reduce((sum, row) => sum + row.student_count, 0), 8);
    assert.ok(entries.every(row => row.capacity_valid === false));
    db.close();
});

test('oversized subject move is rejected and its old placement survives', () => {
    const db = fixture();
    subject(db, 'BIG', 3);
    assert.equal(assign(db, 'BIG', 2).statusCode, 200);
    const result = assign(db, 'BIG', 1);
    assert.equal(result.statusCode, 409);
    assert.match(result.body.error, /per-subject limit/);
    assert.equal(scalar(db, "SELECT exam_period_id FROM schedule WHERE subject_code='BIG'"), 2);
    db.close();
});

test('manual moves and program-specific additions exceed period caps and can be removed while still overloaded', () => {
    const db = fixture();
    db.run('UPDATE exam_periods SET major_cap=1, minor_cap=0, subject_cap=6 WHERE id=1');
    subject(db, 'MOVE', 3);
    assert.equal(assign(db, 'MOVE', 2).statusCode, 200);
    assert.equal(assign(db, 'MOVE', 1).statusCode, 200);
    assert.equal(scalar(db, "SELECT exam_period_id FROM schedule WHERE subject_code='MOVE'"), 1);
    subject(db, 'SPLIT', 6, 'major', ['P', 'Q']);
    db.run("INSERT INTO settings VALUES ('allow_multi_exam_subject', 'true')");
    assert.equal(assign(db, 'SPLIT', 2, { assignMode: 'add', target_program: 'Q' }).statusCode, 200);
    assert.equal(assign(db, 'SPLIT', 1, { assignMode: 'add', target_program: 'P' }).statusCode, 200);
    const entries = buildAllocatedScheduleEntries(db);
    assert.deepEqual(entries.filter(row => row.subject_code === 'SPLIT').map(row => row.student_count), [3, 3]);
    const id = scalar(db, "SELECT id FROM schedule WHERE subject_code='MOVE'");
    assert.equal(call(schedule, '/unassign-entry/:id', 'delete', db, {}, { id }).statusCode, 200);
    assert.equal(scalar(db, "SELECT status FROM subjects WHERE subject_code='MOVE'"), 'unscheduled');
    assert.equal(buildAllocatedScheduleEntries(db).find(row => row.exam_period_id === 1).capacity_valid, false);
    assert.equal(assign(db, 'SPLIT', 1, { assignMode: 'add', target_program: 'P' }).statusCode, 400);
    assert.equal(assign(db, 'MISSING').statusCode, 404);
    assert.equal(assign(db, 'SPLIT', 999).statusCode, 404);
    db.close();
});

test('selected-slot updates preserve other slots and unchecked caps; overflow rolls back the whole batch', () => {
    const db = fixture();
    subject(db, 'BIG', 3);
    assert.equal(assign(db, 'BIG', 2).statusCode, 200);
    const update = body => call(periods, '/set-caps', 'put', db, body);
    assert.equal(update({ period_ids: [1], subject_cap: 1 }).statusCode, 200);
    assert.deepEqual(db.exec('SELECT major_cap, minor_cap, subject_cap FROM exam_periods ORDER BY id')[0].values, [[4, 2, 1], [10, 10, 10]]);
    assert.equal(update({ period_ids: [1, 2], subject_cap: 2 }).statusCode, 409);
    assert.deepEqual(db.exec('SELECT subject_cap FROM exam_periods ORDER BY id')[0].values, [[1], [10]]);
    assert.equal(update({ period_ids: [1], subject_cap: '' }).statusCode, 200);
    assert.equal(scalar(db, 'SELECT subject_cap FROM exam_periods WHERE id=1'), null);
    assert.equal(update({ period_ids: [], subject_cap: 1 }).statusCode, 400);
    assert.equal(update({ period_ids: [999], subject_cap: 1 }).statusCode, 404);
    assert.equal(update({ period_ids: [1], subject_cap: -1 }).statusCode, 400);
    assert.equal(update({ period_ids: [1], subject_cap: 1.5 }).statusCode, 400);
    db.close();
});

test('groups use automatic pools atomically; per-subject cap is not a cap on the group', () => {
    const db = fixture();
    subject(db, 'A', 2);
    subject(db, 'M', 2, 'minor');
    db.run("INSERT INTO same_period_groups (id, group_name) VALUES (1, 'Mixed')");
    for (const code of ['A', 'M']) db.run('INSERT INTO same_period_group_subjects VALUES (1, ?)', [code]);
    assert.equal(assign(db, 'A').statusCode, 200);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM schedule WHERE exam_period_id=1'), 2);
    call(periods, '/set-caps', 'put', db, { period_ids: [2], major_cap: 3, minor_cap: 1 });
    assert.equal(assign(db, 'A', 2).statusCode, 200);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM schedule WHERE exam_period_id=1'), 0);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM schedule WHERE exam_period_id=2'), 2);
    assert.ok(buildAllocatedScheduleEntries(db).every(row => row.capacity_valid === false));
    db.run('UPDATE exam_periods SET subject_cap=1 WHERE id=1');
    const auditCount = scalar(db, 'SELECT COUNT(*) FROM audit_log');
    assert.equal(assign(db, 'A', 1).statusCode, 409);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM schedule WHERE exam_period_id=2'), 2);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM audit_log'), auditCount);
    db.close();
});

test('schedule imports report rejected rows accurately and preserve previous assignments', () => {
    const db = fixture();
    subject(db, 'BIG', 3);
    assign(db, 'BIG', 2);
    const res = call(schedule, '/import', 'post', db, { data: [{ subject_code: 'BIG', exam_date: '2026-12-01', start_time: '09:00', end_time: '11:00' }] });
    assert.equal(res.body.assigned, 0);
    assert.match(res.body.errors[0], /per-subject limit/);
    assert.equal(scalar(db, "SELECT exam_period_id FROM schedule WHERE subject_code='BIG'"), 2);
    db.close();
});

test('legacy subject categories do not control pools; enrollment overflow is rejected', () => {
    const db = fixture();
    subject(db, 'A', 2);
    subject(db, 'B', 2);
    subject(db, 'M', 2, 'minor');
    for (const code of ['A', 'B', 'M']) assign(db, code);
    const res = call(subjects, '/:code', 'put', db, { capacity_type: 'major' }, { code: 'M' });
    assert.equal(res.statusCode, 200);
    assert.equal(scalar(db, "SELECT capacity_type FROM subjects WHERE subject_code='M'"), 'major');
    assert.equal(buildAllocatedScheduleEntries(db).filter(row => row.capacity_pool === 'minor').reduce((sum, row) => sum + row.student_count, 0), 2);
    const imported = call(students, '/import', 'post', db, { data: [{ student_id: 'new', student_name: 'New', courses: 'A' }] });
    assert.equal(imported.body.studentsImported, 0);
    assert.equal(imported.body.totalErrors, 1);
    assert.equal(scalar(db, "SELECT COUNT(*) FROM students WHERE student_id='new'"), 0);
    db.close();
});

test('program-specific assignments count only allocated students and protect every affected slot', () => {
    const db = fixture();
    subject(db, 'A', 4, 'major', ['P', 'Q']);
    db.run("INSERT INTO settings VALUES ('allow_multi_exam_subject', 'true')");
    assert.equal(assign(db, 'A', 1, { assignMode: 'add', target_program: 'P' }).statusCode, 409);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM schedule'), 0);
    assert.equal(assign(db, 'A', 2, { assignMode: 'add', target_program: 'Q' }).statusCode, 200);
    assert.equal(assign(db, 'A', 1, { assignMode: 'add', target_program: 'P' }).statusCode, 200);
    assert.deepEqual(buildAllocatedScheduleEntries(db).map(row => row.student_count), [2, 2]);
    db.close();
});

test('manual assignments can exceed zero period caps; invalid caps and per-subject violations are rejected', () => {
    const db = fixture();
    subject(db, 'A', 1);
    assert.equal(call(periods, '/set-caps', 'put', db, { period_ids: [1], major_cap: 0, minor_cap: 0 }).statusCode, 200);
    assert.equal(assign(db, 'A').statusCode, 200);
    assert.equal(buildAllocatedScheduleEntries(db)[0].capacity_valid, false);
    assert.equal(call(periods, '/set-caps', 'put', db, { period_ids: [1], major_cap: '', subject_cap: '' }).statusCode, 200);
    assert.equal(assign(db, 'A').statusCode, 200);
    for (const value of [-1, 1.5, 'invalid', true, []]) assert.throws(() => normalizeCap(value));
    assert.equal(normalizeCap(0), 0);
    assert.equal(normalizeCap(''), null);
    assert.equal(normalizeCap('  '), null);
    assert.throws(() => withCapacityTransaction(db, () => { db.run('UPDATE exam_periods SET subject_cap=0 WHERE id=1'); }), /per-subject limit/);
    assert.equal(scalar(db, 'SELECT subject_cap FROM exam_periods WHERE id=1'), null);
    db.close();
});

test('subject create/import/bulk-edit support categories and imports preserve omitted categories', () => {
    const db = fixture();
    assert.equal(call(subjects, '/', 'post', db, { subject_code: 'A', capacity_type: 'minor' }).statusCode, 200);
    assert.equal(call(subjects, '/', 'post', db, { subject_code: 'B' }).statusCode, 200);
    assert.equal(call(subjects, '/', 'post', db, { subject_code: 'BAD', capacity_type: 'other' }).statusCode, 400);
    assert.equal(call(subjects, '/import', 'post', db, { data: [{ subject_code: 'A', subject_name: 'Renamed' }, { subject_code: 'C', Capacity_Type: 'Minor' }] }).body.updated, 1);
    assert.equal(scalar(db, "SELECT capacity_type FROM subjects WHERE subject_code='A'"), 'minor');
    assert.equal(scalar(db, "SELECT capacity_type FROM subjects WHERE subject_code='C'"), 'minor');
    assert.equal(call(subjects, '/bulk-update', 'post', db, { data: [{ subject_code: 'B', capacity_type: 'minor' }] }).statusCode, 200);
    assert.equal(scalar(db, "SELECT capacity_type FROM subjects WHERE subject_code='B'"), 'minor');
    db.close();
});

test('slot create/bulk/import preserve all three limits, including zero and omitted fields', () => {
    const db = fixture();
    assert.equal(call(periods, '/', 'post', db, { exam_date: '2026-12-05', start_time: '09:00', end_time: '11:00', major_cap: 10, minor_cap: 0, subject_cap: 3 }).statusCode, 200);
    assert.equal(call(periods, '/bulk', 'post', db, { dates: ['2026-12-06'], periods: [{ start_time: '09:00', end_time: '11:00' }], major_cap: 20, minor_cap: 5, subject_cap: 4 }).statusCode, 200);
    assert.deepEqual(db.exec('SELECT major_cap, minor_cap, subject_cap FROM exam_periods ORDER BY id DESC LIMIT 2')[0].values, [[20, 5, 4], [10, 0, 3]]);
    let imported = call(periods, '/import', 'post', db, { data: [{ Exam_Date: '2026-12-01', Start_Time: '09:00', End_Time: '11:00', Subject_Cap: 0 }] });
    assert.equal(imported.body.updated, 1);
    assert.deepEqual(db.exec('SELECT major_cap, minor_cap, subject_cap FROM exam_periods WHERE id=1')[0].values, [[4, 2, 0]]);
    imported = call(periods, '/import', 'post', db, { data: [{ Exam_Date: '2026-12-01', Start_Time: '09:00', End_Time: '11:00', Subject_Cap: '' }] });
    assert.equal(imported.body.updated, 1);
    assert.equal(scalar(db, 'SELECT subject_cap FROM exam_periods WHERE id=1'), null);
    subject(db, 'A', 2);
    assign(db, 'A');
    imported = call(periods, '/import', 'post', db, { data: [{ exam_date: '2026-12-01', start_time: '09:00', end_time: '11:00', major_cap: 1, minor_cap: 1 }] });
    assert.equal(imported.body.updated, 0);
    assert.match(imported.body.errors[0], /Slot capacity exceeded/);
    assert.equal(scalar(db, 'SELECT major_cap FROM exam_periods WHERE id=1'), 4);
    db.close();
});

test('removing a split placement cannot redistribute students beyond another slot limit', () => {
    const db = fixture();
    subject(db, 'A', 4, 'major', ['P', 'Q']);
    db.run("INSERT INTO settings VALUES ('allow_multi_exam_subject', 'true')");
    assign(db, 'A', 2, { assignMode: 'add', target_program: 'Q' });
    assign(db, 'A', 1, { assignMode: 'add', target_program: 'P' });
    const id = scalar(db, 'SELECT id FROM schedule WHERE exam_period_id=2');
    const removed = call(schedule, '/unassign-entry/:id', 'delete', db, {}, { id: String(id) });
    assert.equal(removed.statusCode, 409);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM schedule'), 2);
    assert.equal(call(periods, '/:id', 'delete', db, {}, { id: '2' }).statusCode, 409);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM exam_periods'), 2);
    db.close();
});

function fallbackRouter() {
    const filename = path.join(__dirname, '../routes/schedule.js');
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, __dirname: path.dirname(filename), process,
        require: name => name === 'child_process' ? { spawnSync: () => ({ error: new Error('Forced fallback for test') }) } : localRequire(name)
    });
    return module.exports;
}

function verifyAuto(router, expectedSolver) {
    const db = fixture();
    db.run('UPDATE exam_periods SET major_cap=4, minor_cap=0, subject_cap=3 WHERE id=2');
    subject(db, 'A', 2);
    subject(db, 'B', 2);
    subject(db, 'M', 2, 'minor');
    subject(db, 'BIG', 3);
    subject(db, 'TOO_BIG', 11);
    const res = call(router, '/auto-schedule', 'post', db);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.solver, expectedSolver);
    assert.equal(res.body.placed, 4);
    assert.equal(res.body.failed.length, 1);
    assert.equal(res.body.failed[0].subject_code, 'TOO_BIG');
    assert.equal(scalar(db, "SELECT exam_period_id FROM schedule WHERE subject_code='BIG'"), 2);
    assert.equal(scalar(db, "SELECT exam_period_id FROM schedule WHERE subject_code='M'"), 1);
    db.close();
}

test('fallback scheduling enforces automatic pools and per-subject limits', () => verifyAuto(fallbackRouter(), 'heuristic'));

const python = process.env.PYTHON_PATH || process.env.PYTHON || 'python';
const hasOrTools = spawnSync(python, ['-c', 'from ortools.sat.python import cp_model'], { timeout: 10000 }).status === 0;
test('OR-Tools scheduling enforces automatic pools and per-subject limits', { skip: !hasOrTools }, () => verifyAuto(schedule, 'or-tools'));

test('both automatic schedulers preserve manual overloads and only place new subjects within capacity', () => {
    for (const [router, solver] of [[fallbackRouter(), 'heuristic'], ...(hasOrTools ? [[schedule, 'or-tools']] : [])]) {
        const db = fixture();
        for (const code of ['A', 'B', 'C', 'D']) {
            subject(db, code, 2);
            assert.equal(assign(db, code).statusCode, 200);
        }
        subject(db, 'NEXT', 2);
        subject(db, 'TOO_BIG', 11);
        const response = call(router, '/auto-schedule', 'post', db);
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.solver, solver);
        assert.equal(response.body.placed, 1);
        assert.equal(scalar(db, "SELECT exam_period_id FROM schedule WHERE subject_code='NEXT'"), 2);
        assert.equal(scalar(db, 'SELECT COUNT(*) FROM schedule WHERE exam_period_id=1'), 4);
        assert.equal(scalar(db, "SELECT status FROM subjects WHERE subject_code='TOO_BIG'"), 'unscheduled');
        assert.ok(buildAllocatedScheduleEntries(db).filter(row => row.exam_period_id === 2).every(row => row.capacity_valid));
        db.close();
    }
});

test('auto-scheduling charges existing capacity and can place mixed groups under individual subject limits', () => {
    for (const router of [fallbackRouter(), ...(hasOrTools ? [schedule] : [])]) {
        const db = fixture();
        subject(db, 'EXISTING', 2);
        subject(db, 'A', 2);
        subject(db, 'M', 2, 'minor');
        assign(db, 'EXISTING');
        db.run("INSERT INTO same_period_groups (id, group_name) VALUES (1, 'Mixed')");
        for (const code of ['A', 'M']) db.run('INSERT INTO same_period_group_subjects VALUES (1, ?)', [code]);
        call(periods, '/set-caps', 'put', db, { period_ids: [2], major_cap: 0, minor_cap: 0 });
        const res = call(router, '/auto-schedule', 'post', db);
        assert.equal(res.body.placed, 2);
        assert.equal(res.body.failed.length, 0);
        assert.equal(scalar(db, 'SELECT COUNT(*) FROM schedule WHERE exam_period_id=1'), 3);
        assert.equal(scalar(db, 'SELECT COUNT(*) FROM schedule WHERE exam_period_id=2'), 0);
        db.close();
    }
});

test('pool allocator finds whole-subject placements rather than combining pool space', () => {
    const period = { major_cap: 100, minor_cap: 50 };
    assert.equal(allocatePools(period, { oversized: 120 }).ok, false);
    assert.equal(allocatePools(period, { A: 60, B: 60 }).ok, false);
    assert.deepEqual(allocatePools(period, { A: 100, B: 50 }).usage, { major: 100, minor: 50 });
    assert.deepEqual(allocatePools(period, { A: 40, B: 30 }).usage, { major: 70, minor: 0 });
    assert.equal(allocatePools(period, { A: 100, B: 51 }).ok, false);
    // Largest-first greedy packing would fill Major to 9 and leave 11 for Minor.
    const repacked = allocatePools({ major_cap: 10, minor_cap: 10 }, { A: 6, B: 5, C: 3, D: 2, E: 2, F: 2 });
    assert.equal(repacked.ok, true);
    assert.deepEqual(repacked.usage, { major: 10, minor: 10 });
});

test('pool allocator agrees with exhaustive whole-subject packing and prefers Major', () => {
    let seed = 19;
    const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
    for (let attempt = 0; attempt < 100; attempt++) {
        const counts = Array.from({ length: 1 + random(8) }, () => random(10));
        const major = random(25), minor = random(25);
        const subjects = Object.fromEntries(counts.map((count, i) => [`S${i}`, count]));
        const total = counts.reduce((sum, count) => sum + count, 0);
        let best = -1;
        for (let mask = 0; mask < 2 ** counts.length; mask++) {
            const used = counts.reduce((sum, count, i) => sum + ((mask & (1 << i)) ? count : 0), 0);
            if (used <= major && total - used <= minor) best = Math.max(best, used);
        }
        const result = allocatePools({ major_cap: major, minor_cap: minor }, subjects);
        assert.equal(result.ok, best >= 0);
        if (result.ok) {
            assert.equal(result.usage.major, best);
            for (const pool of ['major', 'minor']) {
                assert.equal(Object.entries(subjects).filter(([code]) => result.pools[code] === pool).reduce((sum, [, count]) => sum + count, 0), result.usage[pool]);
            }
        }
    }
});

test('manual assignment uses Minor when possible and allows subjects that exceed whole-pool capacity', () => {
    const db = fixture();
    db.run('UPDATE exam_periods SET major_cap=100, minor_cap=50, subject_cap=NULL WHERE id=1');
    subject(db, 'A', 100);
    subject(db, 'B', 50); // Both subjects retain the legacy default Major type.
    subject(db, 'C', 1);
    subject(db, 'BIG', 120);
    assert.equal(assign(db, 'A').statusCode, 200);
    assert.equal(assign(db, 'B').statusCode, 200);
    const rows = buildAllocatedScheduleEntries(db);
    assert.equal(rows.find(row => row.subject_code === 'A').capacity_pool, 'major');
    assert.equal(rows.find(row => row.subject_code === 'B').capacity_pool, 'minor');
    assert.equal(assign(db, 'C').statusCode, 200);
    assert.equal(assign(db, 'BIG').statusCode, 200);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM schedule'), 4);
    assert.ok(buildAllocatedScheduleEntries(db).every(row => row.capacity_valid === false));
    db.close();
});

test('both schedulers use Minor automatically and never split one subject across pools', () => {
    for (const [router, solver] of [[fallbackRouter(), 'heuristic'], ...(hasOrTools ? [[schedule, 'or-tools']] : [])]) {
        const db = fixture();
        db.run('UPDATE exam_periods SET major_cap=100, minor_cap=50, subject_cap=NULL WHERE id=1');
        db.run('UPDATE exam_periods SET major_cap=0, minor_cap=0 WHERE id=2');
        subject(db, 'A', 100);
        subject(db, 'B', 50);
        subject(db, 'BIG', 120);
        const result = call(router, '/auto-schedule', 'post', db);
        assert.equal(result.statusCode, 200);
        assert.equal(result.body.solver, solver);
        assert.equal(result.body.placed, 2);
        assert.equal(result.body.failed.length, 1);
        assert.equal(result.body.failed[0].subject_code, 'BIG');
        const rows = buildAllocatedScheduleEntries(db);
        assert.equal(rows.find(row => row.subject_code === 'B').capacity_pool, 'minor');
        assert.ok(rows.every(row => row.capacity_valid));
        db.close();
    }
});

test('scheduler can repack existing subjects between pools without moving their periods', () => {
    for (const router of [fallbackRouter(), ...(hasOrTools ? [schedule] : [])]) {
        const db = fixture();
        db.run('UPDATE exam_periods SET major_cap=10, minor_cap=10, subject_cap=NULL WHERE id=1');
        db.run('UPDATE exam_periods SET major_cap=0, minor_cap=0 WHERE id=2');
        for (const [code, count] of [['A', 6], ['B', 5], ['C', 3], ['D', 2], ['E', 2], ['F', 2]]) subject(db, code, count);
        assert.equal(assign(db, 'A').statusCode, 200);
        assert.equal(assign(db, 'B').statusCode, 200);
        const result = call(router, '/auto-schedule', 'post', db);
        assert.equal(result.body.placed, 4);
        assert.equal(result.body.failed.length, 0);
        const rows = buildAllocatedScheduleEntries(db);
        assert.ok(rows.every(row => row.exam_period_id === 1 && row.capacity_valid));
        assert.equal(rows.filter(row => row.capacity_pool === 'major').reduce((sum, row) => sum + row.student_count, 0), 10);
        assert.equal(rows.filter(row => row.capacity_pool === 'minor').reduce((sum, row) => sum + row.student_count, 0), 10);
        db.close();
    }
});
