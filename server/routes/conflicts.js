const express = require('express');
const { buildAllocatedScheduleEntries } = require('../utils/scheduleAllocation');
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

function timeToMinutes(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
}

function periodsOverlap(p1Start, p1End, p2Start, p2End) {
    const s1 = timeToMinutes(p1Start), e1 = timeToMinutes(p1End);
    const s2 = timeToMinutes(p2Start), e2 = timeToMinutes(p2End);
    return s1 < e2 && s2 < e1;
}

function periodsBackToBack(p1Start, p1End, p2Start, p2End) {
    const e1 = timeToMinutes(p1End), s2 = timeToMinutes(p2Start);
    const e2 = timeToMinutes(p2End), s1 = timeToMinutes(p1Start);
    return e1 === s2 || e2 === s1;
}


// GET detect all conflicts
router.get('/', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { student_id, subject_code, department, level, conflict_type, exam_date } = req.query;

        // Get back-to-back setting
        const settingResult = db.exec(`SELECT value FROM settings WHERE key='back_to_back'`);
        const backToBackMode = settingResult.length && settingResult[0].values.length
            ? settingResult[0].values[0][0] : 'warning';

        const scheduleData = buildAllocatedScheduleEntries(db);
        const studentExams = {};
        for (const exam of scheduleData) {
            for (const student of exam.assigned_students || []) {
                if (!studentExams[student.student_id]) {
                    studentExams[student.student_id] = {
                        student_id: student.student_id,
                        student_name: student.student_name,
                        department: student.department,
                        level: student.level,
                        program: student.program,
                        exams: []
                    };
                }
                studentExams[student.student_id].exams.push({
                    subject_code: exam.subject_code,
                    period_id: exam.exam_period_id,
                    exam_date: exam.exam_date,
                    start_time: exam.start_time,
                    end_time: exam.end_time
                });
            }
        }

        const conflicts = [];
        const conflictSet = new Set(); // prevent duplicates

        for (const [sid, data] of Object.entries(studentExams)) {
            const exams = data.exams;
            if (exams.length < 2) continue;

            for (let i = 0; i < exams.length; i++) {
                for (let j = i + 1; j < exams.length; j++) {
                    const a = exams[i], b = exams[j];
                    if (a.subject_code === b.subject_code) continue; // Skip same-subject cross-period checks

                    const conflictKey = `${sid}-${[a.subject_code, b.subject_code].sort().join('-')}-`;

                    // Same period conflict
                    if (a.period_id === b.period_id) {
                        const key = conflictKey + 'same_period';
                        if (!conflictSet.has(key)) {
                            conflictSet.add(key);
                            conflicts.push({
                                student_id: sid,
                                student_name: data.student_name,
                                department: data.department,
                                level: data.level,
                                program: data.program,
                                subject_codes: [a.subject_code, b.subject_code],
                                exam_date: a.exam_date,
                                period_time: `${a.start_time}–${a.end_time}`,
                                conflict_type: 'same_period',
                                notes: `Both exams at ${a.start_time}–${a.end_time}`
                            });
                        }
                        continue; // skip other checks for same period
                    }

                    // Same day checks
                    if (a.exam_date === b.exam_date) {
                        // Overlapping time
                        if (periodsOverlap(a.start_time, a.end_time, b.start_time, b.end_time)) {
                            const key = conflictKey + 'overlapping';
                            if (!conflictSet.has(key)) {
                                conflictSet.add(key);
                                conflicts.push({
                                    student_id: sid,
                                    student_name: data.student_name,
                                    department: data.department,
                                    level: data.level,
                                    program: data.program,
                                    subject_codes: [a.subject_code, b.subject_code],
                                    exam_date: a.exam_date,
                                    period_time: `${a.start_time}–${a.end_time} / ${b.start_time}–${b.end_time}`,
                                    conflict_type: 'overlapping',
                                    notes: `Time periods overlap`
                                });
                            }
                        }

                        // Back-to-back
                        if (backToBackMode !== 'allowed' && periodsBackToBack(a.start_time, a.end_time, b.start_time, b.end_time)) {
                            const key = conflictKey + 'back_to_back';
                            if (!conflictSet.has(key)) {
                                conflictSet.add(key);
                                conflicts.push({
                                    student_id: sid,
                                    student_name: data.student_name,
                                    department: data.department,
                                    level: data.level,
                                    program: data.program,
                                    subject_codes: [a.subject_code, b.subject_code],
                                    exam_date: a.exam_date,
                                    period_time: `${a.start_time}–${a.end_time} / ${b.start_time}–${b.end_time}`,
                                    conflict_type: backToBackMode === 'conflict' ? 'back_to_back_conflict' : 'back_to_back_warning',
                                    notes: `Exams are back-to-back`
                                });
                            }
                        }

                        // Same day (different, non-overlapping times)
                        if (!periodsOverlap(a.start_time, a.end_time, b.start_time, b.end_time)) {
                            const key = conflictKey + 'same_day';
                            if (!conflictSet.has(key)) {
                                conflictSet.add(key);
                                conflicts.push({
                                    student_id: sid,
                                    student_name: data.student_name,
                                    department: data.department,
                                    level: data.level,
                                    program: data.program,
                                    subject_codes: [a.subject_code, b.subject_code],
                                    exam_date: a.exam_date,
                                    period_time: `${a.start_time}–${a.end_time} / ${b.start_time}–${b.end_time}`,
                                    conflict_type: 'same_day',
                                    notes: `Multiple exams on the same day`
                                });
                            }
                        }
                    } else {
                        // Consecutive days check
                        const d1 = new Date(a.exam_date + 'T00:00:00');
                        const d2 = new Date(b.exam_date + 'T00:00:00');
                        const diffTime = Math.abs(d2 - d1);
                        const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

                        if (diffDays === 1) {
                            const key = conflictKey + 'consecutive_day';
                            if (!conflictSet.has(key)) {
                                conflictSet.add(key);
                                conflicts.push({
                                    student_id: sid,
                                    student_name: data.student_name,
                                    department: data.department,
                                    level: data.level,
                                    program: data.program,
                                    subject_codes: [a.subject_code, b.subject_code],
                                    exam_date: a.exam_date < b.exam_date ? `${a.exam_date} & ${b.exam_date}` : `${b.exam_date} & ${a.exam_date}`,
                                    period_time: `${a.start_time}–${a.end_time} / ${b.start_time}–${b.end_time}`,
                                    conflict_type: 'consecutive_day',
                                    notes: `Exams on consecutive days`
                                });
                            }
                        }
                    }
                }
            }
        }

        // Apply filters
        let filtered = conflicts;
        if (student_id) filtered = filtered.filter(c => c.student_id.includes(student_id));
        if (subject_code) filtered = filtered.filter(c => c.subject_codes.some(s => s.includes(subject_code)));
        if (department) filtered = filtered.filter(c => c.department === department);
        if (level) filtered = filtered.filter(c => c.level === level);
        if (conflict_type) filtered = filtered.filter(c => c.conflict_type === conflict_type);
        if (exam_date) filtered = filtered.filter(c => c.exam_date === exam_date);

        // Summary
        const summary = {
            total: filtered.length,
            same_period: filtered.filter(c => c.conflict_type === 'same_period').length,
            overlapping: filtered.filter(c => c.conflict_type === 'overlapping').length,
            same_day: filtered.filter(c => c.conflict_type === 'same_day').length,
            back_to_back: filtered.filter(c => c.conflict_type.startsWith('back_to_back')).length,
            consecutive_day: filtered.filter(c => c.conflict_type === 'consecutive_day').length
        };

        res.json({ conflicts: filtered, summary });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET conflict summary for a specific cell (period)
router.get('/cell/:periodId', (req, res) => {
    const db = req.app.locals.db;
    try {
        const periodId = req.params.periodId;

        // Get subjects in this period
        const subjects = resultToObjects(db.exec(
            `SELECT subject_code FROM schedule WHERE exam_period_id = ?`, [periodId]
        ));

        if (subjects.length < 2) {
            return res.json({ conflicts: [], count: 0 });
        }

        const subjectCodes = subjects.map(s => s.subject_code);

        // Find students enrolled in multiple subjects in this cell
        const placeholders = subjectCodes.map(() => '?').join(',');
        const result = db.exec(`
      SELECT r.student_id, GROUP_CONCAT(r.subject_code) as conflicting_subjects,
             s.student_name
      FROM registrations r
      JOIN students s ON r.student_id = s.student_id
      WHERE r.subject_code IN (${placeholders})
      GROUP BY r.student_id
      HAVING COUNT(DISTINCT r.subject_code) > 1
    `, subjectCodes);

        const cellConflicts = resultToObjects(result);
        res.json({ conflicts: cellConflicts, count: cellConflicts.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
