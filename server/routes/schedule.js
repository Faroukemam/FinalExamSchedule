const express = require('express');
const path = require('path');
const { spawnSync } = require('child_process');
const { normalizeExamDate } = require('../utils/date');
const { buildAllocatedScheduleEntries } = require('../utils/scheduleAllocation');
const { capForType, withCapacityTransaction } = require('../utils/capacity');
const { allocatePools } = require('../utils/poolAllocation');
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

function toMinutes(timeValue) {
    const [hh, mm] = String(timeValue || '00:00').split(':').map(Number);
    return (hh * 60) + mm;
}

function periodDurationMinutes(startTime, endTime) {
    let diff = toMinutes(endTime) - toMinutes(startTime);
    if (diff < 0) diff += 24 * 60; // allow overnight periods if ever used
    return diff;
}

function periodsOverlap(aStart, aEnd, bStart, bEnd) {
    return toMinutes(aStart) < toMinutes(bEnd) && toMinutes(bStart) < toMinutes(aEnd);
}

function periodsBackToBack(aStart, aEnd, bStart, bEnd) {
    return toMinutes(aEnd) === toMinutes(bStart) || toMinutes(bEnd) === toMinutes(aStart);
}

function dateDiffDays(aDate, bDate) {
    const a = new Date(`${aDate}T00:00:00`);
    const b = new Date(`${bDate}T00:00:00`);
    return Math.round(Math.abs(b - a) / (1000 * 60 * 60 * 24));
}

const CONFLICT_WEIGHTS = {
    same_period: 1000000,
    overlapping: 100000,
    capacity_overflow: 200000,
    back_to_back: 10000,
    same_day: 1000,
    consecutive_day: 100
};

function conflictBreakdownForPeriods(a, b, backToBackMode = 'warning') {
    const breakdown = {
        same_period: 0,
        overlapping: 0,
        back_to_back: 0,
        same_day: 0,
        consecutive_day: 0
    };
    const aId = a.id ?? a.period_id;
    const bId = b.id ?? b.period_id;
    if (String(aId) === String(bId)) {
        breakdown.same_period = 1;
        return breakdown;
    }
    if (a.exam_date === b.exam_date) {
        if (periodsOverlap(a.start_time, a.end_time, b.start_time, b.end_time)) {
            breakdown.overlapping = 1;
            return breakdown;
        }
        if (backToBackMode !== 'allowed' && periodsBackToBack(a.start_time, a.end_time, b.start_time, b.end_time)) {
            breakdown.back_to_back = 1;
        }
        breakdown.same_day = 1;
        return breakdown;
    }
    if (dateDiffDays(a.exam_date, b.exam_date) === 1) {
        breakdown.consecutive_day = 1;
    }
    return breakdown;
}

function conflictScoreFromBreakdown(breakdown) {
    return Object.entries(CONFLICT_WEIGHTS).reduce(
        (sum, [key, weight]) => sum + ((Number(breakdown[key]) || 0) * weight),
        0
    );
}

function runOrToolsAutoSchedule(payload) {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'auto_schedule_ortools.py');
    const pythonCommands = [
        process.env.PYTHON_PATH,
        process.env.PYTHON,
        'python'
    ].filter(Boolean);

    let lastError = null;
    for (const pythonCommand of pythonCommands) {
        const result = spawnSync(pythonCommand, [scriptPath], {
            input: JSON.stringify(payload),
            encoding: 'utf-8',
            timeout: 30000
        });

        if (result.error) {
            lastError = result.error;
            continue;
        }
        if (result.status !== 0) {
            lastError = new Error((result.stderr || result.stdout || `Python exited with code ${result.status}`).trim());
            continue;
        }

        const stdout = String(result.stdout || '').trim();
        if (!stdout) {
            lastError = new Error('OR-Tools solver returned no output');
            continue;
        }
        return JSON.parse(stdout);
    }

    throw lastError || new Error('Python runtime not available for OR-Tools auto scheduling');
}

function heuristicAutoSchedule({ units, periods, studentSubjects, currentSchedule, db, backToBackMode }) {
    const orderedDates = [...new Set(periods.map(period => String(period.exam_date || '')))]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
    const dayRankByDate = Object.fromEntries(orderedDates.map((date, index) => [date, index]));
    const prioritizedUnits = units.slice().sort((a, b) =>
        (Number(b.student_count) || 0) - (Number(a.student_count) || 0) ||
        (Number(b.required_duration) || 0) - (Number(a.required_duration) || 0) ||
        String(a.unit_id || '').localeCompare(String(b.unit_id || ''))
    );
    const periodSubjects = {};
    const periodStudents = {};
    const studentDayCounts = {};
    for (const entry of currentSchedule) {
        if (!periodSubjects[entry.period_id]) periodSubjects[entry.period_id] = [];
        periodSubjects[entry.period_id].push(entry.subject_code);
        const usage = periodStudents[entry.period_id] ||= {};
        usage[entry.subject_code] = (usage[entry.subject_code] || 0) + (Number(entry.student_count) || 0);
        for (const sid of entry.assigned_student_ids || []) {
            const studentId = String(sid);
            if (!studentDayCounts[studentId]) studentDayCounts[studentId] = {};
            studentDayCounts[studentId][entry.exam_date] = (studentDayCounts[studentId][entry.exam_date] || 0) + 1;
        }
    }

    const placed = [];
    const placedUnits = [];
    const failed = [];

    for (const unit of prioritizedUnits) {
        const requiredDuration = Number(unit.required_duration) || 120;
        const enrolledStudents = unit.enrolled_students || [];
        const sizeBucket = Math.max(1, Math.ceil((Number(unit.student_count) || 0) / 25));
        const eligiblePeriods = periods.filter(p =>
            unit.eligible_period_ids.includes(Number(p.id))
        ).filter(p => {
            if (!allocatePools(p, { ...periodStudents[p.id], ...unit.subject_counts }).ok) {
                return false;
            }
            return enrolledStudents.every(sid => ((studentDayCounts[String(sid)]?.[p.exam_date] || 0) < 2));
        });

        if (eligiblePeriods.length === 0) {
            for (const subjectCode of unit.subject_codes) {
                failed.push({
                    subject_code: subjectCode,
                    reason: 'No eligible slot has enough Minor/Major capacity and remaining daily exam allowance'
                });
            }
            continue;
        }

        let bestPeriod = null;
        let minConflicts = Infinity;
        let bestUtilization = Infinity;

        for (const period of eligiblePeriods) {
            const breakdownTotals = {
                same_period: 0,
                overlapping: 0,
                back_to_back: 0,
                same_day: 0,
                consecutive_day: 0
            };

            for (const sid of enrolledStudents) {
                const studentSubs = studentSubjects[sid];
                if (!studentSubs) continue;
                for (const existing of currentSchedule) {
                    if (!(existing.assigned_student_ids || []).includes(String(sid))) continue;
                    const breakdown = conflictBreakdownForPeriods(period, existing, backToBackMode);
                    for (const key of Object.keys(breakdownTotals)) {
                        breakdownTotals[key] += breakdown[key];
                    }
                }
                for (const placedUnit of placedUnits) {
                    if (placedUnit.subject_codes.some(code => unit.subject_codes.includes(code))) continue;
                    if (!placedUnit.subject_codes.some(code => studentSubs.has(code))) continue;
                    const placedPeriod = periods.find(pp => Number(pp.id) === Number(placedUnit.exam_period_id));
                    if (placedPeriod) {
                        const breakdown = conflictBreakdownForPeriods(period, placedPeriod, backToBackMode);
                        for (const key of Object.keys(breakdownTotals)) {
                            breakdownTotals[key] += breakdown[key];
                        }
                    }
                }
            }

            const conflicts = conflictScoreFromBreakdown(breakdownTotals);
            const allocation = allocatePools(period, { ...periodStudents[period.id], ...unit.subject_counts });
            const utilization = allocation.usage.major + allocation.usage.minor;
            const earlyDayPenalty = (dayRankByDate[String(period.exam_date || '')] || 0) * sizeBucket;
            const totalScore = conflicts + earlyDayPenalty;

            if (totalScore < minConflicts || (totalScore === minConflicts && utilization < bestUtilization)) {
                minConflicts = totalScore;
                bestUtilization = utilization;
                bestPeriod = period;
            }
        }

        if (!bestPeriod) {
            for (const subjectCode of unit.subject_codes) {
                failed.push({ subject_code: subjectCode, reason: 'No available periods' });
            }
            continue;
        }

        for (const subjectCode of unit.subject_codes) {
            db.run(`DELETE FROM schedule WHERE subject_code = ?`, [subjectCode]);
            db.run(`INSERT INTO schedule (exam_period_id, subject_code, target_program) VALUES (?, ?, '')`,
                [bestPeriod.id, subjectCode]);
            db.run(`UPDATE subjects SET status = 'scheduled' WHERE subject_code = ?`, [subjectCode]);
        }

        if (!periodSubjects[bestPeriod.id]) periodSubjects[bestPeriod.id] = [];
        periodSubjects[bestPeriod.id].push(...unit.subject_codes);
        periodStudents[bestPeriod.id] = { ...periodStudents[bestPeriod.id], ...unit.subject_counts };
        for (const sid of enrolledStudents) {
            const studentId = String(sid);
            if (!studentDayCounts[studentId]) studentDayCounts[studentId] = {};
            studentDayCounts[studentId][bestPeriod.exam_date] = (studentDayCounts[studentId][bestPeriod.exam_date] || 0) + 1;
        }

        placedUnits.push({
            subject_codes: unit.subject_codes.slice(),
            exam_period_id: bestPeriod.id,
            period: `${bestPeriod.exam_date} ${bestPeriod.start_time}-${bestPeriod.end_time}`,
            conflicts: minConflicts,
            required_duration: requiredDuration
        });
        for (const subjectCode of unit.subject_codes) {
            placed.push({
                subject_code: subjectCode,
                exam_period_id: bestPeriod.id,
                period: `${bestPeriod.exam_date} ${bestPeriod.start_time}-${bestPeriod.end_time}`,
                conflicts: minConflicts,
                required_duration: requiredDuration
            });
        }
    }

    return { placed, failed, solver: 'heuristic' };
}

function getSamePeriodGroupData(db) {
    const rows = resultToObjects(db.exec(`
        SELECT g.id as group_id, g.group_name, gs.subject_code
        FROM same_period_groups g
        JOIN same_period_group_subjects gs ON gs.group_id = g.id
        ORDER BY g.id, gs.subject_code
    `));
    const groupsById = {};
    const groupIdBySubject = {};
    for (const row of rows) {
        if (!groupsById[row.group_id]) {
            groupsById[row.group_id] = {
                group_id: row.group_id,
                group_name: row.group_name,
                subject_codes: []
            };
        }
        groupsById[row.group_id].subject_codes.push(row.subject_code);
        groupIdBySubject[row.subject_code] = row.group_id;
    }
    return { groupsById, groupIdBySubject };
}

function getGroupedSubjectCodes(db, subjectCode) {
    const { groupsById, groupIdBySubject } = getSamePeriodGroupData(db);
    const groupId = groupIdBySubject[subjectCode];
    return groupId ? groupsById[groupId].subject_codes.slice() : [];
}

function buildAutoScheduleUnits({ unscheduled, periods, registrations, currentSchedule, db }) {
    const { groupsById, groupIdBySubject } = getSamePeriodGroupData(db);
    const subjectByCode = Object.fromEntries(unscheduled.map(subject => [subject.subject_code, subject]));
    const registrationsBySubject = {};
    for (const row of registrations) {
        if (!registrationsBySubject[row.subject_code]) registrationsBySubject[row.subject_code] = new Set();
        registrationsBySubject[row.subject_code].add(String(row.student_id));
    }
    const currentBySubject = {};
    for (const row of currentSchedule) {
        if (!currentBySubject[row.subject_code]) currentBySubject[row.subject_code] = [];
        currentBySubject[row.subject_code].push(row);
    }

    const units = [];
    const failed = [];
    const visited = new Set();

    function failSubjects(subjectCodes, reason) {
        for (const code of subjectCodes) {
            failed.push({ subject_code: code, reason });
            visited.add(code);
        }
    }

    for (const subject of unscheduled) {
        const code = subject.subject_code;
        if (visited.has(code)) continue;

        const groupId = groupIdBySubject[code];
        const group = groupId ? groupsById[groupId] : null;
        const unitSubjects = group
            ? group.subject_codes.map(subjectCode => subjectByCode[subjectCode]).filter(Boolean)
            : [subject];
        const unitCodes = unitSubjects.map(item => item.subject_code);
        unitCodes.forEach(unitCode => visited.add(unitCode));

        const requiredDurations = [...new Set(unitSubjects.map(item => Number(item.exam_duration) || 120))];
        if (requiredDurations.length > 1) {
            failSubjects(unitCodes, 'Grouped subjects must have the same exam duration');
            continue;
        }

        let eligiblePeriods = periods.filter(period =>
            periodDurationMinutes(period.start_time, period.end_time) === requiredDurations[0]
        ).filter(period =>
            unitCodes.every(subjectCode => (registrationsBySubject[subjectCode]?.size || 0) <= capForType(period, 'subject'))
        ).filter(period =>
            unitCodes.every(subjectCode => (registrationsBySubject[subjectCode]?.size || 0) <= Math.max(capForType(period, 'major'), capForType(period, 'minor')))
        );

        const scheduledGroupMembers = group
            ? group.subject_codes.filter(subjectCode => !subjectByCode[subjectCode])
            : [];
        const pinnedPeriods = [...new Set(
            scheduledGroupMembers.flatMap(subjectCode =>
                (currentBySubject[subjectCode] || []).map(item => Number(item.period_id))
            )
        )];

        if (pinnedPeriods.length > 1) {
            failSubjects(unitCodes, `Grouped subjects already exist in different periods (${group.group_name})`);
            continue;
        }
        if (pinnedPeriods.length === 1) {
            eligiblePeriods = eligiblePeriods.filter(period => Number(period.id) === pinnedPeriods[0]);
        }

        if (eligiblePeriods.length === 0) {
            failSubjects(unitCodes, `No eligible slot matches duration (${requiredDurations[0]} min), group placement, per-subject limit and whole-subject pool capacity`);
            continue;
        }

        const studentIds = new Set();
        const subjectCounts = {};
        for (const unitCode of unitCodes) {
            subjectCounts[unitCode] = registrationsBySubject[unitCode]?.size || 0;
            for (const studentId of registrationsBySubject[unitCode] || []) {
                studentIds.add(studentId);
            }
        }

        units.push({
            unit_id: group ? `group-${group.group_id}` : `subject-${code}`,
            group_id: group ? group.group_id : null,
            group_name: group ? group.group_name : '',
            subject_codes: unitCodes,
            required_duration: requiredDurations[0],
            student_count: unitSubjects.reduce((sum, item) => sum + (Number(item.student_count) || 0), 0),
            subject_counts: subjectCounts,
            eligible_period_ids: eligiblePeriods.map(period => Number(period.id)),
            enrolled_students: [...studentIds]
        });
    }

    return { units, failed };
}

// GET full schedule grid data
router.get('/', (req, res) => {
    const db = req.app.locals.db;
    try {
        res.json(buildAllocatedScheduleEntries(db).map(row => {
            const { assigned_students, assigned_student_ids, subject_total_students, ...publicRow } = row;
            return publicRow;
        }));
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST assign subject to period
router.post('/assign', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { subject_code, exam_period_id, assignMode = 'move', target_program = '', target_programs = [] } = req.body;
        if (!subject_code || !exam_period_id) {
            return res.status(400).json({ error: 'subject_code and exam_period_id required' });
        }

        // Check subject exists
        const subCheck = db.exec(`SELECT subject_code, status FROM subjects WHERE subject_code = ?`, [subject_code]);
        if (!subCheck.length || !subCheck[0].values.length) {
            return res.status(404).json({ error: 'Subject not found' });
        }

        // Check period exists
        const periodCheck = db.exec(`SELECT exam_date, start_time, end_time FROM exam_periods WHERE id = ?`, [exam_period_id]);
        if (!periodCheck.length || !periodCheck[0].values.length) {
            return res.status(404).json({ error: 'Exam period not found' });
        }

        const periodInfo = periodCheck[0].values[0];
        const periodValue = `${periodInfo[0]} ${periodInfo[1]}-${periodInfo[2]}`;
        const targetProgramNormalized = String(target_program || '').trim();
        const targetProgramsNormalized = Array.isArray(target_programs)
            ? [...new Set(target_programs.map(p => String(p || '').trim()).filter((p, idx, arr) => p || (idx === arr.indexOf(''))))]
            : [];
        const multiExamSetting = db.exec(`SELECT value FROM settings WHERE key = 'allow_multi_exam_subject'`);
        const allowMultiExam = multiExamSetting.length && multiExamSetting[0].values.length
            ? String(multiExamSetting[0].values[0][0]).toLowerCase() === 'true'
            : false;
        const groupedSubjectCodes = getGroupedSubjectCodes(db, subject_code);
        const assignmentCodes = groupedSubjectCodes.length > 0 ? groupedSubjectCodes : [subject_code];

        if (groupedSubjectCodes.length > 0 && assignMode === 'add') {
            return res.status(400).json({ error: 'Subjects in a same-period group cannot use Add Period. Move the whole group instead.' });
        }

        withCapacityTransaction(db, () => {
            if (allowMultiExam && assignMode === 'add') {
                const targets = targetProgramsNormalized.length > 0
                    ? targetProgramsNormalized
                    : [targetProgramNormalized];
                const normalizedTargets = targets.length > 0 ? targets : [''];

                let inserted = 0;
                for (const tp of normalizedTargets) {
                    const existingInPeriod = db.exec(
                        `SELECT id FROM schedule WHERE subject_code = ? AND exam_period_id = ? AND COALESCE(target_program, '') = ?`,
                        [subject_code, exam_period_id, tp]
                    );
                    if (existingInPeriod.length && existingInPeriod[0].values.length) {
                        continue;
                    }
                    db.run(`INSERT INTO schedule (exam_period_id, subject_code, target_program) VALUES (?, ?, ?)`,
                        [exam_period_id, subject_code, tp]);
                    inserted++;
                }

                if (inserted === 0) {
                    const error = new Error('Subject already assigned to this period for all selected program targets');
                    error.status = 400;
                    throw error;
                }

                const targetLabel = normalizedTargets.map(tp => tp || 'ALL').join(', ');
                db.run(`INSERT INTO audit_log (action, subject_code, old_value, new_value) VALUES (?, ?, ?, ?)`,
                    ['schedule_assign_additional', subject_code, 'period_added', `${periodValue} [${targetLabel}]`]);
            } else {
                // Default behavior: keep exactly one period per subject.
                for (const code of assignmentCodes) {
                    const existing = db.exec(`SELECT id FROM schedule WHERE subject_code = ? AND exam_period_id = ? AND COALESCE(target_program, '') = ''`, [code, exam_period_id]);
                    if (!existing.length || !existing[0].values.length) {
                        db.run(`DELETE FROM schedule WHERE subject_code = ?`, [code]);
                        db.run(`INSERT INTO schedule (exam_period_id, subject_code, target_program) VALUES (?, ?, '')`, [exam_period_id, code]);
                    }
                    db.run(`UPDATE subjects SET status = 'scheduled' WHERE subject_code = ?`, [code]);
                }
                db.run(`INSERT INTO audit_log (action, subject_code, old_value, new_value) VALUES (?, ?, ?, ?)`,
                    ['schedule_move', assignmentCodes.join(','), 'reassigned', periodValue]);
            }
        }, [], { enforcePoolCaps: false }); // Manual placement may exceed period pools; per-subject limits still apply.

        db.saveToFile();
        res.json({ success: true });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// DELETE unassign subject
router.delete('/unassign/:subject_code', (req, res) => {
    const db = req.app.locals.db;
    try {
        const code = req.params.subject_code;
        const groupedSubjectCodes = getGroupedSubjectCodes(db, code);
        const unassignCodes = groupedSubjectCodes.length > 0 ? groupedSubjectCodes : [code];

        // Get old schedule info for audit
        const oldInfo = db.exec(`
      SELECT ep.exam_date, ep.start_time, ep.end_time 
      FROM schedule s JOIN exam_periods ep ON s.exam_period_id = ep.id 
      WHERE s.subject_code = ?`, [code]);

        for (const subjectCode of unassignCodes) {
            db.run(`DELETE FROM schedule WHERE subject_code = ?`, [subjectCode]);
            db.run(`UPDATE subjects SET status = 'unscheduled' WHERE subject_code = ? AND status = 'scheduled'`, [subjectCode]);
        }

        if (oldInfo.length && oldInfo[0].values.length) {
            const val = `${oldInfo[0].values[0][0]} ${oldInfo[0].values[0][1]}-${oldInfo[0].values[0][2]}`;
            db.run(`INSERT INTO audit_log (action, subject_code, old_value, new_value) VALUES (?, ?, ?, ?)`,
                ['schedule_remove', unassignCodes.join(','), val, 'unscheduled']);
        }

        db.saveToFile();
        res.json({ success: true });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST bulk import schedule from JSON (client-side parsed Excel/CSV)
router.post('/import', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { data } = req.body;
        let assigned = 0;
        let errors = [];

        for (const row of data) {
            try {
                const code = String(row.subject_code || row.Subject_Code || row.SubjectCode || '').trim();
                const date = normalizeExamDate(row.exam_date || row.Exam_Date || row.ExamDate || row.Date || '');
                const start = String(row.start_time || row.Start_Time || row.StartTime || row.Start || '').trim();
                const end = String(row.end_time || row.End_Time || row.EndTime || row.End || '').trim();

                if (!code || !date || !start || !end) {
                    errors.push(`Missing fields in row: ${JSON.stringify(row).substring(0, 100)}`);
                    continue;
                }

                // Strip CRN if present
                const subjectCode = code.indexOf('-') > 0 ? code.substring(0, code.indexOf('-')).trim() : code;

                assigned += withCapacityTransaction(db, () => {
                    // Ensure period exists
                    db.run(`INSERT OR IGNORE INTO exam_periods (exam_date, start_time, end_time) VALUES (?, ?, ?)`, [date, start, end]);
                    const periodResult = db.exec(`SELECT id FROM exam_periods WHERE exam_date=? AND start_time=? AND end_time=?`, [date, start, end]);

                    if (periodResult.length && periodResult[0].values.length) {
                        const periodId = periodResult[0].values[0][0];
                        // Ensure subject exists
                        db.run(`INSERT OR IGNORE INTO subjects (subject_code) VALUES (?)`, [subjectCode]);
                        // Assign to a single period only
                        db.run(`DELETE FROM schedule WHERE subject_code = ?`, [subjectCode]);
                        db.run(`INSERT INTO schedule (exam_period_id, subject_code, target_program) VALUES (?, ?, '')`, [periodId, subjectCode]);
                        db.run(`UPDATE subjects SET status = 'scheduled' WHERE subject_code = ?`, [subjectCode]);
                        return 1;
                    }
                    return 0;
                });
            } catch (rowErr) {
                errors.push(rowErr.message);
            }
        }

        db.saveToFile();
        res.json({ success: true, assigned, errors: errors.slice(0, 20) });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST auto-schedule
router.post('/auto-schedule', (req, res) => {
    const db = req.app.locals.db;
    try {
        const unscheduled = resultToObjects(
            db.exec(`SELECT * FROM subjects WHERE status = 'unscheduled' ORDER BY student_count DESC`)
        );
        const periods = resultToObjects(
            db.exec(`SELECT * FROM exam_periods ORDER BY exam_date, start_time`)
        );

        if (periods.length === 0) {
            return res.json({ success: false, error: 'No exam periods defined', placed: 0, failed: [] });
        }

        const regs = resultToObjects(
            db.exec(`SELECT student_id, subject_code FROM registrations`)
        );

        const backToBackSetting = db.exec(`SELECT value FROM settings WHERE key='back_to_back'`);
        const backToBackMode = backToBackSetting.length && backToBackSetting[0].values.length
            ? String(backToBackSetting[0].values[0][0] || 'warning')
            : 'warning';

        const studentSubjects = {};
        for (const r of regs) {
            if (!studentSubjects[r.student_id]) studentSubjects[r.student_id] = new Set();
            studentSubjects[r.student_id].add(r.subject_code);
        }

        const currentSchedule = buildAllocatedScheduleEntries(db).map(row => ({
            subject_code: row.subject_code,
            period_id: row.exam_period_id,
            exam_date: row.exam_date,
            start_time: row.start_time,
            end_time: row.end_time,
            student_count: row.student_count,
            assigned_student_ids: row.assigned_student_ids || []
        }));

        const { units, failed: preFailed } = buildAutoScheduleUnits({
            unscheduled,
            periods,
            registrations: regs,
            currentSchedule,
            db
        });

        let scheduleResult;
        try {
            const solverResult = runOrToolsAutoSchedule({
                units,
                periods,
                current_schedule: currentSchedule,
                registrations: regs,
                back_to_back_mode: backToBackMode
            });

            if (!solverResult || !solverResult.ok) {
                throw new Error(solverResult?.error || 'OR-Tools auto scheduler failed');
            }

            const unitBySubjectCode = {};
            for (const unit of units) {
                for (const code of unit.subject_codes) {
                    unitBySubjectCode[code] = unit;
                }
            }
            const prospectiveStudentsByPeriod = {};
            for (const row of currentSchedule) {
                const usage = prospectiveStudentsByPeriod[row.period_id] ||= {};
                usage[row.subject_code] = (usage[row.subject_code] || 0) + Number(row.student_count || 0);
            }
            const periodById = Object.fromEntries(periods.map(period => [Number(period.id), period]));
            const placed = [];
            const failed = preFailed.concat(Array.isArray(solverResult.failed) ? solverResult.failed.flatMap(item => {
                const subjectCodes = Array.isArray(item.subject_codes) ? item.subject_codes : [item.subject_code].filter(Boolean);
                return subjectCodes.map(code => ({ subject_code: code, reason: item.reason || 'Solver failed to place grouped subjects' }));
            }) : []);
            withCapacityTransaction(db, () => {
                for (const assignment of solverResult.placed || []) {
                    const subjectCodes = Array.isArray(assignment.subject_codes) ? assignment.subject_codes : [assignment.subject_code];
                    const primaryCode = subjectCodes[0];
                    const unit = unitBySubjectCode[primaryCode];
                    const periodId = Number(assignment.exam_period_id);
                    const period = periodById[periodId];
                    if (!unit || !period || !unit.eligible_period_ids.includes(periodId)) throw new Error('Solver returned an invalid assignment');
                    const nextSubjects = { ...prospectiveStudentsByPeriod[periodId], ...unit.subject_counts };
                    if (!allocatePools(period, nextSubjects).ok) {
                        for (const code of subjectCodes) {
                            failed.push({
                                subject_code: code,
                                reason: `No whole-subject Major/Minor allocation fits ${period.exam_date}`
                            });
                        }
                        continue;
                    }
                    prospectiveStudentsByPeriod[periodId] = nextSubjects;
                    for (const code of subjectCodes) {
                        db.run(`DELETE FROM schedule WHERE subject_code = ?`, [code]);
                        db.run(`INSERT INTO schedule (exam_period_id, subject_code, target_program) VALUES (?, ?, '')`,
                            [assignment.exam_period_id, code]);
                        db.run(`UPDATE subjects SET status = 'scheduled' WHERE subject_code = ?`, [code]);
                        placed.push({
                            subject_code: code,
                            exam_period_id: periodId,
                            period: assignment.period,
                            required_duration: assignment.required_duration
                        });
                    }
                }
            });
            scheduleResult = { placed, failed, solver: 'or-tools' };
        } catch (solverErr) {
            scheduleResult = withCapacityTransaction(db, () => heuristicAutoSchedule({
                units,
                periods,
                studentSubjects,
                currentSchedule,
                db,
                backToBackMode
            }));
            scheduleResult.failed = preFailed.concat(scheduleResult.failed || []);
            scheduleResult.warning = `OR-Tools fallback: ${solverErr.message}`;
        }

        db.saveToFile();
        res.json({
            success: true,
            placed: scheduleResult.placed.length,
            details: scheduleResult.placed,
            failed: scheduleResult.failed,
            solver: scheduleResult.solver,
            warning: scheduleResult.warning || null
        });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// DELETE unassign a single schedule entry
router.delete('/unassign-entry/:id', (req, res) => {
    const db = req.app.locals.db;
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid schedule entry id' });

        const row = db.exec(`SELECT subject_code FROM schedule WHERE id = ?`, [id]);
        if (!row.length || !row[0].values.length) return res.status(404).json({ error: 'Schedule entry not found' });
        const subjectCode = row[0].values[0][0];
        const groupedSubjectCodes = getGroupedSubjectCodes(db, subjectCode);
        const unassignCodes = groupedSubjectCodes.length > 0 ? groupedSubjectCodes : [subjectCode];

        withCapacityTransaction(db, () => {
            if (groupedSubjectCodes.length > 0) {
                for (const code of unassignCodes) {
                    db.run(`DELETE FROM schedule WHERE subject_code = ?`, [code]);
                    db.run(`UPDATE subjects SET status = 'unscheduled' WHERE subject_code = ? AND status = 'scheduled'`, [code]);
                }
            } else {
                db.run(`DELETE FROM schedule WHERE id = ?`, [id]);

                const remaining = db.exec(`SELECT COUNT(*) as c FROM schedule WHERE subject_code = ?`, [subjectCode]);
                if (!remaining.length || remaining[0].values[0][0] === 0) {
                    db.run(`UPDATE subjects SET status = 'unscheduled' WHERE subject_code = ? AND status = 'scheduled'`, [subjectCode]);
                }
            }

        }, [], { enforcePoolCaps: false });
        db.saveToFile();
        res.json({ success: true });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// DELETE clear all schedule entries
router.delete('/clear-all', (req, res) => {
    const db = req.app.locals.db;
    try {
        const count = db.exec(`SELECT COUNT(*) as c FROM schedule`);
        const total = count[0].values[0][0];

        db.run(`UPDATE subjects SET status = 'unscheduled' WHERE status = 'scheduled'`);
        db.run(`DELETE FROM schedule`);
        db.run(`INSERT INTO audit_log (action, old_value, new_value) VALUES (?, ?, ?)`,
            ['clear_all_schedule', `${total} subjects were scheduled`, 'all unscheduled']);

        db.saveToFile();
        res.json({ success: true, cleared: total });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

module.exports = router;
