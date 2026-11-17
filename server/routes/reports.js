const express = require('express');
const router = express.Router();
const { createReportWorkbook, addReportSheet } = require('../utils/reportWorkbook');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
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
    if (!used.has(name.toLowerCase())) {
        used.add(name.toLowerCase());
        return name;
    }
    let i = 2;
    while (true) {
        const suffix = ` (${i})`;
        const trimmed = name.slice(0, Math.max(1, 31 - suffix.length));
        const candidate = `${trimmed}${suffix}`;
        if (!used.has(candidate.toLowerCase())) {
            used.add(candidate.toLowerCase());
            return candidate;
        }
        i++;
    }
}

function exportFilename(filename, extension) {
    const base = String(filename || 'export').replace(/[^a-zA-Z0-9_.-]/g, '').replace(/\.[^.]*$/, '') || 'export';
    return `${Date.now()}_${randomUUID()}_${base.slice(0, 120)}.${extension}`;
}

async function writeWorkbookToTempFile(wb, filename) {
    const buffer = await wb.xlsx.writeBuffer();
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

    const tempFilename = exportFilename(filename, 'xlsx');
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

    const tempFilename = exportFilename(filename, 'doc');
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
            program: row.program,
            exam_period_id: row.exam_period_id,
            room_placement_type: row.room_placement_type,
            assigned_student_id_range: row.assigned_student_id_range,
            student_count: row.student_count,
            capacity_pool: row.capacity_pool,
            capacity_valid: row.capacity_valid,
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
        const result = db.exec(`SELECT sub.* FROM subjects sub WHERE sub.status != 'no_final_exam'
            AND NOT EXISTS (SELECT 1 FROM schedule s WHERE s.subject_code = sub.subject_code) ORDER BY sub.subject_code`);
        res.json(resultToObjects(result).map(row => ({ ...row, status: 'unscheduled' })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET export no-final-exam subjects
router.get('/no-final', (req, res) => {
    const db = req.app.locals.db;
    try {
        const result = db.exec(`SELECT sub.* FROM subjects sub WHERE sub.status = 'no_final_exam'
            AND NOT EXISTS (SELECT 1 FROM schedule s WHERE s.subject_code = sub.subject_code) ORDER BY sub.subject_code`);
        res.json(resultToObjects(result));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST generic export to excel with specific filename
router.post('/export-excel', async (req, res) => {
    try {
        const { filename = 'export.xlsx', sheetName, title, data_json, sheets_json } = req.body || {};
        const wb = createReportWorkbook();
        const usedSheetNames = new Set();

        if (sheets_json) {
            const sheets = JSON.parse(sheets_json);
            if (!Array.isArray(sheets) || sheets.length === 0) {
                return res.status(400).json({ error: 'Missing sheets data' });
            }
            for (const sheet of sheets) {
                if (!sheet || !Array.isArray(sheet.data) || sheet.data.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
                    return res.status(400).json({ error: 'Each sheet must contain an array of row objects' });
                }
                const rows = sheet.data;
                const name = uniqueSheetName(sheet?.sheetName || 'Sheet', usedSheetNames);
                addReportSheet(wb, name, rows, { title: sheet.title, autoFilter: sheet.autoFilter, printHeaderFooter: sheet.printHeaderFooter });
            }
        } else {
            if (!data_json) return res.status(400).json({ error: 'Missing data' });
            const data = JSON.parse(data_json);
            if (!Array.isArray(data) || data.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
                return res.status(400).json({ error: 'Data must be an array of row objects' });
            }
            const name = uniqueSheetName(sheetName || 'export', usedSheetNames);
            addReportSheet(wb, name, data, { title });
        }

        const url = await writeWorkbookToTempFile(wb, filename);
        res.json({ url });
    } catch (err) {
        res.status(err instanceof SyntaxError ? 400 : 500).json({ error: 'Failed to generate Excel file: ' + err.message });
    }
});

router.post('/export-word', (req, res) => {
    try {
        const { filename = 'export.doc', html = '' } = req.body || {};
        if (typeof html !== 'string' || !html.trim()) {
            return res.status(400).json({ error: 'Missing html' });
        }
        const url = writeTextToTempFile(html, filename);
        res.json({ url });
    } catch (err) {
        res.status(500).json({ error: 'Failed to generate Word file: ' + err.message });
    }
});

module.exports = router;
