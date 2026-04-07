const express = require('express');
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

router.get('/', (req, res) => {
    const db = req.app.locals.db;
    try {
        const totalStudents = db.exec(`SELECT COUNT(*) as c FROM students`)[0].values[0][0];
        const totalSubjects = db.exec(`SELECT COUNT(*) as c FROM subjects`)[0].values[0][0];
        const scheduledSubjects = db.exec(`SELECT COUNT(*) as c FROM subjects WHERE status='scheduled'`)[0].values[0][0];
        const unscheduledSubjects = db.exec(`SELECT COUNT(*) as c FROM subjects WHERE status='unscheduled'`)[0].values[0][0];
        const noFinalExam = db.exec(`SELECT COUNT(*) as c FROM subjects WHERE status='no_final_exam'`)[0].values[0][0];
        const totalPeriods = db.exec(`SELECT COUNT(*) as c FROM exam_periods`)[0].values[0][0];

        res.json({
            totalStudents,
            totalSubjects,
            scheduledSubjects,
            unscheduledSubjects,
            noFinalExam,
            totalPeriods
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
