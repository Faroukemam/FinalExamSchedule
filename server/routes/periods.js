const express = require('express');
const { normalizeExamDate } = require('../utils/date');
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

function normalizeCap(value) {
    if (value === '' || value === null || value === undefined) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.round(parsed);
}

// GET all exam periods
router.get('/', (req, res) => {
    const db = req.app.locals.db;
    try {
        const result = db.exec(`SELECT * FROM exam_periods ORDER BY exam_date, start_time`);
        res.json(resultToObjects(result));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST create period
router.post('/', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { exam_date, start_time, end_time, student_cap } = req.body;
        const normalizedDate = normalizeExamDate(exam_date);
        if (!normalizedDate || !start_time || !end_time) {
            return res.status(400).json({ error: 'Date, start_time, and end_time are required' });
        }
        db.run(`INSERT OR IGNORE INTO exam_periods (exam_date, start_time, end_time, student_cap) VALUES (?, ?, ?, ?)`,
            [normalizedDate, start_time, end_time, normalizeCap(student_cap)]);
        db.saveToFile();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/set-cap-all', (req, res) => {
    const db = req.app.locals.db;
    try {
        const normalizedCap = normalizeCap(req.body?.student_cap);
        db.run(`UPDATE exam_periods SET student_cap = ?`, [normalizedCap]);
        db.saveToFile();
        res.json({ success: true, student_cap: normalizedCap });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT update an existing period
router.put('/:id', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { exam_date, start_time, end_time, student_cap } = req.body;
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
        db.run(`UPDATE exam_periods SET exam_date=?, start_time=?, end_time=?, student_cap=? WHERE id=?`,
            [normalizedDate, start_time, end_time, normalizeCap(student_cap), id]);
        db.saveToFile();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST bulk create periods
router.post('/bulk', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { dates, periods, student_cap } = req.body;
        // dates: array of date strings
        // periods: array of { start_time, end_time }
        let created = 0;
        const normalizedCap = normalizeCap(student_cap);
        for (const date of dates) {
            const normalizedDate = normalizeExamDate(date);
            for (const p of periods) {
                const rowCap = normalizeCap(p.student_cap);
                db.run(`INSERT OR IGNORE INTO exam_periods (exam_date, start_time, end_time, student_cap) VALUES (?, ?, ?, ?)`,
                    [normalizedDate, p.start_time, p.end_time, rowCap !== null ? rowCap : normalizedCap]);
                created++;
            }
        }
        db.saveToFile();
        res.json({ success: true, created });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/import', (req, res) => {
    const db = req.app.locals.db;
    try {
        const rows = Array.isArray(req.body?.data) ? req.body.data : [];
        let imported = 0;
        let updated = 0;
        const errors = [];

        for (const row of rows) {
            try {
                const examDate = normalizeExamDate(row.exam_date || row.Exam_Date || row.date || row.Date || '');
                const startTime = String(row.start_time || row.Start_Time || row.start || row.Start || '').trim();
                const endTime = String(row.end_time || row.End_Time || row.end || row.End || '').trim();
                const studentCap = normalizeCap(row.student_cap ?? row.Student_Cap ?? row.cap ?? row.Cap);

                if (!examDate || !startTime || !endTime) {
                    errors.push(`Missing fields in row: ${JSON.stringify(row).slice(0, 120)}`);
                    continue;
                }

                const existing = db.exec(
                    `SELECT id FROM exam_periods WHERE exam_date = ? AND start_time = ? AND end_time = ?`,
                    [examDate, startTime, endTime]
                );

                if (existing.length && existing[0].values.length) {
                    db.run(`UPDATE exam_periods SET student_cap = ? WHERE id = ?`, [studentCap, existing[0].values[0][0]]);
                    updated++;
                } else {
                    db.run(
                        `INSERT INTO exam_periods (exam_date, start_time, end_time, student_cap) VALUES (?, ?, ?, ?)`,
                        [examDate, startTime, endTime, studentCap]
                    );
                    imported++;
                }
            } catch (rowErr) {
                errors.push(rowErr.message);
            }
        }

        db.saveToFile();
        res.json({ success: true, imported, updated, errors: errors.slice(0, 20) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE period
router.delete('/:id', (req, res) => {
    const db = req.app.locals.db;
    try {
        // Unschedule subjects in this period
        const scheduled = db.exec(`SELECT subject_code FROM schedule WHERE exam_period_id = ?`, [req.params.id]);
        if (scheduled.length > 0) {
            for (const row of scheduled[0].values) {
                db.run(`UPDATE subjects SET status='unscheduled' WHERE subject_code=?`, [row[0]]);
            }
        }
        db.run(`DELETE FROM schedule WHERE exam_period_id = ?`, [req.params.id]);
        db.run(`DELETE FROM exam_periods WHERE id = ?`, [req.params.id]);
        db.saveToFile();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
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
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
