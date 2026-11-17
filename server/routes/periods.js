const express = require('express');
const { normalizeExamDate } = require('../utils/date');
const { normalizeCap, withCapacityTransaction } = require('../utils/capacity');
const { readImportRow, normalizeSlot, slotKey } = require('../utils/slotImport');
const router = express.Router();

function resultToObjects(result) {
    if (!result || result.length === 0) return [];
    const columns = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        columns.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

function readCaps(body, existing = {}) {
    return {
        major: normalizeCap(body.major_cap !== undefined ? body.major_cap : body.student_cap !== undefined ? body.student_cap : existing.major_cap),
        minor: normalizeCap(body.minor_cap !== undefined ? body.minor_cap : existing.minor_cap),
        subject: normalizeCap(body.subject_cap !== undefined ? body.subject_cap : existing.subject_cap)
    };
}

// GET all exam periods
router.get('/', (req, res) => {
    const db = req.app.locals.db;
    try {
        const result = db.exec(`SELECT * FROM exam_periods ORDER BY exam_date, start_time`);
        res.json(resultToObjects(result));
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST create period
router.post('/', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { exam_date, start_time, end_time } = req.body;
        const normalizedDate = normalizeExamDate(exam_date);
        if (!normalizedDate || !start_time || !end_time) {
            return res.status(400).json({ error: 'Date, start_time, and end_time are required' });
        }
        const caps = readCaps(req.body);
        db.run(`INSERT OR IGNORE INTO exam_periods (exam_date, start_time, end_time, student_cap, major_cap, minor_cap, subject_cap) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [normalizedDate, start_time, end_time, caps.major, caps.major, caps.minor, caps.subject]);
        db.saveToFile();
        res.json({ success: true });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

function setCaps(selected) { return (req, res) => {
    const db = req.app.locals.db;
    try {
        const body = req.body || {};
        const changeMajor = body.major_cap !== undefined || body.student_cap !== undefined;
        const changeMinor = body.minor_cap !== undefined;
        const changeSubject = body.subject_cap !== undefined;
        const ids = Array.isArray(body.period_ids) ? [...new Set(body.period_ids.map(Number))] : [];
        if (selected && (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0))) {
            return res.status(400).json({ error: 'Select at least one valid slot' });
        }
        if (selected) {
            const found = resultToObjects(db.exec(`SELECT id FROM exam_periods WHERE id IN (${ids.map(() => '?').join(',')})`, ids));
            if (found.length !== ids.length) return res.status(404).json({ error: 'One or more selected slots no longer exist' });
        }
        const where = selected ? ` WHERE id IN (${ids.map(() => '?').join(',')})` : '';
        const params = selected ? ids : [];
        if (!changeMajor && !changeMinor && !changeSubject) return res.status(400).json({ error: 'Provide major_cap, minor_cap and/or subject_cap' });
        const caps = readCaps(body);
        withCapacityTransaction(db, () => {
            if (changeMajor) db.run('UPDATE exam_periods SET student_cap = ?, major_cap = ?' + where, [caps.major, caps.major, ...params]);
            if (changeMinor) db.run('UPDATE exam_periods SET minor_cap = ?' + where, [caps.minor, ...params]);
            if (changeSubject) db.run('UPDATE exam_periods SET subject_cap = ?' + where, [caps.subject, ...params]);
        }, selected ? ids : resultToObjects(db.exec('SELECT id FROM exam_periods')).map(row => row.id));
        db.saveToFile();
        res.json({ success: true });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
}; }
router.put('/set-cap-all', setCaps(false));
router.put('/set-caps', setCaps(true));

// PUT update an existing period
router.put('/:id', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { exam_date, start_time, end_time } = req.body;
        const normalizedDate = normalizeExamDate(exam_date);
        const id = req.params.id;
        if (!normalizedDate || !start_time || !end_time) {
            return res.status(400).json({ error: 'Date, start_time, and end_time are required' });
        }
        // Check for duplicate (another period with same date/times)
        const conflict = db.exec(
            `SELECT id FROM exam_periods WHERE exam_date=? AND start_time=? AND end_time=? AND id != ?`,
            [normalizedDate, start_time, end_time, id]
        );
        if (conflict.length && conflict[0].values.length) {
            return res.status(409).json({ error: 'A period with those date and times already exists' });
        }
        const existing = resultToObjects(db.exec('SELECT * FROM exam_periods WHERE id = ?', [id]))[0];
        if (!existing) return res.status(404).json({ error: 'Exam period not found' });
        const caps = readCaps(req.body, existing);
        withCapacityTransaction(db, () => db.run(`UPDATE exam_periods SET exam_date=?, start_time=?, end_time=?, student_cap=?, major_cap=?, minor_cap=?, subject_cap=? WHERE id=?`,
            [normalizedDate, start_time, end_time, caps.major, caps.major, caps.minor, caps.subject, id]), [Number(id)]);
        db.saveToFile();
        res.json({ success: true });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST bulk create periods
router.post('/bulk', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { dates, periods } = req.body;
        // dates: array of date strings
        // periods: array of { start_time, end_time }
        let created = 0;
        const caps = readCaps(req.body);
        withCapacityTransaction(db, () => {
            for (const date of dates) {
                const normalizedDate = normalizeExamDate(date);
                for (const p of periods) {
                    const rowCaps = readCaps(p, { major_cap: caps.major, minor_cap: caps.minor, subject_cap: caps.subject });
                    db.run(`INSERT OR IGNORE INTO exam_periods (exam_date, start_time, end_time, student_cap, major_cap, minor_cap, subject_cap) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                        [normalizedDate, p.start_time, p.end_time, rowCaps.major, rowCaps.major, rowCaps.minor, rowCaps.subject]);
                    created++;
                }
            }
        });
        db.saveToFile();
        res.json({ success: true, created });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

router.post('/import', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { data: rows, date1904 = false } = req.body || {};
        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(400).json({ error: 'Provide a non-empty data array of slot rows' });
        }
        if (typeof date1904 !== 'boolean') return res.status(400).json({ error: 'date1904 must be a boolean' });
        let imported = 0;
        let updated = 0;
        const rowErrors = [];
        const existingByKey = new Map();
        for (const period of resultToObjects(db.exec('SELECT * FROM exam_periods'))) {
            try {
                const key = slotKey(normalizeSlot(period));
                const matches = existingByKey.get(key) || [];
                matches.push(period);
                existingByKey.set(key, matches);
            } catch {
                // Invalid historical rows are not used as matching candidates.
            }
        }
        const seen = new Set();
        for (const [index, row] of rows.entries()) {
            const rowNumber = Number.isSafeInteger(row?._row_number) && row._row_number >= 2 ? row._row_number : index + 2;
            try {
                const slot = normalizeSlot(readImportRow(row), date1904);
                const key = slotKey(slot);
                if (seen.has(key)) throw new Error('Duplicate slot in this file');
                seen.add(key);
                const matches = existingByKey.get(key) || [];
                if (matches.length > 1) throw new Error('Multiple existing slots represent these date/times; consolidate them before importing');
                const existing = matches[0];
                const caps = readCaps(slot, existing);
                const id = withCapacityTransaction(db, () => {
                    if (existing) {
                        db.run('UPDATE exam_periods SET exam_date=?, start_time=?, end_time=?, student_cap=?, major_cap=?, minor_cap=?, subject_cap=? WHERE id=?',
                            [slot.exam_date, slot.start_time, slot.end_time, caps.major, caps.major, caps.minor, caps.subject, existing.id]);
                        return existing.id;
                    }
                    db.run('INSERT INTO exam_periods (exam_date, start_time, end_time, student_cap, major_cap, minor_cap, subject_cap) VALUES (?, ?, ?, ?, ?, ?, ?)',
                        [slot.exam_date, slot.start_time, slot.end_time, caps.major, caps.major, caps.minor, caps.subject]);
                    return db.exec('SELECT last_insert_rowid()')[0].values[0][0];
                }, existing ? [existing.id] : []);
                existingByKey.set(key, [{ ...slot, id, major_cap: caps.major, minor_cap: caps.minor, subject_cap: caps.subject }]);
                if (existing) updated++; else imported++;
            } catch (error) {
                rowErrors.push({ row: rowNumber, reason: error.message });
            }
        }
        const success = imported + updated > 0;
        if (success) db.saveToFile();
        res.status(success ? 200 : 422).json({
            success,
            partial: success && rowErrors.length > 0,
            imported, updated, failed: rowErrors.length, total: rows.length,
            errors: rowErrors.slice(0, 100).map(item => `Row ${item.row}: ${item.reason}`),
            row_errors: rowErrors.slice(0, 100),
            ...(!success ? { error: 'No slot rows were imported or updated' } : {})
        });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// DELETE period
router.delete('/:id', (req, res) => {
    const db = req.app.locals.db;
    try {
        withCapacityTransaction(db, () => {
            // Unschedule subjects in this period
            const scheduled = db.exec(`SELECT subject_code FROM schedule WHERE exam_period_id = ?`, [req.params.id]);
            if (scheduled.length > 0) {
                for (const row of scheduled[0].values) {
                    db.run(`UPDATE subjects SET status='unscheduled' WHERE subject_code=?`, [row[0]]);
                }
            }
            db.run(`DELETE FROM schedule WHERE exam_period_id = ?`, [req.params.id]);
            db.run(`DELETE FROM exam_periods WHERE id = ?`, [req.params.id]);
        });
        db.saveToFile();
        res.json({ success: true });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// DELETE all periods
router.delete('/', (req, res) => {
    const db = req.app.locals.db;
    try {
        db.run(`UPDATE subjects SET status='unscheduled' WHERE status='scheduled'`);
        db.run(`DELETE FROM schedule`);
        db.run(`DELETE FROM exam_periods`);
        db.saveToFile();
        res.json({ success: true });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

module.exports = router;
