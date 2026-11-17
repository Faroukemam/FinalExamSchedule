const express = require('express');
const router = express.Router();
const { normalizeCapacityType, withCapacityTransaction } = require('../utils/capacity');

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

function cleanupSmallGroups(db) {
    const smallGroups = resultToObjects(db.exec(`
        SELECT g.id
        FROM same_period_groups g
        LEFT JOIN same_period_group_subjects gs ON gs.group_id = g.id
        GROUP BY g.id
        HAVING COUNT(gs.subject_code) < 2
    `));
    for (const group of smallGroups) {
        db.run(`DELETE FROM same_period_group_subjects WHERE group_id = ?`, [group.id]);
        db.run(`DELETE FROM same_period_groups WHERE id = ?`, [group.id]);
    }
}

function normalizeRoomPlacementType(value) {
    const normalized = String(value || '').trim().toUpperCase();
    return ['TH', 'LAB', 'DH'].includes(normalized) ? normalized : 'TH';
}

// GET all subjects
router.get('/', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { search, department, program, level, status } = req.query;
        let query = `
            SELECT sub.*,
                   (SELECT GROUP_CONCAT(DISTINCT st.program) 
                    FROM registrations r 
                    JOIN students st ON r.student_id = st.student_id 
                    WHERE r.subject_code = sub.subject_code AND st.program IS NOT NULL AND st.program != '') as registered_programs
            FROM subjects sub
        `;
        const conditions = [];
        const params = [];

        if (search) {
            conditions.push(`(sub.subject_code LIKE ? OR sub.subject_name LIKE ?)`);
            params.push(`%${search}%`, `%${search}%`);
        }
        if (department) { conditions.push(`sub.department = ?`); params.push(department); }
        if (program) { conditions.push(`sub.program = ?`); params.push(program); }
        if (level) { conditions.push(`sub.level = ?`); params.push(level); }
        if (status) { conditions.push(`sub.status = ?`); params.push(status); }

        if (conditions.length) query += ` WHERE ` + conditions.join(' AND ');
        query += ` ORDER BY sub.subject_code`;

        const result = db.exec(query, params);
        res.json(resultToObjects(result));
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// GET all same-period groups
router.get('/same-period-groups', (req, res) => {
    const db = req.app.locals.db;
    try {
        const groups = resultToObjects(db.exec(`
            SELECT g.id, g.group_name, g.created_at,
                   COUNT(gs.subject_code) as subject_count,
                   GROUP_CONCAT(gs.subject_code) as subject_codes,
                   GROUP_CONCAT(COALESCE(sub.subject_name, gs.subject_code)) as subject_names
            FROM same_period_groups g
            LEFT JOIN same_period_group_subjects gs ON gs.group_id = g.id
            LEFT JOIN subjects sub ON sub.subject_code = gs.subject_code
            GROUP BY g.id, g.group_name, g.created_at
            ORDER BY g.group_name, g.id
        `)).map(group => ({
            ...group,
            subject_count: Number(group.subject_count) || 0,
            subject_codes: group.subject_codes ? String(group.subject_codes).split(',').filter(Boolean) : [],
            subject_names: group.subject_names ? String(group.subject_names).split(',').filter(Boolean) : []
        }));
        res.json(groups);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST create a same-period group
router.post('/same-period-groups', (req, res) => {
    const db = req.app.locals.db;
    try {
        const subjectCodes = Array.isArray(req.body.subject_codes)
            ? [...new Set(req.body.subject_codes.map(code => String(code || '').trim().toUpperCase()).filter(Boolean))]
            : [];
        const groupName = String(req.body.group_name || '').trim() || `Same Period Group ${Date.now()}`;

        if (subjectCodes.length < 2) {
            return res.status(400).json({ error: 'Select at least two subjects' });
        }

        const placeholders = subjectCodes.map(() => '?').join(',');
        const foundSubjects = resultToObjects(db.exec(
            `SELECT subject_code FROM subjects WHERE subject_code IN (${placeholders})`,
            subjectCodes
        ));
        if (foundSubjects.length !== subjectCodes.length) {
            return res.status(400).json({ error: 'One or more selected subjects do not exist' });
        }

        const existingMemberships = resultToObjects(db.exec(
            `SELECT gs.subject_code, g.group_name
             FROM same_period_group_subjects gs
             JOIN same_period_groups g ON g.id = gs.group_id
             WHERE gs.subject_code IN (${placeholders})`,
            subjectCodes
        ));
        if (existingMemberships.length > 0) {
            const labels = existingMemberships.map(row => `${row.subject_code} (${row.group_name})`).join(', ');
            return res.status(400).json({ error: `These subjects are already in a same-period group: ${labels}` });
        }

        db.run(`INSERT INTO same_period_groups (group_name) VALUES (?)`, [groupName]);
        const groupId = db.exec(`SELECT last_insert_rowid() as id`)[0].values[0][0];

        for (const subjectCode of subjectCodes) {
            db.run(`INSERT INTO same_period_group_subjects (group_id, subject_code) VALUES (?, ?)`, [groupId, subjectCode]);
        }

        db.run(`INSERT INTO audit_log (action, subject_code, old_value, new_value) VALUES (?, ?, ?, ?)`,
            ['same_period_group_create', subjectCodes.join(','), '', groupName]);

        db.saveToFile();
        res.json({ success: true, id: groupId });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// DELETE a same-period group
router.delete('/same-period-groups/:id', (req, res) => {
    const db = req.app.locals.db;
    try {
        const groupId = Number(req.params.id);
        if (!Number.isInteger(groupId) || groupId <= 0) {
            return res.status(400).json({ error: 'Invalid group id' });
        }

        const existing = resultToObjects(db.exec(
            `SELECT g.group_name, GROUP_CONCAT(gs.subject_code) as subject_codes
             FROM same_period_groups g
             LEFT JOIN same_period_group_subjects gs ON gs.group_id = g.id
             WHERE g.id = ?
             GROUP BY g.id, g.group_name`,
            [groupId]
        ))[0];
        if (!existing) {
            return res.status(404).json({ error: 'Group not found' });
        }

        db.run(`DELETE FROM same_period_group_subjects WHERE group_id = ?`, [groupId]);
        db.run(`DELETE FROM same_period_groups WHERE id = ?`, [groupId]);
        cleanupSmallGroups(db);

        db.run(`INSERT INTO audit_log (action, subject_code, old_value, new_value) VALUES (?, ?, ?, ?)`,
            ['same_period_group_delete', existing.subject_codes || '', existing.group_name, 'deleted']);

        db.saveToFile();
        res.json({ success: true });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// GET single subject
router.get('/:code', (req, res) => {
    const db = req.app.locals.db;
    try {
        const result = db.exec(`SELECT * FROM subjects WHERE subject_code = ?`, [req.params.code]);
        const subjects = resultToObjects(result);
        if (subjects.length === 0) return res.status(404).json({ error: 'Subject not found' });
        res.json(subjects[0]);
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// PUT update subject
router.put('/:code', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { subject_name, department, program, level, room_placement_type, capacity_type, exam_duration, status, notes } = req.body;
        const code = req.params.code;

        // Get old values for audit
        const oldResult = db.exec(`SELECT * FROM subjects WHERE subject_code = ?`, [code]);
        const oldSubject = resultToObjects(oldResult)[0];
        if (!oldSubject) {
            return res.status(404).json({ error: 'Subject not found' });
        }

        const updates = [];
        const params = [];

        if (subject_name !== undefined) {
            updates.push(`subject_name = ?`);
            params.push(subject_name);
        }
        if (department !== undefined) {
            updates.push(`department = ?`);
            params.push(department);
        }
        if (program !== undefined) {
            updates.push(`program = ?`);
            params.push(program);
        }
        if (level !== undefined) {
            updates.push(`level = ?`);
            params.push(level);
        }
        if (room_placement_type !== undefined) {
            updates.push(`room_placement_type = ?`);
            params.push(normalizeRoomPlacementType(room_placement_type));
        }
        if (capacity_type !== undefined) {
            updates.push('capacity_type = ?');
            params.push(normalizeCapacityType(capacity_type));
        }
        if (exam_duration !== undefined) {
            updates.push(`exam_duration = ?`);
            params.push(exam_duration);
        }
        if (status !== undefined) {
            updates.push(`status = ?`);
            params.push(status);
        }
        if (notes !== undefined) {
            updates.push(`notes = ?`);
            params.push(notes);
        }

        if (updates.length === 0) {
            return res.json({ success: true });
        }

        params.push(code);
        withCapacityTransaction(db, () => {
            db.run(`UPDATE subjects SET ${updates.join(', ')} WHERE subject_code = ?`, params);

            // If status changed to no_final_exam, remove from schedule
            if (status === 'no_final_exam') {
                db.run(`DELETE FROM schedule WHERE subject_code = ?`, [code]);
                db.run(`DELETE FROM same_period_group_subjects WHERE subject_code = ?`, [code]);
                cleanupSmallGroups(db);
            }

            // If status changed to unscheduled, remove from schedule
            if (status === 'unscheduled') {
                db.run(`DELETE FROM schedule WHERE subject_code = ?`, [code]);
            }

        });

        // Audit log
        if (oldSubject && status && oldSubject.status !== status) {
            db.run(`INSERT INTO audit_log (action, subject_code, old_value, new_value)
              VALUES (?, ?, ?, ?)`, ['status_change', code, oldSubject.status, status]);
        }

        db.saveToFile();
        res.json({ success: true });
    } catch (err) {
        if (!err.status) console.error('PUT /api/subjects/:code failed', err);
        res.status(err.status || 500).json({ error: err?.message || String(err) || 'Failed to update subject' });
    }
});

// POST import subjects from parsed Excel/CSV
router.post('/import', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { data } = req.body;
        if (!Array.isArray(data) || data.length === 0) {
            return res.status(400).json({ error: 'No data provided' });
        }

        let imported = 0;
        let updated = 0;
        const errors = [];

        for (const row of data) {
            try {
                // Flexible column name mapping
                const code = String(
                    row.subject_code || row.Subject_Code || row.SubjectCode ||
                    row.code || row.Code || row.SUBJECT_CODE || ''
                ).trim().toUpperCase();

                if (!code) { errors.push('Row missing subject_code'); continue; }

                const name = String(
                    row.subject_name || row.Subject_Name || row.SubjectName ||
                    row.name || row.Name || row.SUBJECT_NAME || ''
                ).trim();

                const department = String(
                    row.department || row.Department || row.DEPARTMENT || row.dept || row.Dept || ''
                ).trim();

                const program = String(
                    row.program || row.Program || row.PROGRAM || ''
                ).trim();

                const level = String(
                    row.level || row.Level || row.LEVEL || ''
                ).trim();

                const roomPlacementType = normalizeRoomPlacementType(
                    row.room_placement_type || row.Room_Placement_Type || row.room_type || row.Room_Type || row.placement_type || row.Placement_Type || 'TH'
                );

                const capacityRaw = row.capacity_type ?? row.Capacity_Type;
                const capacityType = capacityRaw === undefined || capacityRaw === '' ? null : normalizeCapacityType(capacityRaw);

                const duration = parseInt(
                    row.exam_duration || row.Exam_Duration || row.ExamDuration ||
                    row.duration || row.Duration || 120
                ) || 120;

                const notes = String(
                    row.notes || row.Notes || row.NOTES || ''
                ).trim();

                // no_exam: accepts yes/no/true/false/1/0 (case-insensitive)
                const noExamRaw = String(
                    row.no_exam !== undefined ? row.no_exam
                        : row.No_Exam !== undefined ? row.No_Exam
                            : row.no_final_exam !== undefined ? row.no_final_exam
                                : row.NoExam !== undefined ? row.NoExam : ''
                ).trim().toLowerCase();
                const isNoExam = ['yes', 'true', '1', 'y'].includes(noExamRaw);
                const status = isNoExam ? 'no_final_exam' : 'unscheduled';
                const existing = db.exec(`SELECT subject_code FROM subjects WHERE subject_code = ?`, [code]);

                const wasUpdated = withCapacityTransaction(db, () => {
                    if (existing.length && existing[0].values.length) {
                        // Update existing — apply status only if no_exam column was explicitly provided
                        const hasNoExamCol = noExamRaw !== '';
                        if (hasNoExamCol && isNoExam) {
                            // Flagged as no_final_exam: remove from schedule too
                            db.run(`DELETE FROM schedule WHERE subject_code = ?`, [code]);
                        }
                        db.run(`UPDATE subjects SET
                            subject_name  = COALESCE(NULLIF(?, ''), subject_name),
                            department    = COALESCE(NULLIF(?, ''), department),
                            program       = COALESCE(NULLIF(?, ''), program),
                            level         = COALESCE(NULLIF(?, ''), level),
                            room_placement_type = ?,
                            capacity_type = COALESCE(?, capacity_type),
                            exam_duration = ?,
                            notes         = COALESCE(NULLIF(?, ''), notes)
                            ${hasNoExamCol ? ', status = ?' : ''}
                            WHERE subject_code = ?`,
                            hasNoExamCol
                                ? [name, department, program, level, roomPlacementType, capacityType, duration, notes, status, code]
                                : [name, department, program, level, roomPlacementType, capacityType, duration, notes, code]);
                        return true;
                    } else {
                        // Compute student_count from registrations if available
                        const regCount = db.exec(
                            `SELECT COUNT(DISTINCT student_id) as c FROM registrations WHERE subject_code = ?`, [code]
                        );
                        const studentCount = regCount.length ? regCount[0].values[0][0] : 0;

                        db.run(`INSERT INTO subjects
                            (subject_code, subject_name, department, program, level, room_placement_type, capacity_type, exam_duration, notes, student_count, status)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                            [code, name, department, program, level, roomPlacementType, capacityType || 'major', duration, notes, studentCount, status]);
                        return false;
                    }
                });
                if (wasUpdated) updated++; else imported++;
            } catch (rowErr) {
                errors.push(rowErr.message);
            }
        }

        db.saveToFile();
        res.json({ success: true, imported, updated, errors: errors.slice(0, 20) });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST create subject
router.post('/', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { subject_code, subject_name, department, program, level, room_placement_type, capacity_type, exam_duration, notes } = req.body;
        if (!subject_code) return res.status(400).json({ error: 'Subject code required' });

        db.run(`INSERT OR IGNORE INTO subjects (subject_code, subject_name, department, program, level, room_placement_type, capacity_type, exam_duration, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [subject_code, subject_name || '', department || '', program || '', level || '', normalizeRoomPlacementType(room_placement_type), normalizeCapacityType(capacity_type), exam_duration || 120, notes || '']);

        db.saveToFile();
        res.json({ success: true });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// POST bulk update subjects
router.post('/bulk-update', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { data } = req.body;
        let updated = 0;
        withCapacityTransaction(db, () => {
            for (const item of data) {
                if (item.subject_code) {
                    db.run(`UPDATE subjects SET
              subject_name = COALESCE(?, subject_name),
              department = COALESCE(?, department),
              program = COALESCE(?, program),
              level = COALESCE(?, level),
              room_placement_type = COALESCE(?, room_placement_type),
              capacity_type = COALESCE(?, capacity_type),
              exam_duration = COALESCE(?, exam_duration),
              notes = COALESCE(?, notes)
              WHERE subject_code = ?`,
                        [item.subject_name, item.department, item.program, item.level, item.room_placement_type ? normalizeRoomPlacementType(item.room_placement_type) : null, item.capacity_type === undefined ? null : normalizeCapacityType(item.capacity_type), item.exam_duration, item.notes, item.subject_code].map(value => value ?? null));
                    updated++;
                }
            }
        });
        db.saveToFile();
        res.json({ success: true, updated });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// DELETE all subjects (and their registrations + schedule entries)
router.delete('/all', (req, res) => {
    const db = req.app.locals.db;
    try {
        const count = db.exec(`SELECT COUNT(*) as c FROM subjects`)[0].values[0][0];
        db.run(`DELETE FROM schedule`);
        db.run(`DELETE FROM registrations`);
        db.run(`DELETE FROM subjects`);
        db.run(`INSERT INTO audit_log (action, old_value, new_value) VALUES (?, ?, ?)`,
            ['clear_all_subjects', `${count} subjects cleared`, 'empty']);
        db.saveToFile();
        res.json({ success: true, cleared: count });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

module.exports = router;
