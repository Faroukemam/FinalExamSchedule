const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const XLSX = require('xlsx');
const initSqlJs = require('sql.js');
const periods = require('../routes/periods');
const schedule = require('../routes/schedule');
const { normalizeSlotDate, normalizeSlotTime } = require('../utils/slotImport');

let SQL, readSlotWorkbook, slotImportFeedback;
before(async () => {
    SQL = await initSqlJs();
    ({ readSlotWorkbook, slotImportFeedback } = await import('../../client/src/utils/slotImport.js'));
});

function fixture() {
    const db = new SQL.Database();
    const source = fs.readFileSync(path.join(__dirname, '../db/db.js'), 'utf8');
    vm.runInNewContext(source.slice(source.indexOf('    // Create tables'), source.indexOf('    // Default settings')), { db, console });
    db.run('PRAGMA foreign_keys=ON');
    db.saveToFile = () => {};
    db.run("INSERT INTO exam_periods(id,exam_date,start_time,end_time,major_cap,minor_cap,subject_cap) VALUES(1,'2026-12-25','09:30','11:30',100,50,30),(2,'2027-01-09','09:30','11:30',170,50,100)");
    return db;
}

function call(router, route, method, db, body, params = {}) {
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
    router.stack.find(layer => layer.route?.path === route && layer.route.methods[method]).route.stack[0].handle({ app: { locals: { db } }, body, params, path: route }, res);
    return res;
}
const row = extra => ({ exam_date: '2026-12-25', start_time: '09:30', end_time: '11:30', ...extra });
const run = (db, data, date1904 = false) => call(periods, '/import', 'post', db, { data, date1904 });
const values = db => db.exec('SELECT id,exam_date,start_time,end_time,major_cap,minor_cap,subject_cap FROM exam_periods ORDER BY id')[0].values;

function workbook(rows, date1904 = false, csv = false) {
    const wb = XLSX.utils.book_new();
    wb.Workbook = { WBProps: { date1904 } };
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Slots');
    return XLSX.write(wb, { type: 'buffer', bookType: csv ? 'csv' : 'xlsx' });
}

function overloaded(db) {
    db.run("INSERT INTO subjects(subject_code,status,student_count) VALUES('OVER','scheduled',201)");
    for (let i = 0; i < 201; i++) {
        db.run('INSERT INTO students(student_id,student_name) VALUES (?, ?)', [`s${i}`, `Student ${i}`]);
        db.run("INSERT INTO registrations(student_id,subject_code) VALUES (?, 'OVER')", [`s${i}`]);
    }
    db.run("INSERT INTO schedule(exam_period_id,subject_code) VALUES(2,'OVER')");
}

test('native Excel serial dates and times update the intended existing slot', () => {
    const db = fixture();
    const parsed = readSlotWorkbook(workbook([
        ['exam_date', 'start_time', 'end_time', 'major_cap'],
        [46381, 9.5 / 24, 11.5 / 24, 220]
    ]));
    assert.equal(typeof parsed.data[0].exam_date, 'number');
    const result = run(db, parsed.data, parsed.date1904);
    assert.equal(result.body.updated, 1);
    assert.equal(result.body.imported, 0);
    assert.deepEqual(values(db)[0], [1, '2026-12-25', '09:30', '11:30', 220, 50, 30]);
    assert.equal(values(db).length, 2);
    db.close();
});

test('1904 Excel dates, midnight, AM/PM and canonical time variants normalize correctly', () => {
    assert.equal(normalizeSlotDate(46381 - 1462, true), '2026-12-25');
    assert.equal(normalizeSlotTime(0), '00:00');
    assert.equal(normalizeSlotTime('12:00 AM'), '00:00');
    assert.equal(normalizeSlotTime('12:00 PM'), '12:00');
    assert.equal(normalizeSlotTime('9:30 pm'), '21:30');
    const db = fixture();
    const parsed = readSlotWorkbook(workbook([
        ['exam_date', 'start_time', 'end_time', 'major_cap'],
        [46381 - 1462, '9:30 AM', '11:30:00', 220]
    ], true));
    assert.equal(parsed.date1904, true);
    assert.equal(run(db, parsed.data, parsed.date1904).body.updated, 1);
    assert.equal(values(db).length, 2);
    db.close();
});

test('blank cells clear only included capacity columns; omitted columns preserve limits', () => {
    const db = fixture();
    const parsed = readSlotWorkbook(workbook([
        ['exam_date', 'start_time', 'end_time', 'Minor Cap'],
        ['2026-12-25', '09:30', '11:30', null]
    ]));
    assert.equal(parsed.data[0]['Minor Cap'], null);
    assert.equal(run(db, parsed.data).body.updated, 1);
    assert.deepEqual(values(db)[0].slice(4), [100, null, 30]);
    assert.equal(run(db, [row({ major_cap: 0, subject_cap: '' })]).body.updated, 1);
    assert.deepEqual(values(db)[0].slice(4), [0, null, null]);
    db.close();
});

test('CSV parsing preserves blank limits and accepts readable capacity headers', () => {
    const db = fixture();
    const parsed = readSlotWorkbook(workbook([
        ['Exam Date', 'Start Time', 'End Time', 'Major Cap', 'Minor Cap', 'Max students per subject'],
        ['2026-12-25', '9:30 AM', '11:30 AM', 220, '', 110]
    ], false, true));
    assert.equal(run(db, parsed.data).body.updated, 1);
    assert.deepEqual(values(db)[0].slice(4), [220, null, 110]);
    db.close();
});

test('unknown and duplicate headers reject the row instead of creating unlimited slots', () => {
    const db = fixture();
    const initial = values(db);
    for (const data of [[row({ 'Majro Cap': 200 })], [row({ major_cap: 200, 'Major Cap': 300 })]]) {
        const result = run(db, data);
        assert.equal(result.statusCode, 422);
        assert.equal(result.body.success, false);
        assert.equal(result.body.failed, 1);
        assert.deepEqual(values(db), initial);
    }
    db.close();
});

test('invalid calendars, ambiguous dates, invalid clock times and zero-length slots are rejected', () => {
    const db = fixture();
    const initial = values(db);
    const invalid = [
        row({ exam_date: '2026-02-30' }), row({ exam_date: 'garbage' }),
        row({ exam_date: '12/25/2026' }), row({ exam_date: 60 }),
        row({ start_time: '25:99' }), row({ start_time: 1 }),
        row({ start_time: '13:00 PM' }), row({ start_time: '09:30:30' }),
        row({ start_time: '11:30' }), row({ end_time: null })
    ];
    const result = run(db, invalid);
    assert.equal(result.statusCode, 422);
    assert.equal(result.body.failed, invalid.length);
    assert.equal(result.body.row_errors[0].row, 2);
    assert.deepEqual(values(db), initial);
    assert.equal(normalizeSlotDate('2028-02-29'), '2028-02-29');
    assert.equal(normalizeSlotDate('2026/25/12'), '2026-12-25');
    db.close();
});

test('canonical matching normalizes a legacy time in place and rejects pre-existing duplicate slots', () => {
    const db = fixture();
    db.run("UPDATE exam_periods SET start_time='9:30',end_time='11:30:00' WHERE id=1");
    assert.equal(run(db, [row({ major_cap: 200 })]).body.updated, 1);
    assert.deepEqual(values(db)[0].slice(0, 4), [1, '2026-12-25', '09:30', '11:30']);
    db.run("INSERT INTO exam_periods(exam_date,start_time,end_time) VALUES('2026-12-25','9:30','11:30')");
    const result = run(db, [row({ major_cap: 300 })]);
    assert.equal(result.statusCode, 422);
    assert.match(result.body.errors[0], /Multiple existing slots/);
    assert.equal(values(db)[0][4], 200);
    db.close();
});

test('overload in another slot cannot block imports, direct edits or selected-slot updates', () => {
    const db = fixture();
    overloaded(db);
    assert.equal(run(db, [row({ major_cap: 1120 })]).body.updated, 1);
    assert.equal(call(periods, '/:id', 'put', db, row({ major_cap: 1100 }), { id: '1' }).statusCode, 200);
    assert.equal(call(periods, '/set-caps', 'put', db, { period_ids: [1], subject_cap: 90 }).statusCode, 200);
    assert.deepEqual(values(db)[0].slice(4), [1100, 50, 90]);
    // The overloaded slot itself must still meet its new limits before saving.
    const rejected = run(db, [row({ exam_date: '2027-01-09', major_cap: 200, subject_cap: 300 })]);
    assert.equal(rejected.statusCode, 422);
    assert.match(rejected.body.errors[0], /whole subjects must fit within one pool/);
    assert.deepEqual(values(db)[1].slice(4), [170, 50, 100]);
    db.close();
});

test('redistribution affecting a second slot is still checked and rolled back', () => {
    const db = fixture();
    db.run("INSERT INTO subjects(subject_code,status,student_count) VALUES('A','scheduled',4)");
    for (let i = 0; i < 4; i++) {
        db.run('INSERT INTO students(student_id,student_name,program) VALUES(?, ?, ?)', [`s${i}`, 'Test', i < 2 ? 'P' : 'Q']);
        db.run("INSERT INTO registrations(student_id,subject_code) VALUES(?,'A')", [`s${i}`]);
    }
    db.run("INSERT INTO schedule(exam_period_id,subject_code,target_program) VALUES(1,'A','P'),(2,'A','Q')");
    db.run('UPDATE exam_periods SET subject_cap=2 WHERE id=2');
    const id = db.exec('SELECT id FROM schedule WHERE exam_period_id=1')[0].values[0][0];
    assert.equal(call(schedule, '/unassign-entry/:id', 'delete', db, {}, { id: String(id) }).statusCode, 409);
    assert.equal(db.exec('SELECT COUNT(*) FROM schedule')[0].values[0][0], 2);
    db.close();
});

test('partial imports return exact counts, row locations and warning feedback; full failure is an error', () => {
    const db = fixture();
    const result = run(db, [row({ major_cap: 200, _row_number: 5 }), row({ major_cap: 300, _row_number: 7 }), row({ exam_date: 'bad', _row_number: 9 })]);
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.partial, true);
    assert.equal(result.body.updated, 1);
    assert.equal(result.body.failed, 2);
    assert.deepEqual(result.body.row_errors.map(e => e.row), [7, 9]);
    assert.match(result.body.row_errors[0].reason, /Duplicate slot/);
    assert.equal(slotImportFeedback(result.body).type, 'warning');
    const rejected = run(db, [row({ major_cap: -1 })]);
    assert.equal(rejected.statusCode, 422);
    assert.equal(slotImportFeedback(rejected.body).type, 'error');
    assert.equal(slotImportFeedback(run(db, [row({ major_cap: 250 })]).body).type, 'success');
    for (const data of [undefined, {}, [], 'bad']) assert.equal(run(db, data).statusCode, 400);
    db.close();
});

test('exported slot headers round-trip, including blank and zero limits', () => {
    const db = fixture();
    const parsed = readSlotWorkbook(workbook([
        ['Exam_Date', 'Start_Time', 'End_Time', 'Duration', 'Major_Cap', 'Minor_Cap', 'Subject_Cap', 'Major_Students', 'Minor_Students', 'Assigned_Subjects'],
        ['25/12/2026', '09:30', '11:30', '2 hrs', 300, 0, null, 0, 0, 0]
    ]));
    assert.equal(run(db, parsed.data).body.updated, 1);
    assert.deepEqual(values(db)[0].slice(4), [300, 0, null]);
    db.close();
});

test('standard day-first dates update existing saved slots and work in create, edit, bulk and schedule imports', () => {
    const db = fixture();
    const imported = run(db, [row({ exam_date: '25/12/2026', major_cap: 220 })]);
    assert.equal(imported.body.updated, 1);
    assert.equal(imported.body.imported, 0);
    assert.equal(values(db).length, 2);
    assert.equal(values(db)[0][1], '2026-12-25');
    assert.equal(call(periods, '/', 'post', db, row({ exam_date: '30/12/2026' })).statusCode, 200);
    assert.equal(call(periods, '/:id', 'put', db, row({ exam_date: '26/12/2026' }), { id: 1 }).statusCode, 200);
    assert.equal(values(db)[0][1], '2026-12-26');
    assert.equal(call(periods, '/bulk', 'post', db, { dates: ['31/12/2026', '01/01/2027'], periods: [{ start_time: '12:00', end_time: '14:00' }] }).statusCode, 200);
    const before = values(db);
    assert.equal(call(periods, '/', 'post', db, row({ exam_date: '31/02/2026' })).statusCode, 400);
    assert.equal(call(periods, '/bulk', 'post', db, { dates: ['02/01/2027', '31/02/2027'], periods: [{ start_time: '12:00', end_time: '14:00' }] }).statusCode, 400);
    assert.deepEqual(values(db), before);
    const assigned = call(schedule, '/import', 'post', db, { data: [{ subject_code: 'DATE_TEST', exam_date: '26/12/2026', start_time: '09:30', end_time: '11:30' }] });
    assert.equal(assigned.statusCode, 200);
    assert.equal(db.exec("SELECT exam_period_id FROM schedule WHERE subject_code='DATE_TEST'")[0].values[0][0], 1);
    db.close();
});

test('real HTTP route casing and trailing slashes preserve selected-slot scope', async () => {
    const db = fixture();
    const app = express();
    app.use(express.json());
    app.locals.db = db;
    app.use('/api/periods', periods);
    const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    try {
        for (const route of ['/set-caps/', '/SET-CAPS']) {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/api/periods${route}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ period_ids: [1], subject_cap: 7 }) });
            assert.equal(res.status, 200);
            await res.json();
            assert.equal(values(db)[0][6], 7);
            assert.equal(values(db)[1][6], 100);
        }
    } finally {
        await new Promise(resolve => server.close(resolve));
        db.close();
    }
});
