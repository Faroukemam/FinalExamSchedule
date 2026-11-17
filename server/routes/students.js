const express = require('express');
const router = express.Router();
const XLSX = require('xlsx');
const { withCapacityTransaction } = require('../utils/capacity');

// Helper: normalize courses string into unique subject codes
function normalizeCourses(coursesStr) {
    if (!coursesStr) return [];
    const codes = coursesStr
        .split(',')
        .map(c => c.trim())
        .filter(c => c.length > 0)
        .map(c => {
            const hyphenIdx = c.indexOf('-');
            return hyphenIdx > 0 ? c.substring(0, hyphenIdx).trim() : c.trim();
        })
        .filter(c => c.length > 0);
    return [...new Set(codes)]; // deduplicate
}

// GET all students
router.get('/', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { search, department, program, level } = req.query;
        let query = `SELECT s.*, GROUP_CONCAT(r.subject_code) as courses
                 FROM students s
                 LEFT JOIN registrations r ON s.student_id = r.student_id`;
        const conditions = [];
        const params = [];

        if (search) {
            conditions.push(`(s.student_id LIKE ? OR s.student_name LIKE ?)`);
            params.push(`%${search}%`, `%${search}%`);
        }
        if (department) { conditions.push(`s.department = ?`); params.push(department); }
        if (program) { conditions.push(`s.program = ?`); params.push(program); }
        if (level) { conditions.push(`s.level = ?`); params.push(level); }

        if (conditions.length) query += ` WHERE ` + conditions.join(' AND ');
        query += ` GROUP BY s.student_id ORDER BY s.student_id`;

        const result = db.exec(query, params);
        const students = resultToObjects(result);
        res.json(students);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET single student
router.get('/:id', (req, res) => {
    const db = req.app.locals.db;
    try {
        const result = db.exec(
            `SELECT s.*, GROUP_CONCAT(r.subject_code) as courses
       FROM students s LEFT JOIN registrations r ON s.student_id = r.student_id
       WHERE s.student_id = ? GROUP BY s.student_id`, [req.params.id]);
        const students = resultToObjects(result);
        if (students.length === 0) return res.status(404).json({ error: 'Student not found' });
        res.json(students[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST import students from JSON (parsed from Excel/CSV on client side)
router.post('/import', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { data } = req.body; // array of row objects
        if (!Array.isArray(data) || data.length === 0) {
            return res.status(400).json({ error: 'No data provided' });
        }

        let studentsImported = 0;
        let registrationsImported = 0;
        let errors = [];

        for (const row of data) {
            try {
                const studentId = String(row.student_id || row.Student_ID || row.StudentID || row.ID || '').trim();
                const studentName = String(row.student_name || row.Student_Name || row.StudentName || row.Name || '').trim();
                const department = String(row.department || row.Department || row.Dept || '').trim();
                const program = String(row.program || row.Program || '').trim();
                const level = String(row.level || row.Level || '').trim();
                const section = String(row.section || row.Section || '').trim();
                const coursesRaw = String(row.courses || row.Courses || row.COURSES || row.subjects || row.Subjects || '').trim();

                if (!studentId) {
                    errors.push(`Row missing student_id: ${JSON.stringify(row).substring(0, 100)}`);
                    continue;
                }

                const registered = withCapacityTransaction(db, () => {
                    // Upsert student
                    db.run(`INSERT OR REPLACE INTO students (student_id, student_name, department, program, level, section)
                    VALUES (?, ?, ?, ?, ?, ?)`, [studentId, studentName, department, program, level, section]);

                    // Normalize and insert registrations
                    const subjectCodes = normalizeCourses(coursesRaw);
                    for (const code of subjectCodes) {
                        // Ensure subject exists
                        db.run(`INSERT OR IGNORE INTO subjects (subject_code) VALUES (?)`, [code]);
                        // Insert registration
                        db.run(`INSERT OR IGNORE INTO registrations (student_id, subject_code) VALUES (?, ?)`, [studentId, code]);
                    }
                    return subjectCodes.length;
                });
                studentsImported++;
                registrationsImported += registered;
            } catch (rowErr) {
                errors.push(rowErr.message);
            }
        }

        // Update student counts for all subjects
        updateStudentCounts(db);

        db.saveToFile();

        res.json({
            success: true,
            studentsImported,
            registrationsImported,
            errors: errors.slice(0, 20),
            totalErrors: errors.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE all students
router.delete('/all', (req, res) => {
    const db = req.app.locals.db;
    try {
        db.run('DELETE FROM registrations');
        db.run('DELETE FROM students');
        updateStudentCounts(db);
        db.saveToFile();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Helper: update student counts for all subjects
function updateStudentCounts(db) {
    db.run(`UPDATE subjects SET student_count = 0`);
    db.run(`UPDATE subjects SET student_count = (
    SELECT COUNT(DISTINCT student_id) FROM registrations WHERE registrations.subject_code = subjects.subject_code
  )`);
}

// Helper: convert sql.js result to array of objects
function resultToObjects(result) {
    if (!result || result.length === 0) return [];
    const columns = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        columns.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

module.exports = router;
