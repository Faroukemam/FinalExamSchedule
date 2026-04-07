const express = require('express');
const router = express.Router();
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const { buildAllocatedScheduleEntries } = require('../utils/scheduleAllocation');

function resultToObjects(result) {
    if (!result || result.length === 0) return [];
    const columns = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        columns.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

function sanitizeSheetName(name) {
    const cleaned = String(name || 'Sheet')
        .replace(/[\[\]\:\*\?\/\\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return (cleaned || 'Sheet').slice(0, 31);
}

function uniqueSheetName(base, used) {
    let name = sanitizeSheetName(base);
    if (!used.has(name)) {
        used.add(name);
        return name;
    }
    let i = 2;
    while (true) {
        const suffix = ` (${i})`;
        const trimmed = name.slice(0, Math.max(1, 31 - suffix.length));
        const candidate = `${trimmed}${suffix}`;
        if (!used.has(candidate)) {
            used.add(candidate);
            return candidate;
        }
        i++;
    }
}

function writeWorkbookToTempFile(wb, filename) {
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

    const tempFilename = `${Date.now()}_${String(filename || 'export.xlsx').replace(/[^a-zA-Z0-9_.-]/g, '')}`;
    const filePath = path.join(uploadsDir, tempFilename);
    fs.writeFileSync(filePath, buffer);

    setTimeout(() => {
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { }
    }, 5 * 60 * 1000);

    return `/uploads/${tempFilename}`;
}

function writeTextToTempFile(content, filename) {
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

    const tempFilename = `${Date.now()}_${String(filename || 'export.doc').replace(/[^a-zA-Z0-9_.-]/g, '')}`;
    const filePath = path.join(uploadsDir, tempFilename);
    fs.writeFileSync(filePath, String(content || ''), 'utf8');

    setTimeout(() => {
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) { }
    }, 5 * 60 * 1000);

    return `/uploads/${tempFilename}`;
}

// GET export schedule data as JSON (client will convert to Excel/PDF)
router.get('/schedule', (req, res) => {
    const db = req.app.locals.db;
    try {
        res.json(buildAllocatedScheduleEntries(db).map(row => ({
            subject_code: row.subject_code,
            subject_name: row.subject_name,
            department: row.department,
            student_count: row.student_count,
            exam_date: row.exam_date,
            start_time: row.start_time,
            end_time: row.end_time,
            target_program: row.target_program || '',
            registered_programs: row.registered_programs || '',
            program_counts: row.program_counts || ''
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET export remaining subjects
router.get('/remaining', (req, res) => {
    const db = req.app.locals.db;
    try {
        const result = db.exec(`SELECT * FROM subjects WHERE status = 'unscheduled' ORDER BY subject_code`);
        res.json(resultToObjects(result));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET export no-final-exam subjects
router.get('/no-final', (req, res) => {
    const db = req.app.locals.db;
    try {
        const result = db.exec(`SELECT * FROM subjects WHERE status = 'no_final_exam' ORDER BY subject_code`);
        res.json(resultToObjects(result));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST generic export to excel with specific filename
router.post('/export-excel', (req, res) => {
    try {
        const { filename = 'export.xlsx', sheetName, data_json, sheets_json } = req.body;
        const wb = xlsx.utils.book_new();
        const usedSheetNames = new Set();

        if (sheets_json) {
            const sheets = JSON.parse(sheets_json);
            if (!Array.isArray(sheets) || sheets.length === 0) {
                return res.status(400).json({ error: 'Missing sheets data' });
            }
            for (const sheet of sheets) {
                const rows = Array.isArray(sheet?.data) ? sheet.data : [];
                const ws = xlsx.utils.json_to_sheet(rows);
                const name = uniqueSheetName(sheet?.sheetName || 'Sheet', usedSheetNames);
                xlsx.utils.book_append_sheet(wb, ws, name);
            }
        } else {
            if (!data_json) return res.status(400).json({ error: 'Missing data' });
            const data = JSON.parse(data_json);
            const ws = xlsx.utils.json_to_sheet(data);
            const name = uniqueSheetName(sheetName || 'export', usedSheetNames);
            xlsx.utils.book_append_sheet(wb, ws, name);
        }

        const url = writeWorkbookToTempFile(wb, filename);
        res.json({ url });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate Excel file: ' + err.message });
    }
});

router.post('/export-word', (req, res) => {
    try {
        const { filename = 'export.doc', html = '' } = req.body || {};
        if (!String(html || '').trim()) {
            return res.status(400).json({ error: 'Missing html' });
        }
        const url = writeTextToTempFile(html, filename);
        res.json({ url });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate Word file: ' + err.message });
    }
});

module.exports = router;
