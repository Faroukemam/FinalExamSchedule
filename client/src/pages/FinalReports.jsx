import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { icons, useToast } from '../App'
import { downloadExcelFromBackend, downloadMultiSheetExcelFromBackend, downloadWordFromBackend } from '../utils/export'
import { formatExamDateDisplay, sortRowsByDate } from '../utils/date'

function sum(values) {
    return values.reduce((acc, v) => acc + (Number(v) || 0), 0)
}

function parseProgramCounts(raw) {
    if (!raw) return []
    return String(raw).split(',').map(item => {
        const sep = item.lastIndexOf('::')
        if (sep < 0) return null
        return {
            program: item.slice(0, sep).trim(),
            students: Number(item.slice(sep + 2).trim()) || 0
        }
    }).filter(Boolean)
}

function durationHoursLabel(startTime, endTime) {
    const start = String(startTime || '00:00').split(':').map(Number)
    const end = String(endTime || '00:00').split(':').map(Number)
    if (start.length < 2 || end.length < 2) return ''
    let minutes = ((end[0] * 60) + end[1]) - ((start[0] * 60) + start[1])
    if (minutes < 0) minutes += 24 * 60
    const hours = minutes / 60
    if (hours <= 2) return ''
    return Number.isInteger(hours) ? `${hours} hrs` : `${hours.toFixed(1)} hrs`
}

function getWeekdayName(examDate) {
    const raw = String(examDate || '').trim()
    if (!raw) return ''
    const date = new Date(`${raw}T00:00:00`)
    if (Number.isNaN(date.getTime())) return ''
    return date.toLocaleDateString('en-US', { weekday: 'long' })
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

export default function FinalReports() {
    const addToast = useToast()
    const [loading, setLoading] = useState(true)
    const [slotCap, setSlotCap] = useState(300)
    const [schedule, setSchedule] = useState([])
    const [subjects, setSubjects] = useState([])
    const [periods, setPeriods] = useState([])
    const [conflicts, setConflicts] = useState({ conflicts: [], summary: {} })
    const [dashboard, setDashboard] = useState(null)
    const [settings, setSettings] = useState({})

    useEffect(() => {
        loadReportsData()
    }, [])

    async function loadReportsData() {
        setLoading(true)
        try {
            const [sch, sub, per, con, dash, setg] = await Promise.all([
                api.getSchedule(),
                api.getSubjects(),
                api.getPeriods(),
                api.getConflicts(),
                api.getDashboard(),
                api.getSettings()
            ])
            setSchedule(sch)
            setSubjects(sub)
            setPeriods(per)
            setConflicts(con)
            setDashboard(dash)
            setSettings(setg)
        } catch (err) {
            addToast('Failed to load final reports data', 'error')
        }
        setLoading(false)
    }

    const reportData = useMemo(() => {
        const generatedAt = new Date().toISOString()
        const orderedDates = [...new Set(
            (periods.length > 0 ? periods : schedule).map(item => item.exam_date)
        )].sort((a, b) => a.localeCompare(b))
        const dayIndexByDate = Object.fromEntries(orderedDates.map((date, idx) => [date, idx + 1]))

        const masterSchedule = schedule.map(s => ({
            Day_Index: dayIndexByDate[s.exam_date] || '',
            Period_ID: s.exam_period_id || '',
            Subject_Code: s.subject_code,
            Subject_Name: s.subject_name || '',
            Department: s.department || '',
            Program: s.program || '',
            Room_Placement_Type: s.room_placement_type || 'TH',
            Registered_Programs: s.registered_programs || '',
            Target_Program: s.target_program || 'All Programs',
            Students: s.student_count || 0,
            Program_Counts: s.program_counts || '',
            Exam_Date: formatExamDateDisplay(s.exam_date),
            Start_Time: s.start_time,
            End_Time: s.end_time,
            Student_ID_Range: s.assigned_student_id_range || ''
        }))

        const timeSlots = [...new Set(
            periods
                .slice()
                .sort((a, b) => (a.start_time + a.end_time).localeCompare(b.start_time + b.end_time))
                .map(p => `${p.start_time}-${p.end_time}`)
        )]
        const examScheduleGrid = Object.values(
            schedule.reduce((acc, item) => {
                if (!acc[item.exam_date]) {
                    acc[item.exam_date] = {
                        Day_Index: dayIndexByDate[item.exam_date] || '',
                        Date: formatExamDateDisplay(item.exam_date),
                        _sortDate: item.exam_date,
                        Total_Students: 0
                    }
                }
                const slotKey = `${item.start_time}-${item.end_time}`
                const cellText = `${item.subject_code} (${item.student_count || 0})`
                acc[item.exam_date][slotKey] = acc[item.exam_date][slotKey]
                    ? `${acc[item.exam_date][slotKey]}, ${cellText}`
                    : cellText
                acc[item.exam_date].Total_Students += Number(item.student_count) || 0
                return acc
            }, {})
        )
            .sort((a, b) => a._sortDate.localeCompare(b._sortDate))
            .map(row => {
                const normalized = { Day_Index: row.Day_Index, Date: row.Date, Total_Students: row.Total_Students }
                for (const slot of timeSlots) {
                    normalized[slot] = row[slot] || ''
                }
                return normalized
            })

        const startTimes = [...new Set(
            periods
                .slice()
                .sort((a, b) => a.start_time.localeCompare(b.start_time) || a.end_time.localeCompare(b.end_time))
                .map(period => period.start_time)
        )]

        const studentScheduleFormReport = orderedDates.map(date => {
            const row = {
                Day: getWeekdayName(date),
                Date: formatExamDateDisplay(date)
            }
            for (const startTime of startTimes) {
                const entries = schedule
                    .filter(item => item.exam_date === date && item.start_time === startTime)
                    .sort((a, b) =>
                        String(a.start_time || '').localeCompare(String(b.start_time || '')) ||
                        String(a.end_time || '').localeCompare(String(b.end_time || '')) ||
                        String(a.subject_code || '').localeCompare(String(b.subject_code || ''))
                    )
                row[startTime] = entries.map(item => {
                    const hoursLabel = durationHoursLabel(item.start_time, item.end_time)
                    const actualStudents = Number(item.student_count) || 0
                    const roomPlacementType = String(item.room_placement_type || 'TH').toUpperCase()
                    const roomTypeLabel = roomPlacementType !== 'TH' ? `, ${roomPlacementType}` : ''
                    return hoursLabel
                        ? `${item.subject_code} (${hoursLabel}, ${actualStudents}${roomTypeLabel})`
                        : `${item.subject_code} (${actualStudents}${roomTypeLabel})`
                }).join(', ')
                row[`${startTime} Actual_Students`] = sum(entries.map(item => item.student_count))
            }
            return row
        })

        const unscheduledSubjects = subjects
            .filter(s => s.status === 'unscheduled')
            .map(s => ({
                Subject_Code: s.subject_code,
                Subject_Name: s.subject_name || '',
                Department: s.department || '',
                Program: s.program || '',
                Level: s.level || '',
                Room_Placement_Type: s.room_placement_type || 'TH',
                Students: s.student_count || 0,
                Exam_Duration_Min: s.exam_duration || 0,
                Notes: s.notes || ''
            }))

        const noFinalExamSubjects = subjects
            .filter(s => s.status === 'no_final_exam')
            .map(s => ({
                Subject_Code: s.subject_code,
                Subject_Name: s.subject_name || '',
                Department: s.department || '',
                Program: s.program || '',
                Room_Placement_Type: s.room_placement_type || 'TH',
                Students: s.student_count || 0,
                Notes: s.notes || ''
            }))

        const roomPlacementReport = subjects
            .slice()
            .sort((a, b) => String(a.subject_code || '').localeCompare(String(b.subject_code || '')))
            .map(subject => ({
                Subject_Code: subject.subject_code,
                Subject_Name: subject.subject_name || '',
                Department: subject.department || '',
                Program: subject.program || '',
                Level: subject.level || '',
                Room_Placement_Type: subject.room_placement_type || 'TH',
                Students: subject.student_count || 0,
                Status: subject.status || '',
                Exam_Duration_Min: subject.exam_duration || 0,
                Notes: subject.notes || ''
            }))

        const periodRoomPlacementDetailed = sortRowsByDate(schedule.map(row => ({
            Day_Index: dayIndexByDate[row.exam_date] || '',
            Period_ID: row.exam_period_id || '',
            Exam_Date: formatExamDateDisplay(row.exam_date),
            Start_Time: row.start_time,
            End_Time: row.end_time,
            Subject_Code: row.subject_code,
            Subject_Name: row.subject_name || '',
            Room_Placement_Type: row.room_placement_type || 'TH',
            Department: row.department || '',
            Program: row.program || '',
            Target_Program: row.target_program || 'All Programs',
            Students: row.student_count || 0
        })))

        const periodRoomPlacementGrid = Object.values(
            schedule.reduce((acc, row) => {
                const key = `${row.exam_date}__${row.start_time}__${row.end_time}__${row.exam_period_id || ''}`
                if (!acc[key]) {
                    acc[key] = {
                        Day_Index: dayIndexByDate[row.exam_date] || '',
                        Period_ID: row.exam_period_id || '',
                        Date: formatExamDateDisplay(row.exam_date),
                        _sortDate: row.exam_date,
                        Start_Time: row.start_time,
                        End_Time: row.end_time,
                        TH: '',
                        LAB: '',
                        DH: '',
                        Total_Students: 0
                    }
                }
                const roomType = String(row.room_placement_type || 'TH').toUpperCase()
                const bucket = ['TH', 'LAB', 'DH'].includes(roomType) ? roomType : 'TH'
                const cellText = `${row.subject_code} (${row.student_count || 0})`
                acc[key][bucket] = acc[key][bucket]
                    ? `${acc[key][bucket]}, ${cellText}`
                    : cellText
                acc[key].Total_Students += Number(row.student_count) || 0
                return acc
            }, {})
        )
            .sort((a, b) =>
                a._sortDate.localeCompare(b._sortDate) ||
                String(a.Start_Time || '').localeCompare(String(b.Start_Time || '')) ||
                Number(a.Period_ID || 0) - Number(b.Period_ID || 0)
            )
            .map(({ _sortDate, ...row }) => row)

        const conflictDetails = (conflicts.conflicts || []).map(c => ({
            Student_ID: c.student_id,
            Student_Name: c.student_name,
            Department: c.department || '',
            Level: c.level || '',
            Program: c.program || '',
            Subjects: (c.subject_codes || []).join(', '),
            Exam_Date: formatExamDateDisplay(c.exam_date),
            Period: c.period_time,
            Conflict_Type: c.conflict_type,
            Notes: c.notes || ''
        }))

        const c = conflicts.summary || {}
        const conflictSummary = [
            { Metric: 'Total Conflicts', Value: c.total || 0 },
            { Metric: 'Same Period', Value: c.same_period || 0 },
            { Metric: 'Overlapping', Value: c.overlapping || 0 },
            { Metric: 'Same Day', Value: c.same_day || 0 },
            { Metric: 'Back To Back', Value: c.back_to_back || 0 },
            { Metric: 'Consecutive Day', Value: c.consecutive_day || 0 },
            { Metric: 'Generated At', Value: generatedAt }
        ]

        const dailyLoadMap = {}
        for (const row of schedule) {
            if (!dailyLoadMap[row.exam_date]) {
                dailyLoadMap[row.exam_date] = { date: row.exam_date, subjects: new Set(), students: 0 }
            }
            dailyLoadMap[row.exam_date].subjects.add(row.subject_code)
            dailyLoadMap[row.exam_date].students += Number(row.student_count) || 0
        }
        const dailyLoad = Object.values(dailyLoadMap)
            .sort((a, b) => a.date.localeCompare(b.date))
            .map(d => ({
                Day_Index: dayIndexByDate[d.date] || '',
                Exam_Date: formatExamDateDisplay(d.date),
                Assigned_Subjects: d.subjects.size,
                Total_Students: d.students
            }))

        const departmentMap = {}
        for (const row of schedule) {
            const dept = row.department || 'Unknown'
            if (!departmentMap[dept]) {
                departmentMap[dept] = { department: dept, subjects: new Set(), students: 0 }
            }
            departmentMap[dept].subjects.add(row.subject_code)
            departmentMap[dept].students += Number(row.student_count) || 0
        }
        const departmentWorkload = Object.values(departmentMap)
            .sort((a, b) => b.students - a.students)
            .map(d => ({
                Department: d.department,
                Assigned_Subjects: d.subjects.size,
                Total_Students: d.students
            }))

        const periodUtilization = periods
            .slice()
            .sort((a, b) => (a.exam_date + a.start_time).localeCompare(b.exam_date + b.start_time))
            .map(p => {
                const inPeriod = schedule.filter(s => s.exam_period_id === p.id)
                const subjectsInPeriod = inPeriod.length
                const studentsInPeriod = sum(inPeriod.map(i => i.student_count))
                let loadStatus = 'Empty'
                if (subjectsInPeriod >= 3) loadStatus = 'Heavy'
                if (subjectsInPeriod > 0 && subjectsInPeriod < 3) loadStatus = 'Normal'
                return {
                    Period_ID: p.id,
                    Day_Index: dayIndexByDate[p.exam_date] || '',
                    Exam_Date: formatExamDateDisplay(p.exam_date),
                    Start_Time: p.start_time,
                    End_Time: p.end_time,
                    Assigned_Subjects: subjectsInPeriod,
                    Total_Students: studentsInPeriod,
                    Load_Status: loadStatus
                }
            })

        const riskMap = {}
        for (const item of conflicts.conflicts || []) {
            if (!riskMap[item.student_id]) {
                riskMap[item.student_id] = {
                    Student_ID: item.student_id,
                    Student_Name: item.student_name,
                    Department: item.department || '',
                    Program: item.program || '',
                    Same_Period: 0,
                    Overlapping: 0,
                    Same_Day: 0,
                    Back_To_Back: 0,
                    Consecutive_Day: 0,
                    Total_Conflicts: 0
                }
            }
            const row = riskMap[item.student_id]
            row.Total_Conflicts += 1
            if (item.conflict_type === 'same_period') row.Same_Period += 1
            else if (item.conflict_type === 'overlapping') row.Overlapping += 1
            else if (item.conflict_type === 'same_day') row.Same_Day += 1
            else if (String(item.conflict_type).startsWith('back_to_back')) row.Back_To_Back += 1
            else if (item.conflict_type === 'consecutive_day') row.Consecutive_Day += 1
        }
        const studentRisk = Object.values(riskMap)
            .map(r => ({
                ...r,
                Risk_Level: r.Same_Period > 0 || r.Overlapping > 0 ? 'High' : (r.Total_Conflicts >= 3 ? 'Medium' : 'Low')
            }))
            .sort((a, b) => b.Total_Conflicts - a.Total_Conflicts)
        const studentRiskCauses = sortRowsByDate((conflicts.conflicts || []).map(item => ({
            Student_ID: item.student_id,
            Student_Name: item.student_name || '',
            Department: item.department || '',
            Program: item.program || '',
            Conflict_Type: item.conflict_type,
            Subject_1: item.subject_codes?.[0] || '',
            Subject_2: item.subject_codes?.[1] || '',
            Subjects: (item.subject_codes || []).join(', '),
            Exam_Date: formatExamDateDisplay(item.exam_date),
            Period: item.period_time || '',
            Notes: item.notes || ''
        })))

        const subjectMap = {}
        for (const row of schedule) {
            if (!subjectMap[row.subject_code]) {
                subjectMap[row.subject_code] = {
                    Subject_Code: row.subject_code,
                    Subject_Name: row.subject_name || '',
                    Department: row.department || '',
                    Room_Placement_Type: row.room_placement_type || 'TH',
                    Students: row.student_count || 0,
                    Periods_Assigned: 0,
                    Student_ID_Ranges: []
                }
            }
            subjectMap[row.subject_code].Periods_Assigned += 1
            if (row.assigned_student_id_range) {
                subjectMap[row.subject_code].Student_ID_Ranges.push(
                    `Period ${subjectMap[row.subject_code].Periods_Assigned}: ${formatExamDateDisplay(row.exam_date)} ${row.start_time}-${row.end_time} | IDs ${row.assigned_student_id_range}`
                )
            }
        }
        const subjectFootprint = Object.values(subjectMap)
            .map(s => ({
                ...s,
                Multi_Period_Assigned: s.Periods_Assigned > 1 ? 'Yes' : 'No',
                Student_ID_Range_By_Period: s.Periods_Assigned > 1 ? s.Student_ID_Ranges.join(' | ') : ''
            }))
            .map(({ Student_ID_Ranges, ...row }) => row)
            .sort((a, b) => b.Periods_Assigned - a.Periods_Assigned)

        const programSlotDistribution = []
        for (const row of schedule) {
            const parsed = parseProgramCounts(row.program_counts)
            if (parsed.length === 0) {
                programSlotDistribution.push({
                    Day_Index: dayIndexByDate[row.exam_date] || '',
                    Exam_Date: formatExamDateDisplay(row.exam_date),
                    Period: `${row.start_time}-${row.end_time}`,
                    Subject_Code: row.subject_code,
                    Room_Placement_Type: row.room_placement_type || 'TH',
                    Program: row.program || 'Unknown',
                    Students: row.student_count || 0
                })
                continue
            }
            for (const pc of parsed) {
                programSlotDistribution.push({
                    Day_Index: dayIndexByDate[row.exam_date] || '',
                    Exam_Date: formatExamDateDisplay(row.exam_date),
                    Period: `${row.start_time}-${row.end_time}`,
                    Subject_Code: row.subject_code,
                    Room_Placement_Type: row.room_placement_type || 'TH',
                    Program: pc.program || 'Unknown',
                    Students: pc.students
                })
            }
        }

        const allProgramsSchedule = []
        for (const row of schedule) {
            const parsed = parseProgramCounts(row.program_counts)
            if (parsed.length === 0) {
                allProgramsSchedule.push({
                    Day_Index: dayIndexByDate[row.exam_date] || '',
                    _sortDate: row.exam_date,
                    Program: row.program || 'Unknown',
                    Subject_Code: row.subject_code,
                    Subject_Name: row.subject_name || '',
                    Department: row.department || '',
                    Room_Placement_Type: row.room_placement_type || 'TH',
                    Exam_Date: formatExamDateDisplay(row.exam_date),
                    Start_Time: row.start_time,
                    End_Time: row.end_time,
                    Students_In_Program: row.student_count || 0
                })
                continue
            }
            for (const pc of parsed) {
                allProgramsSchedule.push({
                    Day_Index: dayIndexByDate[row.exam_date] || '',
                    _sortDate: row.exam_date,
                    Program: pc.program || 'Unknown',
                    Subject_Code: row.subject_code,
                    Subject_Name: row.subject_name || '',
                    Department: row.department || '',
                    Room_Placement_Type: row.room_placement_type || 'TH',
                    Exam_Date: formatExamDateDisplay(row.exam_date),
                    Start_Time: row.start_time,
                    End_Time: row.end_time,
                    Students_In_Program: pc.students
                })
            }
        }

        allProgramsSchedule.sort((a, b) =>
            a.Program.localeCompare(b.Program) ||
            a._sortDate.localeCompare(b._sortDate) ||
            a.Start_Time.localeCompare(b.Start_Time) ||
            a.Subject_Code.localeCompare(b.Subject_Code)
        )

        const programSchedulesMap = {}
        for (const row of allProgramsSchedule) {
            if (!programSchedulesMap[row.Program]) programSchedulesMap[row.Program] = []
            programSchedulesMap[row.Program].push({
                Day_Index: row.Day_Index,
                Subject_Code: row.Subject_Code,
                Subject_Name: row.Subject_Name,
                Department: row.Department,
                Room_Placement_Type: row.Room_Placement_Type,
                Exam_Date: row.Exam_Date,
                _sortDate: row._sortDate,
                Start_Time: row.Start_Time,
                End_Time: row.End_Time,
                Students_In_Program: row.Students_In_Program
            })
        }

        const allProgramsScheduleExport = allProgramsSchedule.map(({ _sortDate, ...row }) => row)

        const programSchedulesGridMap = {}
        for (const program of Object.keys(programSchedulesMap)) {
            const rows = programSchedulesMap[program]
            const byDate = {}
            for (const row of rows) {
                if (!byDate[row._sortDate]) {
                    byDate[row._sortDate] = { Day_Index: row.Day_Index, Date: row.Exam_Date, _sortDate: row._sortDate, Total_Students: 0 }
                }
                const slotKey = `${row.Start_Time}-${row.End_Time}`
                const cellText = `${row.Subject_Code} (${row.Students_In_Program || 0})`
                byDate[row._sortDate][slotKey] = byDate[row._sortDate][slotKey]
                    ? `${byDate[row._sortDate][slotKey]}, ${cellText}`
                    : cellText
                byDate[row._sortDate].Total_Students += Number(row.Students_In_Program) || 0
            }

            programSchedulesGridMap[program] = Object.values(byDate)
                .sort((a, b) => a._sortDate.localeCompare(b._sortDate))
                .map(row => {
                    const normalized = { Day_Index: row.Day_Index, Date: row.Date, Total_Students: row.Total_Students }
                    for (const slot of timeSlots) {
                        normalized[slot] = row[slot] || ''
                    }
                    return normalized
                })
        }

        const slotCapacity = periodUtilization.map(row => {
            const cap = Number(slotCap) || 0
            const total = Number(row.Total_Students) || 0
            const utilization = cap > 0 ? ((total / cap) * 100) : 0
            let status = 'Within Capacity'
            if (cap === 0) status = 'No Cap Defined'
            else if (total > cap) status = 'Over Capacity'
            else if (utilization >= 90) status = 'Near Capacity'
            return {
                ...row,
                Slot_Capacity: cap,
                Utilization_Percent: utilization.toFixed(1),
                Capacity_Status: status
            }
        })

        const executiveSummary = [{
            Generated_At: generatedAt,
            Total_Students: dashboard?.totalStudents || 0,
            Total_Subjects: dashboard?.totalSubjects || 0,
            Scheduled_Subjects: dashboard?.scheduledSubjects || 0,
            Unscheduled_Subjects: dashboard?.unscheduledSubjects || 0,
            No_Final_Exam_Subjects: dashboard?.noFinalExam || 0,
            Total_Exam_Periods: dashboard?.totalPeriods || 0,
            Total_Conflicts: c.total || 0,
            Same_Period_Conflicts: c.same_period || 0,
            Back_To_Back_Policy: settings.back_to_back || 'warning',
            Multi_Exam_Per_Subject_Enabled: String(settings.allow_multi_exam_subject || 'false'),
            Slot_Capacity_For_Reports: Number(slotCap) || 0
        }]

        return {
            masterSchedule,
            examScheduleGrid,
            studentScheduleFormReport,
            allProgramsSchedule: allProgramsScheduleExport,
            programSchedulesMap,
            programSchedulesGridMap,
            roomPlacementReport,
            periodRoomPlacementDetailed,
            periodRoomPlacementGrid,
            unscheduledSubjects,
            noFinalExamSubjects,
            conflictDetails,
            conflictSummary,
            dailyLoad,
            departmentWorkload,
            periodUtilization,
            slotCapacity,
            studentRisk,
            studentRiskCauses,
            subjectFootprint,
            programSlotDistribution,
            executiveSummary
        }
    }, [schedule, subjects, periods, conflicts, dashboard, settings, slotCap])

    function exportReport(filename, sheetName, rows) {
        if (!rows || rows.length === 0) {
            addToast('No rows to export for this report', 'warning')
            return
        }
        downloadExcelFromBackend(filename, sheetName, sortRowsByDate(rows))
        addToast(`Exported ${filename}`, 'success')
    }

    function exportAllProgramsWorkbook() {
        const programs = Object.keys(reportData.programSchedulesMap || {}).sort((a, b) => a.localeCompare(b))
        if (programs.length === 0) {
            addToast('No program schedule data to export', 'warning')
            return
        }
        const sheets = programs.map(program => ({
            sheetName: program,
            data: sortRowsByDate(reportData.programSchedulesMap[program] || [])
        }))
        downloadMultiSheetExcelFromBackend('final_all_programs_schedule.xlsx', sheets)
        addToast('Exported final_all_programs_schedule.xlsx', 'success')
    }

    function exportAllProgramsWorkbookGrid() {
        const programs = Object.keys(reportData.programSchedulesGridMap || {}).sort((a, b) => a.localeCompare(b))
        if (programs.length === 0) {
            addToast('No program schedule data to export', 'warning')
            return
        }
        const sheets = programs.map(program => ({
            sheetName: program,
            data: sortRowsByDate(reportData.programSchedulesGridMap[program] || [])
        }))
        downloadMultiSheetExcelFromBackend('final_all_programs_schedule_grid.xlsx', sheets)
        addToast('Exported final_all_programs_schedule_grid.xlsx', 'success')
    }

    function exportStudentRiskWorkbook() {
        if (!reportData.studentRisk?.length) {
            addToast('No rows to export for this report', 'warning')
            return
        }
        downloadMultiSheetExcelFromBackend('final_student_risk_ranking.xlsx', [
            { sheetName: 'Student Risk', data: sortRowsByDate(reportData.studentRisk) },
            { sheetName: 'Conflict Subjects', data: reportData.studentRiskCauses || [] }
        ])
        addToast('Exported final_student_risk_ranking.xlsx', 'success')
    }

    function exportStudentScheduleFormWord() {
        const rows = reportData.studentScheduleFormReport || []
        if (rows.length === 0) {
            addToast('No rows to export for this report', 'warning')
            return
        }

        const slotKeys = Object.keys(rows[0]).filter(key => key !== 'Day' && key !== 'Date' && !key.endsWith(' Actual_Students'))
        const slotMeta = slotKeys.map((slot, index) => {
            const relatedPeriods = periods
                .filter(period => period.start_time === slot)
                .slice()
                .sort((a, b) => String(a.end_time || '').localeCompare(String(b.end_time || '')))
            const endTimes = [...new Set(relatedPeriods.map(period => String(period.end_time || '').trim()).filter(Boolean))]
            const timeLabel = endTimes.length === 0
                ? slot
                : endTimes.length === 1
                    ? `${slot} - ${endTimes[0]}`
                    : `${slot} - ${endTimes.join(' / ')}`
            return {
                slot,
                periodLabel: `Period ${index + 1}`,
                timeLabel
            }
        })
        const headerPeriods = slotMeta.map(meta => `
            <th colspan="2" style="border:1px solid #222;padding:6px 4px;text-align:center;background:#ececec;font-size:10pt;">${escapeHtml(meta.periodLabel)}</th>
        `).join('')
        const headerSlots = slotMeta.map(meta => `
            <th colspan="2" style="border:1px solid #222;padding:6px 4px;text-align:center;background:#f4f4f4;font-size:10pt;">${escapeHtml(meta.timeLabel)}</th>
        `).join('')
        const headerSubs = slotMeta.map(meta => `
            <th class="slot-subject" style="border:1px solid #222;padding:6px 4px;text-align:center;background:#fafafa;">Subject</th>
            <th class="slot-count" style="border:1px solid #222;padding:6px 4px;text-align:center;background:#fafafa;">Actual Students</th>
        `).join('')
        const bodyRows = rows.map(row => {
            const cells = slotMeta.map(meta => `
                <td class="slot-subject" style="border:1px solid #222;padding:10px 8px;vertical-align:top;height:58px;">${escapeHtml(row[meta.slot] || '')}</td>
                <td class="slot-count" style="border:1px solid #222;padding:10px 8px;text-align:center;height:58px;">${escapeHtml(row[`${meta.slot} Actual_Students`] || '')}</td>
            `).join('')
            return `
                <tr>
                    <td class="day-col" style="border:1px solid #222;padding:10px 8px;text-align:center;font-weight:700;">${escapeHtml(row.Day || '')}</td>
                    <td class="date-col" style="border:1px solid #222;padding:10px 8px;text-align:center;font-weight:700;">${escapeHtml(row.Date || '')}</td>
                    ${cells}
                </tr>
            `
        }).join('')

        const html = `
            <html>
            <head>
                <meta charset="utf-8" />
                <title>Student Schedule Form</title>
                <style>
                    @page {
                        size: A4 landscape;
                        margin: 8mm;
                    }
                    body {
                        font-family: "Times New Roman", serif;
                        margin: 0;
                        color: #111;
                    }
                    h1 {
                        text-align: center;
                        margin: 0 0 10px 0;
                        font-size: 18pt;
                    }
                    .report-wrap {
                        width: 100%;
                    }
                    table {
                        border-collapse: collapse;
                        width: 100%;
                        table-layout: fixed;
                        font-size: 9pt;
                        border: 2px solid #111;
                    }
                    thead {
                        display: table-header-group;
                    }
                    tr {
                        page-break-inside: avoid;
                    }
                    th, td {
                        word-wrap: break-word;
                        overflow-wrap: anywhere;
                    }
                    .day-col {
                        width: 7%;
                    }
                    .date-col {
                        width: 8%;
                    }
                    .slot-subject {
                        width: 12%;
                    }
                    .slot-count {
                        width: 4.5%;
                    }
                </style>
            </head>
            <body>
                <div class="report-wrap">
                <h1>Student Schedule Form</h1>
                <table>
                    <thead>
                        <tr>
                            <th class="day-col" rowspan="3" style="border:1px solid #222;padding:8px 6px;text-align:center;background:#e9e9e9;">Day</th>
                            <th class="date-col" rowspan="3" style="border:1px solid #222;padding:8px 6px;text-align:center;background:#e9e9e9;">Date</th>
                            ${headerPeriods}
                        </tr>
                        <tr>
                            ${headerSlots}
                        </tr>
                        <tr>
                            ${headerSubs}
                        </tr>
                    </thead>
                    <tbody>
                        ${bodyRows}
                    </tbody>
                </table>
                </div>
            </body>
            </html>
        `

        downloadWordFromBackend('final_student_schedule_form.doc', html)
        addToast('Exported final_student_schedule_form.doc', 'success')
    }

    function exportMegaReport() {
        const sheets = [
            { sheetName: 'Executive Summary', data: reportData.executiveSummary || [] },
            { sheetName: 'Detailed Schedule', data: sortRowsByDate(reportData.masterSchedule || []) },
            { sheetName: 'Room Placement', data: sortRowsByDate(reportData.roomPlacementReport || []) },
            { sheetName: 'Period Room Detail', data: sortRowsByDate(reportData.periodRoomPlacementDetailed || []) },
            { sheetName: 'Period Room Grid', data: sortRowsByDate(reportData.periodRoomPlacementGrid || []) },
            { sheetName: 'Exam Schedule Grid', data: sortRowsByDate(reportData.examScheduleGrid || []) },
            { sheetName: 'All Programs', data: sortRowsByDate(reportData.allProgramsSchedule || []) },
            { sheetName: 'Period Utilization', data: sortRowsByDate(reportData.periodUtilization || []) },
            { sheetName: 'Slot Capacity', data: sortRowsByDate(reportData.slotCapacity || []) },
            { sheetName: 'Daily Load', data: sortRowsByDate(reportData.dailyLoad || []) },
            { sheetName: 'Dept Workload', data: sortRowsByDate(reportData.departmentWorkload || []) },
            { sheetName: 'Program Distribution', data: sortRowsByDate(reportData.programSlotDistribution || []) },
            { sheetName: 'Conflict Summary', data: sortRowsByDate(reportData.conflictSummary || []) },
            { sheetName: 'Conflict Details', data: sortRowsByDate(reportData.conflictDetails || []) },
            { sheetName: 'Student Risk', data: sortRowsByDate(reportData.studentRisk || []) },
            { sheetName: 'Risk Causes', data: reportData.studentRiskCauses || [] },
            { sheetName: 'Subject Footprint', data: sortRowsByDate(reportData.subjectFootprint || []) },
            { sheetName: 'Unscheduled', data: sortRowsByDate(reportData.unscheduledSubjects || []) },
            { sheetName: 'No Final Exam', data: sortRowsByDate(reportData.noFinalExamSubjects || []) }
        ].filter(sheet => Array.isArray(sheet.data) && sheet.data.length > 0)

        const programs = Object.keys(reportData.programSchedulesMap || {}).sort((a, b) => a.localeCompare(b))
        for (const program of programs) {
            const rows = reportData.programSchedulesMap[program] || []
            if (rows.length > 0) {
                sheets.push({
                    sheetName: program,
                    data: sortRowsByDate(rows)
                })
            }
        }

        if (sheets.length === 0) {
            addToast('No data available for mega report', 'warning')
            return
        }

        downloadMultiSheetExcelFromBackend('final_mega_report.xlsx', sheets)
        addToast('Exported final_mega_report.xlsx', 'success')
    }

    const cards = [
        {
            title: 'Executive Summary',
            description: 'Top-level KPIs for final review committee.',
            rows: reportData.executiveSummary,
            filename: 'final_exec_summary.xlsx',
            sheet: 'Executive Summary',
            category: 'Executive',
            icon: icons.dashboard
        },
        {
            title: 'Student Schedule Form',
            description: 'Day/date grid with one subject column and one actual-student-count column for each period.',
            rows: reportData.studentScheduleFormReport,
            filename: 'final_student_schedule_form.doc',
            sheet: 'Student Schedule Form',
            exportKind: 'student-schedule-word',
            category: 'Operational',
            icon: icons.schedule
        },
        {
            title: 'Room Placement Types',
            description: 'Subject room placement list using TH, LAB, and DH classifications.',
            rows: reportData.roomPlacementReport,
            filename: 'final_room_placement_types.xlsx',
            sheet: 'Room Placement',
            category: 'Operational',
            icon: icons.subjects
        },
        {
            title: 'Periods Room Placement Detailed',
            description: 'Detailed period-by-period room placement list for all scheduled subjects.',
            rows: reportData.periodRoomPlacementDetailed,
            filename: 'final_period_room_placement_detailed.xlsx',
            sheet: 'Period Room Detail',
            category: 'Operational',
            icon: icons.schedule
        },
        {
            title: 'Periods Room Placement Grid',
            description: 'Grid view by period with separate TH, LAB, and DH columns.',
            rows: reportData.periodRoomPlacementGrid,
            filename: 'final_period_room_placement_grid.xlsx',
            sheet: 'Period Room Grid',
            category: 'Operational',
            icon: icons.schedule
        },
        {
            title: 'Detailed Exam Schedule',
            description: 'Row-by-row schedule with period, program target, student split, and time details.',
            rows: reportData.masterSchedule,
            filename: 'final_detailed_exam_schedule.xlsx',
            sheet: 'Detailed Schedule',
            category: 'Operational',
            icon: icons.schedule
        },
        {
            title: 'Exam Schedule Grid',
            description: 'Grid view: rows are dates, columns are time slots, cells show scheduled subjects.',
            rows: reportData.examScheduleGrid,
            filename: 'final_exam_schedule_grid.xlsx',
            sheet: 'Schedule Grid',
            category: 'Operational',
            icon: icons.schedule
        },
        {
            title: 'All Programs Schedule',
            description: 'Unified schedule view for all programs with student split.',
            rows: reportData.allProgramsSchedule,
            filename: 'final_all_programs_schedule.xlsx',
            sheet: 'All Programs',
            exportKind: 'all-programs-list',
            category: 'Program',
            icon: icons.subjects
        },
        {
            title: 'All Programs Schedule (Grid)',
            description: 'Grid option: one sheet per program with date/time slot matrix.',
            rows: reportData.allProgramsSchedule,
            filename: 'final_all_programs_schedule_grid.xlsx',
            sheet: 'All Programs Grid',
            exportKind: 'all-programs-grid',
            category: 'Program',
            icon: icons.subjects
        },
        {
            title: 'Period Utilization',
            description: 'Slot-by-slot load analysis (empty, normal, heavy).',
            rows: reportData.periodUtilization,
            filename: 'final_period_utilization.xlsx',
            sheet: 'Period Utilization',
            category: 'Workload',
            icon: icons.schedule
        },
        {
            title: 'Slot Capacity Report',
            description: 'Capacity status by period using your selected slot cap.',
            rows: reportData.slotCapacity,
            filename: 'final_slot_capacity_report.xlsx',
            sheet: 'Slot Capacity',
            category: 'Workload',
            icon: icons.info
        },
        {
            title: 'Daily Exam Load',
            description: 'Per-day total subjects and students.',
            rows: reportData.dailyLoad,
            filename: 'final_daily_exam_load.xlsx',
            sheet: 'Daily Load',
            category: 'Workload',
            icon: icons.dashboard
        },
        {
            title: 'Department Workload',
            description: 'Scheduled load and student counts by department.',
            rows: reportData.departmentWorkload,
            filename: 'final_department_workload.xlsx',
            sheet: 'Department Workload',
            category: 'Workload',
            icon: icons.subjects
        },
        {
            title: 'Program Slot Distribution',
            description: 'Program-level student split per subject slot.',
            rows: reportData.programSlotDistribution,
            filename: 'final_program_slot_distribution.xlsx',
            sheet: 'Program Distribution',
            category: 'Program',
            icon: icons.subjects
        },
        {
            title: 'Conflict Details',
            description: 'Detailed student-level conflict log.',
            rows: reportData.conflictDetails,
            filename: 'final_conflict_details.xlsx',
            sheet: 'Conflict Details',
            category: 'Conflict',
            icon: icons.conflicts
        },
        {
            title: 'Conflict Summary',
            description: 'Conflict totals by type.',
            rows: reportData.conflictSummary,
            filename: 'final_conflict_summary.xlsx',
            sheet: 'Conflict Summary',
            category: 'Conflict',
            icon: icons.conflicts
        },
        {
            title: 'Student Risk Ranking',
            description: 'Students ranked by accumulated exam conflict pressure.',
            rows: reportData.studentRisk,
            filename: 'final_student_risk_ranking.xlsx',
            sheet: 'Student Risk',
            exportKind: 'student-risk',
            category: 'Conflict',
            icon: icons.students
        },
        {
            title: 'Subject Footprint',
            description: 'How many periods each subject is assigned to.',
            rows: reportData.subjectFootprint,
            filename: 'final_subject_footprint.xlsx',
            sheet: 'Subject Footprint',
            category: 'Operational',
            icon: icons.subjects
        },
        {
            title: 'Unscheduled Subjects',
            description: 'Subjects still not assigned to any period.',
            rows: reportData.unscheduledSubjects,
            filename: 'final_unscheduled_subjects.xlsx',
            sheet: 'Unscheduled',
            category: 'Operational',
            icon: icons.filter
        },
        {
            title: 'No Final Exam Subjects',
            description: 'Subjects flagged as no-final-exam.',
            rows: reportData.noFinalExamSubjects,
            filename: 'final_no_final_exam_subjects.xlsx',
            sheet: 'No Final Exam',
            category: 'Operational',
            icon: icons.check
        }
    ]

    const programCards = Object.keys(reportData.programSchedulesMap || {})
        .sort((a, b) => a.localeCompare(b))
        .map(program => ({
            title: `Program Schedule - ${program}`,
            description: `Detailed exam schedule for ${program}.`,
            rows: reportData.programSchedulesMap[program] || [],
            filename: `final_program_schedule_${program.replace(/[^a-zA-Z0-9_-]/g, '_')}.xlsx`,
            sheet: 'Program Schedule',
            icon: icons.subjects
        }))

    if (loading) return <div className="text-center mt-lg"><div className="spinner" style={{ margin: '40px auto' }}></div></div>

    return (
        <div className="reports-shell">
            <div className="section-header">
                <div>
                    <h2 className="section-title">Final Reports</h2>
                    <p className="section-subtitle">Recommended final report pack for exam committee review</p>
                </div>
                <div className="flex gap-sm">
                    <button className="btn btn-primary" onClick={exportMegaReport}>
                        {icons.download} <span>Mega Report</span>
                    </button>
                    <button className="btn btn-secondary" onClick={loadReportsData}>
                        {icons.search} <span>Refresh Data</span>
                    </button>
                </div>
            </div>

            <div className="card reports-hero mb-lg">
                <div className="reports-hero-head">
                    <strong className="reports-hero-title">Recommended Reports: {cards.length + programCards.length}</strong>
                    <div className="reports-badges">
                        <span className="badge badge-scheduled">Operational</span>
                        <span className="badge badge-overlapping">Workload</span>
                        <span className="badge badge-same-day">Conflict</span>
                        <span className="badge badge-back-to-back">Executive</span>
                    </div>
                </div>
                <div className="reports-kpi-strip">
                    <div className="reports-kpi"><span>Students</span><strong>{dashboard?.totalStudents || 0}</strong></div>
                    <div className="reports-kpi"><span>Scheduled</span><strong>{dashboard?.scheduledSubjects || 0}</strong></div>
                    <div className="reports-kpi"><span>Conflicts</span><strong>{conflicts.summary?.total || 0}</strong></div>
                    <div className="reports-kpi"><span>Periods</span><strong>{dashboard?.totalPeriods || 0}</strong></div>
                </div>
                <div className="reports-controls">
                    <label className="form-label reports-cap-label">Slot Cap (students)</label>
                    <input
                        className="form-input"
                        type="number"
                        min="0"
                        value={slotCap}
                        onChange={(e) => setSlotCap(Math.max(0, parseInt(e.target.value || '0', 10) || 0))}
                        style={{ width: 140 }}
                    />
                </div>
            </div>

            <div className="summary-grid reports-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
                {cards.map(card => (
                    <div key={card.title} className="card report-card">
                        <div className="report-card-top">
                            <span className="report-card-icon">{card.icon}</span>
                            <span className="badge badge-no-final">{card.category}</span>
                        </div>
                        <div className="flex items-center justify-between">
                            <h3 className="report-card-title">{card.title}</h3>
                            <span className="badge badge-unscheduled">{card.rows.length} rows</span>
                        </div>
                        <p className="text-sm text-muted report-card-description">{card.description}</p>
                        <button
                            className="btn btn-primary btn-sm"
                            onClick={() => card.exportKind === 'all-programs-list'
                                ? exportAllProgramsWorkbook()
                                : card.exportKind === 'all-programs-grid'
                                    ? exportAllProgramsWorkbookGrid()
                                    : card.exportKind === 'student-risk'
                                        ? exportStudentRiskWorkbook()
                                        : card.exportKind === 'student-schedule-word'
                                            ? exportStudentScheduleFormWord()
                                    : exportReport(card.filename, card.sheet, card.rows)}
                            style={{ alignSelf: 'flex-start' }}
                        >
                            {icons.download} <span>Export</span>
                        </button>
                    </div>
                ))}
            </div>

            {programCards.length > 0 && (
                <>
                    <div className="section-header" style={{ marginTop: 'var(--space-xl)' }}>
                        <div>
                            <h2 className="section-title">Program Schedules</h2>
                            <p className="section-subtitle">Export each program schedule separately</p>
                        </div>
                    </div>
                    <div className="summary-grid reports-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
                        {programCards.map(card => (
                            <div key={card.title} className="card report-card">
                                <div className="report-card-top">
                                    <span className="report-card-icon">{card.icon}</span>
                                    <span className="badge badge-scheduled">Program</span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <h3 className="report-card-title">{card.title}</h3>
                                    <span className="badge badge-unscheduled">{card.rows.length} rows</span>
                                </div>
                                <p className="text-sm text-muted report-card-description">{card.description}</p>
                                <button
                                    className="btn btn-primary btn-sm"
                                    onClick={() => exportReport(card.filename, card.sheet, card.rows)}
                                    style={{ alignSelf: 'flex-start' }}
                                >
                                    {icons.download} <span>Export</span>
                                </button>
                            </div>
                        ))}
                    </div>
                </>
            )}
        </div>
    )
}
