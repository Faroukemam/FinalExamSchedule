import { formatExamDateDisplay, formatDateTimeDisplay, sortRowsByDate } from './date.js'

const sum = rows => rows.reduce((total, value) => total + (Number(value) || 0), 0)
const displayCap = value => value === null || value === undefined || value === '' ? 'Unlimited' : Number(value)
const limited = value => value !== null && value !== undefined && value !== ''
const poolName = row => row.capacity_pool === 'minor' ? 'Minor' : row.capacity_pool === 'major' ? 'Major' : 'Unknown'

function programCounts(row) {
    const counts = new Map()
    for (const part of String(row.program_counts || '').split(',')) {
        const separator = part.lastIndexOf('::')
        if (separator < 0) continue
        const name = part.slice(0, separator).trim() || 'Unspecified'
        const count = Number(part.slice(separator + 2))
        if (Number.isFinite(count) && count > 0) counts.set(name, (counts.get(name) || 0) + count)
    }
    const assigned = Number(row.student_count) || 0
    const missing = assigned - sum([...counts.values()])
    if (!counts.size) counts.set('Unspecified', assigned)
    else if (missing > 0) counts.set('Unspecified', (counts.get('Unspecified') || 0) + missing)
    return [...counts].map(([program, count]) => ({ program, count }))
}

function makeGrid(rows, dates, timeSlots, dayIndex) {
    return dates.map(date => {
        const entries = rows.filter(row => row.exam_date === date)
        const result = { Day_Index: dayIndex[date], Date: formatExamDateDisplay(date), Student_Exam_Assignments: sum(entries.map(row => row.student_count)) }
        for (const slot of timeSlots) {
            const subjects = new Map()
            for (const row of entries.filter(row => `${row.start_time}-${row.end_time}` === slot)) {
                subjects.set(row.subject_code, (subjects.get(row.subject_code) || 0) + (Number(row.student_count) || 0))
            }
            result[slot] = [...subjects].sort(([a], [b]) => a.localeCompare(b))
                .map(([code, count]) => `${code} (${count})`).join('\n')
        }
        return result
    })
}

function makeStudentFormGrid(rows, timeSlots) {
    return timeSlots.map(slot => ({
        Period: slot.replace('-', ' - '),
        ...Object.fromEntries(rows.map(row => [row.Date, row[slot] || '']))
    }))
}

function makeDetailedDepartmentGrid(rows, dates, timeSlots, dayIndex) {
    return dates.map(date => {
        const entries = rows.filter(row => row.exam_date === date)
        const parsed = new Date(`${date}T12:00:00Z`)
        const result = {
            Day_Index: dayIndex[date],
            Day: Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
            Date: formatExamDateDisplay(date),
            Student_Exam_Assignments: sum(entries.map(row => row.student_count))
        }
        for (const slot of timeSlots) {
            const grouped = new Map()
            for (const row of entries.filter(row => `${row.start_time}-${row.end_time}` === slot)) {
                const key = row.subject_code
                const item = grouped.get(key) || {
                    code: row.subject_code, name: row.subject_name || '', rooms: new Map(),
                    count: 0, programs: new Map(), ranges: new Set()
                }
                item.count += Number(row.student_count) || 0
                const room = row.room_placement_type || 'TH'
                item.rooms.set(room, (item.rooms.get(room) || 0) + (Number(row.student_count) || 0))
                for (const { program, count } of programCounts(row)) item.programs.set(program, (item.programs.get(program) || 0) + count)
                if (row.assigned_student_id_range) item.ranges.add(row.assigned_student_id_range)
                grouped.set(key, item)
            }
            result[slot] = [...grouped.values()].sort((a, b) => a.code.localeCompare(b.code))
                .map(item => [
                    `${item.code}${item.name ? ` - ${item.name}` : ''}`,
                    `Programs: ${[...item.programs].sort(([a], [b]) => a.localeCompare(b)).map(([program, count]) => `${program} (${count})`).join(', ')}`,
                    `Room: ${[...item.rooms].sort(([a], [b]) => a.localeCompare(b)).map(([room, count]) => item.rooms.size > 1 ? `${room} (${count})` : room).join(', ')} | Students: ${item.count}`,
                    ...(item.ranges.size ? [`Student IDs: ${[...item.ranges].join(' | ')}`] : [])
                ].join(' | ')).join('\n')
        }
        return result
    })
}

// This printable form deliberately contains no capacity-pool details.
function makeStudentForm(schedule, dates, startTimes) {
    return dates.map(date => {
        const parsed = new Date(`${date}T12:00:00Z`)
        const result = { Day: Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }), Date: formatExamDateDisplay(date) }
        for (const start of startTimes) {
            const entries = schedule.filter(row => row.exam_date === date && row.start_time === start)
                .sort((a, b) => a.end_time.localeCompare(b.end_time) || a.subject_code.localeCompare(b.subject_code))
            result[start] = entries.map(row => {
                const minutes = time => { const [h, m] = time.split(':').map(Number); return h * 60 + m }
                const duration = (minutes(row.end_time) - minutes(row.start_time) + 1440) % 1440
                const details = []
                if (duration > 120) details.push(`${duration / 60} hrs`)
                details.push(Number(row.student_count) || 0)
                if (row.room_placement_type && row.room_placement_type !== 'TH') details.push(row.room_placement_type)
                return `${row.subject_code} (${details.join(', ')})`
            }).join(', ')
            result[`${start} Actual_Students`] = sum(entries.map(row => row.student_count))
        }
        return result
    })
}

export function buildReportData({ schedule = [], subjects = [], periods = [], conflicts = { conflicts: [] }, dashboard = {}, settings = {}, generatedAt = new Date().toISOString() } = {}) {
    const dates = [...new Set([...periods, ...schedule].map(row => row.exam_date))].sort()
    const dayIndex = Object.fromEntries(dates.map((date, index) => [date, index + 1]))
    const timeSlots = [...new Set([...periods, ...schedule].map(row => `${row.start_time}-${row.end_time}`))].sort()
    const startTimes = [...new Set([...periods, ...schedule].map(row => row.start_time))].sort()
    // Keep the timetable calendar, but omit assignments with no students from exports.
    schedule = schedule.filter(row => Number.isFinite(Number(row.student_count)) && Number(row.student_count) > 0)
    const assignedSubjects = new Set(schedule.map(row => row.subject_code))
    subjects = subjects.filter(row => Number(row.student_count) > 0 || assignedSubjects.has(row.subject_code))
    const masterSchedule = sortRowsByDate(schedule.map(row => ({
        Day_Index: dayIndex[row.exam_date], Period_ID: row.exam_period_id,
        Subject_Code: row.subject_code, Subject_Name: row.subject_name || '', Department: row.department || '',
        Room_Placement_Type: row.room_placement_type || 'TH', Target_Program: row.target_program || 'All Programs',
        Registered_Programs: row.registered_programs || '', Assigned_Students: Number(row.student_count) || 0,
        Program_Counts: row.program_counts || '', Capacity_Pool: poolName(row),
        Pool_Allocation_Status: row.capacity_valid === false ? 'Does not fit' : row.capacity_valid === true ? 'Fits' : 'Unavailable',
        Exam_Date: formatExamDateDisplay(row.exam_date), Start_Time: row.start_time, End_Time: row.end_time,
        Student_ID_Range: row.assigned_student_id_range || ''
    })))
    const subjectRegister = subjects.slice().sort((a, b) => a.subject_code.localeCompare(b.subject_code)).map(subject => {
        const entries = schedule.filter(row => row.subject_code === subject.subject_code)
        const status = entries.length ? 'scheduled' : subject.status === 'no_final_exam' ? 'no_final_exam' : 'unscheduled'
        const assigned = sum(entries.map(row => row.student_count))
        const issues = []
        if (subject.status !== status) issues.push(`Stored status: ${subject.status}; actual: ${status}`)
        if (subject.status === 'no_final_exam' && entries.length) issues.push('No-final subject has an assignment')
        if (entries.length && assigned !== Number(subject.student_count || 0)) issues.push('Assigned count differs from enrollment')
        return {
            Subject_Code: subject.subject_code, Subject_Name: subject.subject_name || '', Department: subject.department || '',
            Program: subject.program || '', Level: subject.level || '', Room_Placement_Type: subject.room_placement_type || 'TH',
            Enrolled_Students: Number(subject.student_count) || 0, Assigned_Students: assigned,
            Exam_Duration_Min: subject.exam_duration ?? 120, Status: status,
            Periods_Assigned: new Set(entries.map(row => row.exam_period_id)).size, Schedule_Entries: entries.length,
            Assigned_Periods: [...new Set(entries.map(row => `${formatExamDateDisplay(row.exam_date)} ${row.start_time}-${row.end_time}`))].join(' | '),
            Data_Issues: issues.join('; '), Notes: subject.notes || ''
        }
    })
    const slotCapacity = sortRowsByDate(periods.map(period => {
        const entries = schedule.filter(row => Number(row.exam_period_id) === Number(period.id))
        const bySubject = new Map()
        for (const row of entries) bySubject.set(row.subject_code, (bySubject.get(row.subject_code) || 0) + Number(row.student_count || 0))
        const major = sum(entries.filter(row => row.capacity_pool === 'major').map(row => row.student_count))
        const minor = sum(entries.filter(row => row.capacity_pool === 'minor').map(row => row.student_count))
        const unknown = sum(entries.filter(row => !['major', 'minor'].includes(row.capacity_pool)).map(row => row.student_count))
        const oversized = [...bySubject].filter(([, count]) => limited(period.subject_cap) && count > Number(period.subject_cap)).map(([code]) => code)
        const invalid = entries.some(row => row.capacity_valid === false) || oversized.length > 0 ||
            (limited(period.major_cap) && major > Number(period.major_cap)) || (limited(period.minor_cap) && minor > Number(period.minor_cap))
        const status = !entries.length ? 'Empty' : invalid ? 'Over Capacity' : unknown > 0 || entries.some(row => row.capacity_valid === undefined) ? 'Allocation unavailable' : 'Within Capacity'
        const remaining = (cap, used) => limited(cap) ? Math.max(0, Number(cap) - used) : 'Unlimited'
        return {
            Period_ID: period.id, Day_Index: dayIndex[period.exam_date], Exam_Date: formatExamDateDisplay(period.exam_date), Start_Time: period.start_time, End_Time: period.end_time,
            Assigned_Subjects: bySubject.size, Schedule_Entries: entries.length, Student_Exam_Assignments: sum(entries.map(row => row.student_count)),
            Major_Students: major, Major_Cap: displayCap(period.major_cap), Major_Remaining: remaining(period.major_cap, major),
            Minor_Students: minor, Minor_Cap: displayCap(period.minor_cap), Minor_Remaining: remaining(period.minor_cap, minor),
            Unallocated_Students: unknown, Max_Students_Per_Subject: displayCap(period.subject_cap), Largest_Subject: Math.max(0, ...bySubject.values()),
            Oversized_Subjects: oversized.join(', '), Capacity_Status: status
        }
    }))
    const allProgramsSchedule = sortRowsByDate(schedule.flatMap(row => programCounts(row).map(({ program, count }) => ({
        Day_Index: dayIndex[row.exam_date], Period_ID: row.exam_period_id, Program: program,
        Subject_Code: row.subject_code, Subject_Name: row.subject_name || '', Department: row.department || '',
        Room_Placement_Type: row.room_placement_type || 'TH', Capacity_Pool: poolName(row),
        Exam_Date: formatExamDateDisplay(row.exam_date), Start_Time: row.start_time, End_Time: row.end_time, Students_In_Program: count
    }))))
    const programSchedulesMap = Object.fromEntries([...new Set(allProgramsSchedule.map(row => row.Program))].sort().map(program => [program, allProgramsSchedule.filter(row => row.Program === program)]))
    const programSchedulesGridMap = Object.fromEntries(Object.entries(programSchedulesMap).map(([program, rows]) => [program,
        makeGrid(rows.map(row => ({ exam_date: dates[row.Day_Index - 1], start_time: row.Start_Time, end_time: row.End_Time, subject_code: row.Subject_Code, student_count: row.Students_In_Program })), dates, timeSlots, dayIndex)
    ]))
    const departmentName = value => String(value || '').trim() || 'Unspecified'
    const departments = [...new Set([...subjects.map(row => departmentName(row.department)), ...allProgramsSchedule.map(row => departmentName(row.Department))])].sort()
    const departmentScheduleGrids = Object.fromEntries(departments.map(department => [department,
        makeDetailedDepartmentGrid(schedule.filter(row => departmentName(row.department) === department), dates, timeSlots, dayIndex)
    ]))
    const roomRequirements = sortRowsByDate(periods.map(period => {
        const entries = schedule.filter(row => Number(row.exam_period_id) === Number(period.id))
        const result = { Period_ID: period.id, Exam_Date: formatExamDateDisplay(period.exam_date), Start_Time: period.start_time, End_Time: period.end_time }
        for (const type of ['TH', 'LAB', 'DH']) {
            const matching = entries.filter(row => (row.room_placement_type || 'TH') === type)
            result[`${type}_Subjects`] = matching.map(row => `${row.subject_code} (${row.student_count || 0})`).join(', ')
            result[`${type}_Students`] = sum(matching.map(row => row.student_count))
        }
        result.Student_Exam_Assignments = sum(entries.map(row => row.student_count))
        return result
    }))
    const dailyLoad = dates.map(date => {
        const entries = schedule.filter(row => row.exam_date === date)
        const slots = slotCapacity.filter(row => row.Day_Index === dayIndex[date])
        return { Day_Index: dayIndex[date], Exam_Date: formatExamDateDisplay(date), Assigned_Subjects: new Set(entries.map(row => row.subject_code)).size,
            Occupied_Slots: new Set(entries.map(row => row.exam_period_id)).size, Student_Exam_Assignments: sum(entries.map(row => row.student_count)),
            Major_Students: sum(slots.map(row => row.Major_Students)), Minor_Students: sum(slots.map(row => row.Minor_Students)) }
    })
    const departmentWorkload = [...new Set(schedule.map(row => row.department || 'Unspecified'))].sort().map(department => {
        const entries = schedule.filter(row => (row.department || 'Unspecified') === department)
        return { Department: department, Assigned_Subjects: new Set(entries.map(row => row.subject_code)).size,
            Student_Exam_Assignments: sum(entries.map(row => row.student_count)), Major_Students: sum(entries.filter(row => row.capacity_pool === 'major').map(row => row.student_count)),
            Minor_Students: sum(entries.filter(row => row.capacity_pool === 'minor').map(row => row.student_count)) }
    })
    const conflictItems = conflicts.conflicts || []
    const conflictDetails = sortRowsByDate(conflictItems.map(row => ({
        Student_ID: row.student_id, Student_Name: row.student_name || '', Department: row.department || '', Program: row.program || '', Level: row.level || '',
        Subjects: (row.subject_codes || []).join(', '), Exam_Date: formatExamDateDisplay(row.exam_date), Period: row.period_time || '', Conflict_Type: row.conflict_type, Notes: row.notes || ''
    })))
    const conflictSummary = ['same_period', 'overlapping', 'same_day', 'back_to_back_conflict', 'back_to_back_warning', 'consecutive_day'].map(type => ({
        Conflict_Type: type, Records: conflictItems.filter(row => row.conflict_type === type).length,
        Affected_Students: new Set(conflictItems.filter(row => row.conflict_type === type).map(row => row.student_id)).size
    }))
    const affectedStudents = [...new Set(conflictItems.map(row => row.student_id))].sort().map(id => {
        const items = conflictItems.filter(row => row.student_id === id)
        return { Student_ID: id, Student_Name: items[0].student_name || '', Department: items[0].department || '', Program: items[0].program || '',
            Clash_Records: items.filter(row => ['same_period', 'overlapping'].includes(row.conflict_type)).length,
            Other_Conflict_Records: items.filter(row => !['same_period', 'overlapping'].includes(row.conflict_type)).length,
            Total_Conflict_Records: items.length, Subjects: [...new Set(items.flatMap(row => row.subject_codes || []))].sort().join(', ') }
    })
    const executiveSummary = [{
        Generated_At_Cairo: formatDateTimeDisplay(generatedAt),
        Registered_Students: dashboard?.totalStudents ?? '', Total_Subjects: subjects.length,
        Scheduled_Subjects: subjectRegister.filter(row => row.Status === 'scheduled').length,
        Unscheduled_Subjects: subjectRegister.filter(row => row.Status === 'unscheduled').length,
        No_Final_Exam_Subjects: subjectRegister.filter(row => row.Status === 'no_final_exam').length,
        Defined_Slots: periods.length, Occupied_Slots: slotCapacity.filter(row => row.Assigned_Subjects > 0).length,
        Slots_Over_Capacity: slotCapacity.filter(row => row.Capacity_Status === 'Over Capacity').length,
        Slots_Using_Minor: slotCapacity.filter(row => row.Minor_Students > 0).length,
        Student_Exam_Assignments: sum(schedule.map(row => row.student_count)),
        Major_Student_Exam_Assignments: sum(slotCapacity.map(row => row.Major_Students)), Minor_Student_Exam_Assignments: sum(slotCapacity.map(row => row.Minor_Students)),
        Conflict_Records: conflictItems.length, Students_With_Conflicts: affectedStudents.length,
        Subjects_With_Data_Issues: subjectRegister.filter(row => row.Data_Issues).length,
        Back_To_Back_Policy: settings.back_to_back || 'warning',
        Capacity_Policy: 'Automatic Major first, Minor as needed; each subject uses one pool'
    }]
    const examScheduleGrid = makeGrid(schedule, dates, timeSlots, dayIndex)
    const studentFormGrid = makeStudentFormGrid(examScheduleGrid, timeSlots)
    const studentFormProgramGrids = Object.fromEntries(Object.entries(programSchedulesGridMap).map(([program, rows]) => [program, makeStudentFormGrid(rows, timeSlots)]))
    return { masterSchedule, examScheduleGrid, studentFormGrid, studentFormProgramGrids, studentScheduleFormReport: makeStudentForm(schedule, dates, startTimes),
        allProgramsSchedule, programSchedulesMap, programSchedulesGridMap, departmentScheduleGrids, roomRequirements, subjectRegister,
        unscheduledSubjects: subjectRegister.filter(row => row.Status === 'unscheduled'), noFinalExamSubjects: subjectRegister.filter(row => row.Status === 'no_final_exam'),
        slotCapacity, dailyLoad, departmentWorkload, executiveSummary, conflictSummary, conflictDetails, affectedStudents }
}

export function buildReportPacks(data) {
    const sheet = (sheetName, rows) => ({ sheetName, data: rows })
    const programs = Object.keys(data.programSchedulesMap)
    return [
        { id: 'schedule', title: 'Exam Schedule', description: 'Detailed assignments with pool allocations, plus the date/time grid.', filename: 'final_exam_schedule.xlsx', category: 'Schedule', sheets: [sheet('Detailed Schedule', data.masterSchedule), sheet('Schedule Grid', data.examScheduleGrid)] },
        { id: 'student-form', title: 'University Form', description: 'Printable Word timetable with subjects, room types and actual student counts.', filename: 'final_university_form.doc', category: 'Schedule', word: true, rows: data.studentScheduleFormReport },
        { id: 'programs', title: 'Program Schedule Grids', description: 'A combined Schedule Grid followed by one timetable grid sheet per program, with date rows and time-slot columns.', filename: 'final_program_schedule_grids.xlsx', category: 'Schedule', sheets: [sheet('Schedule Grid', data.examScheduleGrid), ...programs.map(program => sheet(`${program} Grid`, data.programSchedulesGridMap[program]))] },
        { id: 'student-form-grids', title: 'Student form', description: 'Dates in columns and actual start/end times in rows. A combined sheet and one sheet per program, each with an identifying title above its table.', filename: 'final_student_form.xlsx', category: 'Schedule', sheets: [
            { ...sheet('All Programs Student Form', data.studentFormGrid), title: 'Student form — All Programs', autoFilter: false, printHeaderFooter: false },
            ...programs.map(program => ({ ...sheet(`${program} Student Form`, data.studentFormProgramGrids[program]), title: `Student form — ${program}`, autoFilter: false, printHeaderFooter: false }))
        ] },
        { id: 'department-grids', title: 'Detailed Schedule Grid', description: 'One detailed timetable sheet per department. Date rows and time-slot columns show subject names/codes, program counts, room types, student totals and available ID ranges.', filename: 'final_department_detailed_grids.xlsx', category: 'Schedule', sheets: Object.entries(data.departmentScheduleGrids).map(([department, rows]) => sheet(department, rows)) },
        { id: 'rooms', title: 'Room Requirements', description: 'TH, LAB and DH subject lists and student counts for each slot.', filename: 'final_room_requirements.xlsx', category: 'Planning', sheets: [sheet('Room Requirements', data.roomRequirements)] },
        { id: 'capacity', title: 'Capacity & Workload', description: 'Overview, automatic Major/Minor usage, remaining capacity, per-subject violations and daily/department totals.', filename: 'final_capacity_workload.xlsx', category: 'Planning', sheets: [sheet('Overview', data.executiveSummary), sheet('Slot Capacity', data.slotCapacity), sheet('Daily Load', data.dailyLoad), sheet('Department Workload', data.departmentWorkload)] },
        { id: 'conflicts', title: 'Conflicts', description: 'Conflict totals, student-level details and affected students with their subjects.', filename: 'final_conflicts.xlsx', category: 'Review', sheets: [sheet('Conflict Summary', data.conflictSummary), sheet('Conflict Details', data.conflictDetails), sheet('Affected Students', data.affectedStudents)] },
        { id: 'subjects', title: 'Subject Status', description: 'Actual assignment status, enrollment, assigned periods, outstanding subjects and data inconsistencies.', filename: 'final_subject_status.xlsx', category: 'Review', sheets: [sheet('Subject Register', data.subjectRegister), sheet('Unscheduled', data.unscheduledSubjects), sheet('No Final Exam', data.noFinalExamSubjects)] }
    ]
}

export function fullReportSheets(packs) {
    const seen = new Map()
    return packs.filter(pack => !pack.word).flatMap(pack => pack.sheets).filter(sheet => {
        const name = sheet.sheetName.toLowerCase()
        const datasets = seen.get(name) || new Set()
        if (datasets.has(sheet.data)) return false
        datasets.add(sheet.data)
        seen.set(name, datasets)
        return true
    })
}
