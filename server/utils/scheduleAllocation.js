function resultToObjects(result) {
    if (!result || result.length === 0) return [];
    const columns = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        columns.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

function splitCsv(value) {
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function sortRows(rows) {
    return rows.slice().sort((a, b) =>
        String(a.exam_date || '').localeCompare(String(b.exam_date || '')) ||
        String(a.start_time || '').localeCompare(String(b.start_time || '')) ||
        Number(a.id || 0) - Number(b.id || 0)
    );
}

function splitIntoContiguousBuckets(items, bucketCount) {
    if (bucketCount <= 0) return [];
    const buckets = Array.from({ length: bucketCount }, () => []);
    const total = items.length;
    let start = 0;
    for (let i = 0; i < bucketCount; i++) {
        const remainingItems = total - start;
        const remainingBuckets = bucketCount - i;
        const size = Math.ceil(remainingItems / remainingBuckets);
        buckets[i] = items.slice(start, start + size);
        start += size;
    }
    return buckets;
}

function firstLastStudentIdRange(studentIds) {
    const ids = studentIds
        .map(id => String(id || '').trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
    if (ids.length === 0) return '';
    return ids.length === 1 ? ids[0] : `${ids[0]} - ${ids[ids.length - 1]}`;
}

function getScheduleBaseRows(db) {
    const scheduleCols = db.exec(`PRAGMA table_info(schedule)`);
    const hasTargetProgram = scheduleCols.length > 0 &&
        scheduleCols[0].values.some(col => col[1] === 'target_program');

    return resultToObjects(db.exec(`
      SELECT s.id, s.exam_period_id, s.subject_code, ${hasTargetProgram ? "COALESCE(s.target_program, '')" : "''"} as target_program,
             ep.exam_date, ep.start_time, ep.end_time,
             sub.subject_name, sub.student_count as subject_total_students, sub.department, sub.program,
             COALESCE(sub.room_placement_type, 'TH') as room_placement_type
      FROM schedule s
      JOIN exam_periods ep ON s.exam_period_id = ep.id
      JOIN subjects sub ON s.subject_code = sub.subject_code
      ORDER BY ep.exam_date, ep.start_time, ${hasTargetProgram ? "COALESCE(s.target_program, '')" : "''"}, s.id
    `));
}

function getRegistrationRows(db) {
    const studentCols = db.exec(`PRAGMA table_info(students)`);
    const hasStudentName = studentCols.length > 0 && studentCols[0].values.some(col => col[1] === 'student_name');
    const hasDepartment = studentCols.length > 0 && studentCols[0].values.some(col => col[1] === 'department');
    const hasLevel = studentCols.length > 0 && studentCols[0].values.some(col => col[1] === 'level');
    const hasProgram = studentCols.length > 0 && studentCols[0].values.some(col => col[1] === 'program');

    return resultToObjects(db.exec(`
      SELECT r.subject_code,
             r.student_id,
             ${hasStudentName ? 'st.student_name' : "''"} as student_name,
             ${hasDepartment ? 'st.department' : "''"} as department,
             ${hasLevel ? 'st.level' : "''"} as level,
             ${hasProgram ? 'st.program' : "''"} as program
      FROM registrations r
      JOIN students st ON st.student_id = r.student_id
      ORDER BY r.subject_code, r.student_id
    `));
}

function buildAllocatedScheduleEntries(db) {
    const baseRows = getScheduleBaseRows(db).map(row => ({
        ...row,
        target_program: String(row.target_program || '').trim(),
        assigned_students: [],
        student_count: 0,
        registered_programs: '',
        program_counts: ''
    }));
    const registrations = getRegistrationRows(db);

    const rowsBySubject = {};
    for (const row of baseRows) {
        if (!rowsBySubject[row.subject_code]) rowsBySubject[row.subject_code] = [];
        rowsBySubject[row.subject_code].push(row);
    }

    const registrationsBySubject = {};
    for (const row of registrations) {
        if (!registrationsBySubject[row.subject_code]) registrationsBySubject[row.subject_code] = [];
        registrationsBySubject[row.subject_code].push(row);
    }

    for (const [subjectCode, subjectRowsRaw] of Object.entries(rowsBySubject)) {
        const subjectRows = sortRows(subjectRowsRaw);
        const registrationsForSubject = (registrationsBySubject[subjectCode] || []).slice().sort((a, b) =>
            String(a.student_id || '').localeCompare(String(b.student_id || ''))
        );
        const targetedRowsByProgram = {};
        const generalRows = [];

        for (const row of subjectRows) {
            if (row.target_program) {
                if (!targetedRowsByProgram[row.target_program]) targetedRowsByProgram[row.target_program] = [];
                targetedRowsByProgram[row.target_program].push(row);
            } else {
                generalRows.push(row);
            }
        }

        const leftovers = [];
        for (const reg of registrationsForSubject) {
            const targetedRows = targetedRowsByProgram[String(reg.program || '').trim()] || [];
            if (targetedRows.length > 0) {
                targetedRows[0].assigned_students.push(reg);
            } else {
                leftovers.push(reg);
            }
        }

        const fallbackRows = generalRows.length > 0 ? generalRows : subjectRows;
        if (fallbackRows.length > 0) {
            const buckets = splitIntoContiguousBuckets(leftovers, fallbackRows.length);
            fallbackRows.forEach((row, index) => {
                row.assigned_students.push(...(buckets[index] || []));
            });
        }

        for (const row of subjectRows) {
            row.student_count = row.assigned_students.length;
            const assignedPrograms = [...new Set(row.assigned_students.map(student => String(student.program || '').trim()).filter(Boolean))];
            row.registered_programs = assignedPrograms.join(',');
            const countsByProgram = {};
            for (const student of row.assigned_students) {
                const program = String(student.program || '').trim();
                if (!program) continue;
                countsByProgram[program] = (countsByProgram[program] || 0) + 1;
            }
            row.program_counts = Object.entries(countsByProgram)
                .sort((a, b) => a[0].localeCompare(b[0]))
                .map(([program, count]) => `${program}::${count}`)
                .join(',');
            row.assigned_student_ids = row.assigned_students.map(student => String(student.student_id));
            row.assigned_student_id_range = firstLastStudentIdRange(row.assigned_student_ids);
        }
    }

    return baseRows;
}

module.exports = {
    splitCsv,
    buildAllocatedScheduleEntries,
    getRegistrationRows
};
