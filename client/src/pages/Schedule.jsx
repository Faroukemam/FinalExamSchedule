import DateInput from '../components/DateInput'
import { useState, useEffect, useRef } from 'react'
import { api } from '../api'
import CapacityInputs, { CapacitySummary } from '../components/CapacityInputs'
import { icons, useToast } from '../App'
import * as XLSX from 'xlsx'

import { downloadExcelFromBackend } from '../utils/export';
import { formatExamDateDisplay, formatDatesInText, sortRowsByDate } from '../utils/date'

export default function Schedule() {
    const [periods, setPeriods] = useState([])
    const [schedule, setSchedule] = useState([])
    const [subjects, setSubjects] = useState([])
    const [conflicts, setConflicts] = useState({ conflicts: [], summary: {} })
    const [allowMultiExam, setAllowMultiExam] = useState(false)
    const [selectedProgram, setSelectedProgram] = useState('All')
    const [fitToScreen, setFitToScreen] = useState(false)
    const [loading, setLoading] = useState(true)
    const [showSetup, setShowSetup] = useState(false)
    const [showAssign, setShowAssign] = useState(null) // { periodId, date, time }
    const [showImport, setShowImport] = useState(false)
    const [autoResult, setAutoResult] = useState(null)
    const [confirmClear, setConfirmClear] = useState(false)
    const [showManage, setShowManage] = useState(false)
    const [editingPeriod, setEditingPeriod] = useState(null) // { id, exam_date, start_time, end_time }
    const [newPeriodRow, setNewPeriodRow] = useState({ exam_date: '', start_time: '09:00', end_time: '11:00', major_cap: '', minor_cap: '', subject_cap: '' })
    const [assignSearch, setAssignSearch] = useState('')
    const [addPeriodPrograms, setAddPeriodPrograms] = useState(['ALL'])
    const [setupPeriodCaps, setSetupPeriodCaps] = useState({ major_cap: '', minor_cap: '', subject_cap: '' })
    const fileRef = useRef()
    const addToast = useToast()

    // Setup form state
    const [setupDates, setSetupDates] = useState('')
    const [setupPeriods, setSetupPeriods] = useState([{ start_time: '09:00', end_time: '11:00' }])

    useEffect(() => { loadAll() }, [])

    async function loadAll() {
        setLoading(true)
        try {
            const [periodsResult, scheduleResult, subjectsResult, conflictsResult, settingsResult] = await Promise.allSettled([
                api.getPeriods(),
                api.getSchedule(),
                api.getSubjects(),
                api.getConflicts(),
                api.getSettings()
            ])

            const primaryFailed = []

            if (periodsResult.status === 'fulfilled') {
                setPeriods(periodsResult.value)
            } else {
                setPeriods([])
                primaryFailed.push('periods')
            }

            if (scheduleResult.status === 'fulfilled') {
                setSchedule(scheduleResult.value)
            } else {
                setSchedule([])
                primaryFailed.push('schedule')
            }

            if (subjectsResult.status === 'fulfilled') {
                setSubjects(subjectsResult.value)
            } else {
                setSubjects([])
                primaryFailed.push('subjects')
            }

            if (conflictsResult.status === 'fulfilled') {
                setConflicts(conflictsResult.value)
            } else {
                setConflicts({ conflicts: [], summary: {} })
                addToast('Conflicts could not be loaded. Schedule data is still available.', 'warning')
            }

            if (settingsResult.status === 'fulfilled') {
                setAllowMultiExam(String(settingsResult.value.allow_multi_exam_subject || 'false').toLowerCase() === 'true')
            } else {
                setAllowMultiExam(false)
            }

            if (primaryFailed.length > 0) {
                addToast(`Failed to load ${primaryFailed.join(', ')}`, 'error')
            }
        } catch (err) {
            addToast('Failed to load schedule', 'error')
        }
        setLoading(false)
    }

    // Build grid structure
    const dates = [...new Set(periods.map(p => p.exam_date))].sort((a, b) => new Date(a) - new Date(b))
    const dayIndexByDate = Object.fromEntries(dates.map((date, index) => [date, index + 1]))
    const timeSlots = [...new Set(periods.map(p => `${p.start_time}–${p.end_time}`))].sort()

    function getPeriodId(date, timeSlot) {
        const period = periods.find(p => p.exam_date === date && `${p.start_time}–${p.end_time}` === timeSlot)
        return period?.id
    }

    function getSubjectsInCell(date, timeSlot) {
        const periodId = getPeriodId(date, timeSlot)
        if (!periodId) return []
        return schedule.filter(s => {
            if (s.exam_period_id !== periodId) return false
            if (selectedProgram === 'All') return true
            const targetProgram = (s.target_program || '').trim()
            if (targetProgram) return targetProgram === selectedProgram
            const progs = s.registered_programs ? s.registered_programs.split(',') : (s.program ? [s.program] : [])
            return progs.includes(selectedProgram)
        })
    }

    function getDurationText(timeSlot) {
        try {
            const [start, end] = timeSlot.split('–')
            const [sh, sm] = start.split(':').map(Number)
            const [eh, em] = end.split(':').map(Number)
            let diff = (eh + em / 60) - (sh + sm / 60)
            if (diff < 0) diff += 24
            return `(${Number.isInteger(diff) ? diff : diff.toFixed(1)} hrs)`
        } catch { return '' }
    }

    function getCellConflicts(date, timeSlot) {
        const subjectsInCell = getSubjectsInCell(date, timeSlot)
        if (subjectsInCell.length < 2) return []
        const codes = subjectsInCell.map(s => s.subject_code)
        return conflicts.conflicts.filter(c =>
            c.conflict_type === 'same_period' &&
            c.exam_date === date &&
            c.subject_codes.some(sc => codes.includes(sc))
        )
    }

    function hasCellConflict(date, timeSlot) {
        return getCellConflicts(date, timeSlot).length > 0
    }

    // Check if any subjects on this date have same-day conflicts
    function hasDateConflict(date) {
        return conflicts.conflicts.some(c =>
            c.exam_date === date &&
            (c.conflict_type === 'same_day' || c.conflict_type === 'same_period' || c.conflict_type === 'overlapping')
        )
    }

    async function assignSubject(subjectCode, periodId, assignMode = 'move', targetProgram = '', targetPrograms = []) {
        try {
            await api.assignSubject(subjectCode, periodId, assignMode, targetProgram, targetPrograms)
            addToast(`${subjectCode} scheduled`, 'success')
            setShowAssign(null)
            setAssignSearch('')
            loadAll()
        } catch (err) { addToast(err.message, 'error') }
    }

    async function unassignSubject(code) {
        try {
            await api.unassignSubject(code)
            addToast(`${code} unscheduled`, 'success')
            loadAll()
        } catch (err) { addToast(err.message, 'error') }
    }

    async function unassignScheduleEntry(entry) {
        try {
            await api.unassignScheduleEntry(entry.id)
            const suffix = entry.target_program ? ` (${entry.target_program})` : ''
            addToast(`${entry.subject_code}${suffix} unscheduled`, 'success')
            loadAll()
        } catch (err) { addToast(err.message, 'error') }
    }

    async function handleClearAll() {
        try {
            const result = await api.clearAllSchedule()
            addToast(`Cleared ${result.cleared} scheduled subjects`, 'success')
            setConfirmClear(false)
            loadAll()
        } catch (err) { addToast(err.message, 'error') }
    }

    async function handleSavePeriod(period) {
        try {
            await api.updatePeriod(period.id, {
                exam_date: period.exam_date,
                start_time: period.start_time,
                end_time: period.end_time,
                major_cap: period.major_cap, minor_cap: period.minor_cap, subject_cap: period.subject_cap
            })
            addToast(`Period updated`, 'success')
            setEditingPeriod(null)
            loadAll()
        } catch (err) { addToast(err.message, 'error') }
    }

    async function handleDeletePeriod(id) {
        if (!confirm('Delete this period? Any subjects assigned to it will be unscheduled.')) return
        try {
            await api.deletePeriod(id)
            addToast('Period deleted', 'success')
            loadAll()
        } catch (err) { addToast(err.message, 'error') }
    }

    async function handleAddPeriodRow() {
        const { exam_date, start_time, end_time } = newPeriodRow
        if (!exam_date) { addToast('Date is required', 'warning'); return }
        try {
            await api.createPeriod({ exam_date, start_time, end_time, major_cap: newPeriodRow.major_cap, minor_cap: newPeriodRow.minor_cap, subject_cap: newPeriodRow.subject_cap })
            addToast('Period added', 'success')
            setNewPeriodRow({ exam_date: '', start_time: '09:00', end_time: '11:00', major_cap: '', minor_cap: '', subject_cap: '' })
            loadAll()
        } catch (err) { addToast(err.message, 'error') }
    }

    async function handleAutoSchedule() {
        try {
            const result = await api.autoSchedule()
            setAutoResult(result)
            if (!result.success) { addToast(result.error || 'Auto-scheduling failed', 'error'); return }
            if (result.warning) addToast(result.warning, 'warning')
            addToast(`Auto-scheduled ${result.placed} subjects`, 'success')
            loadAll()
        } catch (err) { addToast(err.message, 'error') }
    }

    async function handleSetupSubmit() {
        try {
            const dateList = setupDates.split('\n').map(d => d.trim()).filter(Boolean)
            if (dateList.length === 0) { addToast('Enter at least one date', 'warning'); return }
            if (setupPeriods.length === 0) { addToast('Add at least one time period', 'warning'); return }
            await api.bulkCreatePeriods(dateList, setupPeriods, setupPeriodCaps)
            addToast(`Created ${dateList.length * setupPeriods.length} exam slots`, 'success')
            setShowSetup(false)
            loadAll()
        } catch (err) { addToast(err.message, 'error') }
    }


    async function handleImportSchedule(e) {
        const file = e.target.files?.[0]
        if (!file) return
        try {
            const buffer = await file.arrayBuffer()
            const wb = XLSX.read(buffer, { type: 'array' })
            const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]])
            const result = await api.importSchedule(data)
            addToast(`Imported ${result.assigned} schedule entries`, 'success')
            setShowImport(false)
            loadAll()
        } catch (err) { addToast(err.message, 'error') }
        if (fileRef.current) fileRef.current.value = ''
    }

    function exportSchedule() {
        const data = sortRowsByDate(schedule.map(s => ({
            Day_Index: dayIndexByDate[s.exam_date] || '',
            Subject_Code: s.subject_code, Subject_Name: s.subject_name,
            Department: s.department, Students: s.student_count,
            Exam_Date: formatExamDateDisplay(s.exam_date), Start_Time: s.start_time, End_Time: s.end_time
        })))
        downloadExcelFromBackend('exam_schedule.xlsx', 'Schedule', data);
        addToast('Exported to exam_schedule.xlsx', 'success')
    }

    function downloadScheduleTemplate() {
        const template = [
            { subject_code: 'CSE565', exam_date: '10/05/2026', start_time: '09:00', end_time: '11:00' },
            { subject_code: 'CSE575', exam_date: '10/05/2026', start_time: '12:00', end_time: '14:00' },
            { subject_code: 'MTH301', exam_date: '11/05/2026', start_time: '09:00', end_time: '11:00' }
        ]
        downloadExcelFromBackend('schedule_import_template.xlsx', 'Schedule Template', template);
        addToast('Template downloaded', 'success')
    }

    function formatDate(dateStr) {
        const date = new Date(`${dateStr}T12:00:00Z`)
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })
    }

    const unscheduledSubjects = subjects.filter(s => s.status === 'unscheduled')
    const assignableSubjects = subjects.filter(s => {
        const progs = s.registered_programs ? s.registered_programs.split(',') : (s.program ? [s.program] : []);
        return s.status !== 'no_final_exam' &&
            (!assignSearch || s.subject_code.toLowerCase().includes(assignSearch.toLowerCase()) ||
                (s.subject_name || '').toLowerCase().includes(assignSearch.toLowerCase())) &&
            (selectedProgram === 'All' || progs.includes(selectedProgram));
    })

    // Extract unique programs from global subjects for the dropdown
    const availablePrograms = [...new Set(subjects.flatMap(s => s.registered_programs ? s.registered_programs.split(',') : (s.program ? [s.program] : [])))].filter(Boolean).sort()

    if (loading) return <div className="text-center mt-lg"><div className="spinner" style={{ margin: '40px auto' }}></div></div>

    return (
        <div>
            <div className="section-header">
                <div>
                    <h2 className="section-title">Exam Schedule Grid</h2>
                    <p className="section-subtitle">{schedule.length} scheduled • {unscheduledSubjects.length} remaining</p>
                </div>
                <div className="schedule-toolbar">
                    <select
                        className="form-select"
                        value={selectedProgram}
                        onChange={(e) => setSelectedProgram(e.target.value)}
                        style={{ minWidth: 200 }}
                    >
                        <option value="All">All Programs</option>
                        {availablePrograms.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                    <button className="btn btn-secondary" onClick={() => setShowSetup(true)}>{icons.plus} <span>Setup Grid</span></button>
                    <button className="btn btn-secondary" onClick={() => setShowManage(true)}>{icons.audit} <span>Manage Periods</span></button>
                    <button className="btn btn-secondary" onClick={() => setFitToScreen(!fitToScreen)} title={fitToScreen ? "Scroll Horizontally" : "Fit to Screen"}>
                        {fitToScreen ? icons.maximize : icons.minimize} <span>{fitToScreen ? 'Expand Grid' : 'Fit to Screen'}</span>
                    </button>
                    <button className="btn btn-primary" onClick={handleAutoSchedule}>{icons.wand} <span>Auto-Schedule</span></button>
                    <button className="btn btn-secondary" onClick={() => setShowImport(true)}>{icons.upload} <span>Import</span></button>
                    <button className="btn btn-danger" onClick={() => setConfirmClear(true)}>{icons.trash} <span>Clear Schedule</span></button>
                    <button className="btn btn-secondary" onClick={exportSchedule}>{icons.download} <span>Export</span></button>
                </div>
            </div>

            {/* Conflict summary bar */}
            {conflicts.summary?.total > 0 && (
                <div className="card mb-lg" style={{ borderColor: 'rgba(239,68,68,0.3)' }}>
                    <div className="flex items-center gap-lg" style={{ flexWrap: 'wrap' }}>
                        <div className="flex items-center gap-sm">
                            <span style={{ color: 'var(--danger)' }}>{icons.conflicts}</span>
                            <strong style={{ color: 'var(--danger)' }}>{conflicts.summary.total} conflicts detected</strong>
                        </div>
                        <span className="badge badge-same-period">Same Period: {conflicts.summary.same_period}</span>
                        <span className="badge badge-overlapping">Overlapping: {conflicts.summary.overlapping}</span>
                        <span className="badge badge-same-day">Same Day: {conflicts.summary.same_day}</span>
                        {conflicts.summary.back_to_back > 0 && <span className="badge badge-back-to-back">Back-to-Back: {conflicts.summary.back_to_back}</span>}
                        {conflicts.summary.consecutive_day > 0 && <span className="badge badge-consecutive-day">Consecutive Days: {conflicts.summary.consecutive_day}</span>}
                    </div>
                </div>
            )}

            {/* Auto-schedule result */}
            {autoResult && (
                <div className="card mb-lg" style={{ borderColor: 'rgba(34,197,94,0.3)' }}>
                    <div className="flex items-center justify-between">
                        <div>
                            <strong style={{ color: 'var(--success)' }}>Auto-scheduled {autoResult.placed} subjects</strong>
                            {autoResult.failed?.length > 0 && (
                                <span className="text-muted" style={{ marginLeft: 8 }}>({autoResult.failed.length} could not be placed)</span>
                            )}
                        </div>
                        <button className="btn btn-ghost btn-sm" onClick={() => setAutoResult(null)}>{icons.close}</button>
                    </div>
                    {autoResult.failed?.length > 0 && (
                        <div style={{ marginTop: 8, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                            {autoResult.failed.map(f => <div key={f.subject_code}>{f.subject_code}: {formatDatesInText(f.reason)}</div>)}
                        </div>
                    )}
                </div>
            )}

            {/* Timetable Grid */}
            {dates.length === 0 ? (
                <div className="card">
                    <div className="empty-state">
                        {icons.schedule}
                        <h3>No Exam Periods Defined</h3>
                        <p>Click "Setup Grid" to define exam dates and time periods</p>
                        <button className="btn btn-primary mt-md" onClick={() => setShowSetup(true)}>{icons.plus} Setup Grid</button>
                    </div>
                </div>
            ) : (
                <div className="exam-grid-wrapper">
                    <table className={`exam-grid${fitToScreen ? ' fit-screen' : ''}`}>
                        <thead>
                            <tr>
                                <th>Date</th>
                                {timeSlots.map(ts => (
                                    <th key={ts}>
                                        <div style={{ whiteSpace: 'nowrap' }}>{ts}</div>
                                        <div style={{ fontSize: '0.7rem', color: 'var(--accent-blue)', fontWeight: 500, marginTop: 4 }}>
                                            {getDurationText(ts)}
                                        </div>
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {dates.map(date => {
                                const periodIds = periods.filter(p => p.exam_date === date).map(p => p.id)
                                const dailyTotalStudents = schedule
                                    .filter(s => periodIds.includes(s.exam_period_id))
                                    .reduce((sum, s) => sum + (Number(s.student_count) || 0), 0)

                                return (
                                    <tr key={date}>
                                        <td style={{ background: hasDateConflict(date) ? 'rgba(239,68,68,0.08)' : undefined }}>
                                            <div className="schedule-date-cell">
                                                <div>{formatDate(date)}</div>
                                                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{formatExamDateDisplay(date)}</div>
                                                {periodIds.length > 0 && dailyTotalStudents > 0 && (
                                                <div style={{ fontSize: '0.75rem', color: 'var(--accent-blue)', fontWeight: 600, marginTop: 4 }}>
                                                    {dailyTotalStudents} students
                                                </div>
                                                )}
                                            </div>
                                        </td>
                                        {timeSlots.map(ts => {
                                            const cellSubjects = getSubjectsInCell(date, ts)
                                            const cellHasConflict = hasCellConflict(date, ts)
                                            const periodId = getPeriodId(date, ts)

                                            // Wait, the cellSubjects array itself is filtered by the active program.
                                            // So calculating total students based *only* on cellSubjects will still hide students from other programs.
                                            // We need to fetch the UNFILTERED subjects for this specific period to get the true total!
                                            const unfilteredCellSubjects = schedule.filter(s => s.exam_period_id === periodId)
                                            const cellTotalStudents = unfilteredCellSubjects.reduce((sum, row) => sum + (Number(row.student_count) || 0), 0)

                                            return (
                                                <td key={ts}>
                                                    <div className={`exam-cell${cellHasConflict ? ' has-conflict' : ''}`}
                                                        onClick={() => {
                                                            if (!periodId) return
                                                            setShowAssign({ periodId, date, time: ts })
                                                            setAddPeriodPrograms([selectedProgram !== 'All' ? selectedProgram : 'ALL'])
                                                        }}>
                                                        {periodId && cellTotalStudents > 0 && (
                                                            <div className="text-right text-muted mb-xs" style={{ fontSize: '0.75rem', fontWeight: 500 }}>
                                                                {cellTotalStudents} students
                                                            </div>
                                                        )}
                                                        {cellSubjects.map(s => (
                                                            <div key={`${s.id}-${s.subject_code}-${s.target_program || ''}`}
                                                                className={`subject-chip${cellHasConflict ? ' conflict' : ''}`}
                                                                title={`${s.subject_name || s.subject_code} (${s.student_count} students)`}
                                                                onClick={e => e.stopPropagation()}>
                                                                {s.subject_code}{s.target_program ? ` [${s.target_program}]` : ''}
                                                                <button className="chip-remove" onClick={(e) => { e.stopPropagation(); unassignScheduleEntry(s) }}>×</button>
                                                            </div>
                                                        ))}
                                                        {periodId && <button className="exam-cell-add" title="Add subject">+</button>}
                                                    </div>
                                                </td>
                                            )
                                        })}
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Remaining Subjects Panel */}
            {unscheduledSubjects.length > 0 && (
                <div className="panel mt-lg">
                    <div className="panel-header">
                        <h3 className="panel-title">Remaining Subjects to Schedule ({unscheduledSubjects.length})</h3>
                    </div>
                    <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                        <table className="data-table">
                            <thead>
                                <tr><th>Code</th><th>Name</th><th>Dept</th><th>Level</th><th>Students</th><th>Actions</th></tr>
                            </thead>
                            <tbody>
                                {unscheduledSubjects.map(s => (
                                    <tr key={s.subject_code}>
                                        <td><strong>{s.subject_code}</strong></td>
                                        <td>{s.subject_name || '—'}</td>
                                        <td>{s.department || '—'}</td>
                                        <td>{s.level || '—'}</td>
                                        <td>{s.student_count}</td>
                                        <td>
                                            <div className="flex gap-sm">
                                                <button className="btn btn-ghost btn-sm" onClick={() => {
                                                    if (periods.length > 0) {
                                                        setShowAssign({ periodId: periods[0].id, date: periods[0].exam_date, time: `${periods[0].start_time}–${periods[0].end_time}`, preselect: s.subject_code })
                                                        setAddPeriodPrograms([selectedProgram !== 'All' ? selectedProgram : 'ALL'])
                                                    }
                                                }}>{icons.plus}</button>
                                                <button className="btn btn-ghost btn-sm" onClick={async () => {
                                                    await api.updateSubject(s.subject_code, { status: 'no_final_exam' })
                                                    addToast(`${s.subject_code} marked as no final exam`, 'success')
                                                    loadAll()
                                                }}>{icons.close}</button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Setup Modal */}
            {showSetup && (
                <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowSetup(false) }}>
                    <div className="modal modal-lg">
                        <div className="modal-header">
                            <h3 className="modal-title">Setup Exam Grid</h3>
                            <button className="btn-icon" onClick={() => setShowSetup(false)}>{icons.close}</button>
                        </div>
                        <div className="modal-body">
                            <div className="form-group">
                                <label className="form-label">Exam Dates (one per line, DD/MM/YYYY or YYYY-MM-DD)</label>
                                <textarea className="form-textarea" rows={6} value={setupDates}
                                    onChange={e => setSetupDates(e.target.value)}
                                    placeholder={"10/05/2026\n11/05/2026\n12/05/2026\n13/05/2026\n14/05/2026"} />
                            </div>
                            <div className="form-group mt-lg">
                                <label className="form-label">Time Periods</label>
                                <div className="schedule-setup-cap-row">
                                    <CapacityInputs value={setupPeriodCaps} onChange={setSetupPeriodCaps} />
                                    <span className="text-muted text-sm">Optional limits for the new slots. Blank means unlimited; zero prevents student assignments.</span>
                                </div>
                                {setupPeriods.map((p, i) => (
                                    <div key={i} className="schedule-setup-period-row">
                                        <input className="form-input" type="time" value={p.start_time} onChange={e => {
                                            const np = [...setupPeriods]; np[i].start_time = e.target.value; setSetupPeriods(np)
                                        }} />
                                        <span className="text-muted">to</span>
                                        <input className="form-input" type="time" value={p.end_time} onChange={e => {
                                            const np = [...setupPeriods]; np[i].end_time = e.target.value; setSetupPeriods(np)
                                        }} />
                                        <button className="btn btn-ghost btn-sm" onClick={() => setSetupPeriods(sp => sp.filter((_, j) => j !== i))}>{icons.trash}</button>
                                    </div>
                                ))}
                                <button className="btn btn-secondary btn-sm mt-md" onClick={() => setSetupPeriods(sp => [...sp, { start_time: '09:00', end_time: '11:00' }])}>
                                    {icons.plus} Add Period
                                </button>
                            </div>
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-secondary" onClick={() => setShowSetup(false)}>Cancel</button>
                            <button className="btn btn-primary" onClick={handleSetupSubmit}>Create Grid</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Assign Subject Modal */}
            {showAssign && (
                <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) { setShowAssign(null); setAssignSearch('') } }}>
                    <div className="modal">
                        <div className="modal-header">
                            <h3 className="modal-title">Assign Subject — {formatExamDateDisplay(showAssign.date)} {showAssign.time}</h3>
                            <button className="btn-icon" onClick={() => { setShowAssign(null); setAssignSearch('') }}>{icons.close}</button>
                        </div>
                        <div className="modal-body">
                            {/* Period selector */}
                            <p className="text-sm text-muted mb-md">Manual assignments can exceed the period's total capacity. The maximum students per subject still applies. Automatic scheduling follows all capacity limits.</p>
                            <div className="form-group mb-lg">
                                <label className="form-label">Target Period</label>
                                <select className="form-select" value={showAssign.periodId} onChange={e => setShowAssign({ ...showAssign, periodId: parseInt(e.target.value) })}>
                                    {periods.map(p => (
                                        <option key={p.id} value={p.id}>{formatExamDateDisplay(p.exam_date)} {p.start_time}–{p.end_time}</option>
                                    ))}
                                </select>
                            </div>
                            {allowMultiExam && (
                                <div className="form-group mb-lg">
                                    <label className="form-label">Program Targets for Add Period</label>
                                    <select
                                        className="form-select"
                                        multiple
                                        value={addPeriodPrograms}
                                        onChange={e => setAddPeriodPrograms(Array.from(e.target.selectedOptions).map(o => o.value))}
                                        style={{ minHeight: 120 }}
                                    >
                                        <option value="ALL">All Programs (default)</option>
                                        {availablePrograms.map(p => <option key={p} value={p}>{p}</option>)}
                                    </select>
                                    <p className="text-sm text-muted" style={{ marginTop: 6 }}>
                                        Hold Ctrl/Cmd to select multiple programs. This applies when you click <strong>Add Period</strong>.
                                    </p>
                                </div>
                            )}
                            <div className="form-group mb-md">
                                <input className="form-input" placeholder="Search subjects..." value={assignSearch} onChange={e => setAssignSearch(e.target.value)} />
                            </div>
                            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                                {assignableSubjects.length === 0 ? (
                                    <div className="text-center text-muted" style={{ padding: 20 }}>No subjects found</div>
                                ) : assignableSubjects.map(s => (
                                    <div key={s.subject_code} className="schedule-assign-row">
                                        <div className="schedule-assign-meta">
                                            <strong>{s.subject_code}</strong>
                                            {s.status === 'scheduled' && <span className="badge badge-success" style={{ marginLeft: 8 }}>Scheduled</span>}
                                            <span className="text-muted" style={{ marginLeft: 8 }}>{s.subject_name}</span>
                                            <span className="text-muted" style={{ marginLeft: 8 }}>({s.student_count} students)</span>
                                        </div>
                                        <div className="schedule-assign-actions">
                                            {s.status === 'scheduled' ? (
                                                <>
                                                    <button className="btn btn-secondary btn-sm" onClick={() => assignSubject(s.subject_code, showAssign.periodId, 'move')} title="Move to this period">
                                                        Move
                                                    </button>
                                                    {allowMultiExam && (
                                                        <button
                                                            className="btn btn-primary btn-sm"
                                                            onClick={() => {
                                                                const selected = addPeriodPrograms.length > 0 ? addPeriodPrograms : ['ALL']
                                                                const cleaned = selected
                                                                    .filter(v => v !== 'ALL')
                                                                    .filter((v, i, arr) => arr.indexOf(v) === i)
                                                                assignSubject(s.subject_code, showAssign.periodId, 'add', '', cleaned.length > 0 ? cleaned : [''])
                                                            }}
                                                            title="Add an additional exam period with one or many program targets"
                                                        >
                                                            Add Period
                                                        </button>
                                                    )}
                                                </>
                                            ) : (
                                                <button className="btn btn-primary btn-sm" onClick={() => assignSubject(s.subject_code, showAssign.periodId, 'move')}>
                                                    Assign
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Import Schedule Modal */}
            {showImport && (
                <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowImport(false) }}>
                    <div className="modal">
                        <div className="modal-header">
                            <h3 className="modal-title">Import Schedule from Excel/CSV</h3>
                            <button className="btn-icon" onClick={() => setShowImport(false)}>{icons.close}</button>
                        </div>
                        <div className="modal-body">
                            <div className="flex items-center justify-between mb-md">
                                <p className="text-sm text-muted" style={{ margin: 0 }}>
                                    Columns: <code>subject_code</code>, <code>exam_date</code> (DD/MM/YYYY or YYYY-MM-DD), <code>start_time</code> (HH:MM), <code>end_time</code> (HH:MM)
                                </p>
                                <button className="btn btn-secondary btn-sm" onClick={downloadScheduleTemplate} style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
                                    {icons.download} <span>Download Template</span>
                                </button>
                            </div>
                            <div className="file-upload-zone" onClick={() => fileRef.current?.click()}>
                                <div className="file-upload-icon">{icons.upload}</div>
                                <div className="file-upload-text">Click to upload <strong>Excel/CSV</strong> file</div>
                            </div>
                            <input type="file" ref={fileRef} accept=".xlsx,.xls,.csv" onChange={handleImportSchedule} style={{ display: 'none' }} />
                        </div>
                    </div>
                </div>
            )}
            {/* Manage Periods Modal */}
            {showManage && (
                <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) { setShowManage(false); setEditingPeriod(null) } }}>
                    <div className="modal modal-lg">
                        <div className="modal-header">
                            <h3 className="modal-title">Manage Exam Periods ({periods.length})</h3>
                            <button className="btn-icon" onClick={() => { setShowManage(false); setEditingPeriod(null) }}>{icons.close}</button>
                        </div>
                        <div className="modal-body" style={{ padding: 0 }}>
                            <table className="data-table">
                                <thead>
                                    <tr>
                                        <th>Date</th>
                                        <th>Start Time</th>
                                        <th>End Time</th>
                                        <th style={{ minWidth: 250 }}>Capacity Limits</th>
                                        <th style={{ width: 80 }}>Subjects</th>
                                        <th style={{ width: 100 }}>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {/* Sort periods by date then start time */}
                                    {[...periods].sort((a, b) => a.exam_date.localeCompare(b.exam_date) || a.start_time.localeCompare(b.start_time)).map(p => {
                                        const isEditing = editingPeriod?.id === p.id
                                        const subjectCount = schedule.filter(s => s.exam_period_id === p.id).length
                                        const row = isEditing ? editingPeriod : p
                                        return (
                                            <tr key={p.id}>
                                                <td>
                                                    {isEditing
                                                        ? <DateInput  className="form-input" value={row.exam_date}
                                                            onChange={e => setEditingPeriod({ ...row, exam_date: e.target.value })} />
                                                        : <strong>{formatExamDateDisplay(p.exam_date)}</strong>
                                                    }
                                                </td>
                                                <td>
                                                    {isEditing
                                                        ? <input type="time" className="form-input" value={row.start_time}
                                                            onChange={e => setEditingPeriod({ ...row, start_time: e.target.value })} />
                                                        : p.start_time
                                                    }
                                                </td>
                                                <td>
                                                    {isEditing
                                                        ? <input type="time" className="form-input" value={row.end_time}
                                                            onChange={e => setEditingPeriod({ ...row, end_time: e.target.value })} />
                                                        : p.end_time
                                                    }
                                                </td>
                                                <td>{isEditing ? <CapacityInputs value={row} onChange={setEditingPeriod} /> : <CapacitySummary value={p} />}</td>
                                                <td style={{ textAlign: 'center' }}>
                                                    {subjectCount > 0 && <span className="badge badge-scheduled">{subjectCount}</span>}
                                                </td>
                                                <td>
                                                    <div className="flex gap-sm">
                                                        {isEditing ? (
                                                            <>
                                                                <button className="btn btn-primary btn-sm" onClick={() => handleSavePeriod(editingPeriod)}>{icons.check}</button>
                                                                <button className="btn btn-secondary btn-sm" onClick={() => setEditingPeriod(null)}>{icons.close}</button>
                                                            </>
                                                        ) : (
                                                            <>
                                                                <button className="btn btn-ghost btn-sm" title="Edit" onClick={() => setEditingPeriod({ ...p })}>{icons.audit}</button>
                                                                <button className="btn btn-ghost btn-sm" title="Delete" onClick={() => handleDeletePeriod(p.id)}>{icons.trash}</button>
                                                            </>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        )
                                    })}

                                    {/* Add new period row */}
                                    <tr style={{ background: 'var(--bg-surface)' }}>
                                        <td>
                                            <DateInput  className="form-input" value={newPeriodRow.exam_date}
                                                onChange={e => setNewPeriodRow(r => ({ ...r, exam_date: e.target.value }))} />
                                        </td>
                                        <td>
                                            <input type="time" className="form-input" value={newPeriodRow.start_time}
                                                onChange={e => setNewPeriodRow(r => ({ ...r, start_time: e.target.value }))} />
                                        </td>
                                        <td>
                                            <input type="time" className="form-input" value={newPeriodRow.end_time}
                                                onChange={e => setNewPeriodRow(r => ({ ...r, end_time: e.target.value }))} />
                                        </td>
                                        <td><CapacityInputs value={newPeriodRow} onChange={setNewPeriodRow} /></td>
                                        <td />
                                        <td>
                                            <button className="btn btn-primary btn-sm" onClick={handleAddPeriodRow}>{icons.plus} Add</button>
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                        <div className="modal-footer schedule-manage-footer">
                            <a className="btn btn-secondary btn-sm" href="/slots">Set limits for selected slots</a>
                            <div className="schedule-manage-actions">
                                <button className="btn btn-danger btn-sm" onClick={async () => {
                                    if (!confirm('Delete ALL periods? This will also unschedule all subjects.')) return
                                    await api.deleteAllPeriods()
                                    addToast('All periods deleted', 'success')
                                    setShowManage(false)
                                    loadAll()
                                }}>{icons.trash} Delete All Periods</button>
                                <button className="btn btn-secondary" onClick={() => { setShowManage(false); setEditingPeriod(null) }}>Close</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Confirm Clear Schedule Modal */}
            {confirmClear && (
                <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setConfirmClear(false) }}>
                    <div className="modal" style={{ maxWidth: 420 }}>
                        <div className="modal-body">
                            <div className="confirm-dialog">
                                <div className="confirm-icon danger">{icons.trash}</div>
                                <h3 className="confirm-title">Clear All Schedule?</h3>
                                <p className="confirm-message">
                                    This will unschedule <strong>all {schedule.length} assigned subjects</strong> and reset
                                    their status to <em>Unscheduled</em>. Exam periods will remain intact.
                                    This action cannot be undone.
                                </p>
                                <div className="confirm-actions">
                                    <button className="btn btn-secondary" onClick={() => setConfirmClear(false)}>Cancel</button>
                                    <button className="btn btn-danger" onClick={handleClearAll}>Yes, Clear All</button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

