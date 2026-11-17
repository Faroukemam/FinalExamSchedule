import DateInput from '../components/DateInput'
import { useEffect, useMemo, useRef, useState } from 'react'
import { readSlotWorkbook, slotImportFeedback } from '../utils/slotImport'
import { api } from '../api'
import CapacityInputs, { CapacitySummary } from '../components/CapacityInputs'
import { icons, useToast } from '../App'
import { downloadExcelFromBackend } from '../utils/export'
import { formatExamDateDisplay, sortRowsByDate } from '../utils/date'

function durationText(start, end) {
    try {
        const [sh, sm] = String(start || '00:00').split(':').map(Number)
        const [eh, em] = String(end || '00:00').split(':').map(Number)
        let minutes = ((eh * 60) + em) - ((sh * 60) + sm)
        if (minutes < 0) minutes += 24 * 60
        const hours = minutes / 60
        return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hrs`
    } catch {
        return ''
    }
}

export default function Slots() {
    const addToast = useToast()
    const fileRef = useRef()
    const [loading, setLoading] = useState(true)
    const [periods, setPeriods] = useState([])
    const [schedule, setSchedule] = useState([])
    const [selectedIds, setSelectedIds] = useState([])
    const [fieldsToApply, setFieldsToApply] = useState({ major: false, minor: false, subject: true })
    const [selectedCaps, setSelectedCaps] = useState({ major_cap: '', minor_cap: '', subject_cap: '' })
    const [newRow, setNewRow] = useState({ exam_date: '', start_time: '09:00', end_time: '11:00', major_cap: '', minor_cap: '', subject_cap: '' })
    const [editingId, setEditingId] = useState(null)
    const [editingRow, setEditingRow] = useState(null)
    const [importing, setImporting] = useState(false)
    const [importResult, setImportResult] = useState(null)

    useEffect(() => { loadData() }, [])

    async function loadData() {
        setLoading(true)
        try {
            const [periodRows, scheduleRows] = await Promise.all([api.getPeriods(), api.getSchedule()])
            setPeriods(periodRows)
            setSchedule(scheduleRows)
            setSelectedIds(prev => prev.filter(id => periodRows.some(period => period.id === id)))
        } catch (err) {
            addToast('Failed to load slots', 'error')
        }
        setLoading(false)
    }

    async function handleSaveRow(row) {
        try {
            await api.updatePeriod(row.id, {
                exam_date: row.exam_date,
                start_time: row.start_time,
                end_time: row.end_time,
                major_cap: row.major_cap ?? '',
                minor_cap: row.minor_cap ?? '',
                subject_cap: row.subject_cap ?? ''
            })
            addToast('Slot updated', 'success')
            setEditingId(null)
            setEditingRow(null)
            loadData()
        } catch (err) {
            addToast(err.message, 'error')
        }
    }

    async function handleAddRow() {
        try {
            await api.createPeriod({
                exam_date: newRow.exam_date,
                start_time: newRow.start_time,
                end_time: newRow.end_time,
                major_cap: newRow.major_cap ?? '',
                minor_cap: newRow.minor_cap ?? '',
                subject_cap: newRow.subject_cap ?? ''
            })
            addToast('Slot added', 'success')
            setNewRow({ exam_date: '', start_time: '09:00', end_time: '11:00', major_cap: '', minor_cap: '', subject_cap: '' })
            loadData()
        } catch (err) {
            addToast(err.message, 'error')
        }
    }

    async function handleDeleteRow(id) {
        if (!confirm('Delete this slot? Assigned subjects in this slot will be unscheduled.')) return
        try {
            await api.deletePeriod(id)
            addToast('Slot deleted', 'success')
            loadData()
        } catch (err) {
            addToast(err.message, 'error')
        }
    }

    async function handleDeleteSelected() {
        if (selectedIds.length < 2) return
        if (!confirm(`Delete ${selectedIds.length} selected slots? Assigned subjects in those slots will be unscheduled.`)) return
        try {
            await Promise.all(selectedIds.map(id => api.deletePeriod(id)))
            addToast(`Deleted ${selectedIds.length} slots`, 'success')
            setSelectedIds([])
            loadData()
        } catch (err) {
            addToast(err.message, 'error')
        }
    }

    async function handleApplySelectedCaps(clearCap = false) {
        try {
            const caps = Object.fromEntries(['major', 'minor', 'subject'].filter(type => fieldsToApply[type]).map(type => [`${type}_cap`, clearCap ? '' : selectedCaps[`${type}_cap`]]))
            await api.setPeriodsCaps(selectedIds, caps)
            addToast(`Updated limits for ${selectedIds.length} selected slots`, 'success')
            if (clearCap) setSelectedCaps({ major_cap: '', minor_cap: '', subject_cap: '' })
            loadData()
        } catch (err) {
            addToast(err.message, 'error')
        }
    }

    async function handleImport(e) {
        const file = e.target.files?.[0]
        if (!file) return
        setImporting(true)
        setImportResult(null)
        try {
            const buffer = await file.arrayBuffer()
            const { data, date1904 } = readSlotWorkbook(buffer)
            const result = await api.importPeriods(data, date1904)
            setImportResult(result)
            const feedback = slotImportFeedback(result)
            addToast(feedback.message, feedback.type)
            if (result.success) await loadData()
        } catch (err) {
            setImportResult({ success: false, imported: 0, updated: 0, failed: 0, errors: [err.message] })
            addToast(err.message, 'error')
        } finally {
            setImporting(false)
            if (fileRef.current) fileRef.current.value = ''
        }
    }

    function exportSlots() {
        const rows = sortRowsByDate(periods
            .slice()
            .sort((a, b) => a.exam_date.localeCompare(b.exam_date) || a.start_time.localeCompare(b.start_time))
            .map(period => ({
                Exam_Date: formatExamDateDisplay(period.exam_date),
                Start_Time: period.start_time,
                End_Time: period.end_time,
                Duration: durationText(period.start_time, period.end_time),
                Major_Cap: period.major_cap ?? '',
                Minor_Cap: period.minor_cap ?? '',
                Subject_Cap: period.subject_cap ?? '',
                Major_Students: usageByPeriod[period.id]?.major || 0,
                Minor_Students: usageByPeriod[period.id]?.minor || 0,
                Assigned_Subjects: schedule.filter(row => row.exam_period_id === period.id).length
            })))
        downloadExcelFromBackend('slots_and_caps.xlsx', 'Slots', rows)
        addToast('Exported slots_and_caps.xlsx', 'success')
    }

    function downloadTemplate() {
        downloadExcelFromBackend('slots_import_template.xlsx', 'Slots Template', [
            { exam_date: '10/05/2026', start_time: '09:00', end_time: '11:00', major_cap: 250, minor_cap: 100, subject_cap: 100 },
            { exam_date: '10/05/2026', start_time: '12:00', end_time: '14:00', major_cap: '', minor_cap: '', subject_cap: '' },
            { exam_date: '11/05/2026', start_time: '09:00', end_time: '12:00', major_cap: 300, minor_cap: 150, subject_cap: 120 }
        ])
        addToast('Template downloaded', 'success')
    }

    const usageByPeriod = useMemo(() => {
        const usage = {}
        for (const row of schedule) {
            const counts = usage[row.exam_period_id] ||= { major: 0, minor: 0 }
            counts[row.capacity_pool || 'major'] += Number(row.student_count) || 0
        }
        return usage
    }, [schedule])

    const stats = useMemo(() => {
        const total = periods.length
        const capped = periods.filter(period => period.major_cap !== null || period.minor_cap !== null || period.subject_cap !== null).length
        const open = total - capped
        return { total, capped, open }
    }, [periods])
    const sortedPeriods = useMemo(
        () => periods.slice().sort((a, b) => a.exam_date.localeCompare(b.exam_date) || a.start_time.localeCompare(b.start_time)),
        [periods]
    )
    const allSelected = sortedPeriods.length > 0 && selectedIds.length === sortedPeriods.length

    function toggleRowSelection(id) {
        setSelectedIds(prev => prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id])
    }

    function toggleSelectAll() {
        setSelectedIds(allSelected ? [] : sortedPeriods.map(period => period.id))
    }

    if (loading) return <div className="text-center mt-lg"><div className="spinner" style={{ margin: '40px auto' }}></div></div>

    return (
        <div className="slots-shell">
            <div className="card slots-hero mb-lg">
                <div className="slots-hero-head">
                    <div className="slots-hero-copy">
                        <div className="slots-hero-kicker">Slot Planning</div>
                        <h2 className="section-title">Slots And Caps</h2>
                        <p className="section-subtitle">Manage exam slots, import and export slot registers, and keep capacity rules consistent before auto-scheduling.</p>
                    </div>
                    <div className="slots-toolbar">
                        <div className="slots-cap-group">
                            <CapacityInputs value={selectedCaps} onChange={setSelectedCaps} fieldsToApply={fieldsToApply} onFieldsToApplyChange={setFieldsToApply} />
                            <button className="btn btn-secondary" disabled={!selectedIds.length || !Object.values(fieldsToApply).some(Boolean)} onClick={() => handleApplySelectedCaps(false)}>Apply Limits To Selected ({selectedIds.length})</button>
                            <button className="btn btn-secondary" disabled={!selectedIds.length || !Object.values(fieldsToApply).some(Boolean)} onClick={() => handleApplySelectedCaps(true)}>Clear Selected Limits</button>
                        </div>
                        <div className="slots-action-group">
                            <button className="btn btn-secondary" onClick={downloadTemplate}>{icons.download} <span>Template</span></button>
                            <button className="btn btn-secondary" disabled={importing} onClick={() => fileRef.current?.click()}>{icons.upload} <span>{importing ? 'Importing…' : 'Import'}</span></button>
                            <button className="btn btn-primary" onClick={exportSlots}>{icons.download} <span>Export</span></button>
                        </div>
                        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleImport} style={{ display: 'none' }} />
                    </div>
                </div>
                <div className="slots-hero-note">
                    Dates are shown as <strong>DD/MM/YYYY</strong>. Select slots using the checkboxes, choose which limits to update, then apply. Subjects use Major capacity first, then Minor as needed. Each subject must fit entirely in one pool and within the per-subject limit. Blank means unlimited; zero prevents student assignments.
                </div>
                <div className="slots-kpi-strip">
                    <div className="slots-kpi-card">
                        <span>Total Slots</span>
                        <strong>{stats.total}</strong>
                    </div>
                    <div className="slots-kpi-card success">
                        <span>Capped Slots</span>
                        <strong>{stats.capped}</strong>
                    </div>
                    <div className="slots-kpi-card warning">
                        <span>Open Slots</span>
                        <strong>{stats.open}</strong>
                    </div>
                </div>
            </div>

            {importResult && (
                <div className="card mb-lg" role="status">
                    <div className="flex items-center justify-between">
                        <strong>{slotImportFeedback(importResult).message}</strong>
                        <button className="btn btn-ghost btn-sm" aria-label="Dismiss import results" onClick={() => setImportResult(null)}>{icons.close}</button>
                    </div>
                    {(importResult.errors || []).map((error, index) => <div className="text-sm" key={index} style={{ marginTop: 8 }}>{error}</div>)}
                    {importResult.failed > (importResult.errors?.length || 0) && <p className="text-sm">Showing the first {importResult.errors.length} errors of {importResult.failed} rejected rows.</p>}
                </div>
            )}
            <div className="panel slots-panel">
                <div className="panel-header slots-panel-header">
                    <div>
                        <h3 className="panel-title">Slot Register</h3>
                        <p className="section-subtitle">Each row is a schedulable period. Assigned students / capacity are shown for each pool, chosen automatically.</p>
                    </div>
                    <div className="slots-register-meta">
                        <span className="slots-meta-pill">Sorted by date</span>
                        <span className="slots-meta-pill">Then by start time</span>
                        {selectedIds.length > 0 && <span className="slots-meta-pill">{selectedIds.length} selected</span>}
                        {selectedIds.length >= 2 && (
                            <button className="btn btn-danger btn-sm" onClick={handleDeleteSelected}>
                                {icons.trash} <span>Delete Selected</span>
                            </button>
                        )}
                    </div>
                </div>
                <div className="slots-table-wrap">
                    <table className="data-table slots-table">
                        <thead>
                            <tr>
                                <th>
                                    <input type="checkbox" aria-label="Select all slots" checked={allSelected} onChange={toggleSelectAll} />
                                </th>
                                <th>Date</th>
                                <th>Start</th>
                                <th>End</th>
                                <th>Duration</th>
                                <th>Students / Caps</th>
                                <th>Status</th>
                                <th>Assigned</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {sortedPeriods.map(period => {
                                    const row = editingId === period.id ? editingRow : period
                                    const assignedCount = schedule.filter(row => row.exam_period_id === period.id).length
                                    const isEditing = editingId === period.id
                                    return (
                                        <tr key={period.id} className="slots-table-row">
                                            <td>
                                                <input
                                                    type="checkbox"
                                                    aria-label={`Select slot ${formatExamDateDisplay(period.exam_date)} ${period.start_time}`}
                                                    checked={selectedIds.includes(period.id)}
                                                    onChange={() => toggleRowSelection(period.id)}
                                                    disabled={isEditing}
                                                />
                                            </td>
                                            <td>{isEditing ? <DateInput className="form-input"  value={row.exam_date} onChange={e => setEditingRow({ ...row, exam_date: e.target.value })} /> : formatExamDateDisplay(period.exam_date)}</td>
                                            <td>{isEditing ? <input className="form-input" type="time" value={row.start_time} onChange={e => setEditingRow({ ...row, start_time: e.target.value })} /> : period.start_time}</td>
                                            <td>{isEditing ? <input className="form-input" type="time" value={row.end_time} onChange={e => setEditingRow({ ...row, end_time: e.target.value })} /> : period.end_time}</td>
                                            <td><span className="slots-duration-pill">{durationText(row.start_time, row.end_time)}</span></td>
                                            <td>{isEditing ? <CapacityInputs value={row} onChange={setEditingRow} /> : <CapacitySummary value={period} usage={usageByPeriod[period.id] || { major: 0, minor: 0 }} />}</td>
                                            <td><span className="badge badge-scheduled">{period.major_cap !== null || period.minor_cap !== null || period.subject_cap !== null ? 'Capped' : 'Open'}</span></td>
                                            <td><span className="slots-assigned-count">{assignedCount}</span></td>
                                            <td>
                                                <div className="slots-row-actions">
                                                    {isEditing ? (
                                                        <>
                                                            <button className="btn btn-primary btn-sm" onClick={() => handleSaveRow(editingRow)}>{icons.check}</button>
                                                            <button className="btn btn-secondary btn-sm" onClick={() => { setEditingId(null); setEditingRow(null) }}>{icons.close}</button>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <button className="btn btn-ghost btn-sm" onClick={() => { setEditingId(period.id); setEditingRow({ ...period }) }}>{icons.audit}</button>
                                                            <button className="btn btn-ghost btn-sm" onClick={() => handleDeleteRow(period.id)}>{icons.trash}</button>
                                                        </>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    )
                                })}
                            <tr className="slots-new-row">
                                <td></td>
                                <td><DateInput className="form-input"  value={newRow.exam_date} onChange={e => setNewRow({ ...newRow, exam_date: e.target.value })} /></td>
                                <td><input className="form-input" type="time" value={newRow.start_time} onChange={e => setNewRow({ ...newRow, start_time: e.target.value })} /></td>
                                <td><input className="form-input" type="time" value={newRow.end_time} onChange={e => setNewRow({ ...newRow, end_time: e.target.value })} /></td>
                                <td><span className="slots-duration-pill">{durationText(newRow.start_time, newRow.end_time)}</span></td>
                                <td><CapacityInputs value={newRow} onChange={setNewRow} /></td>
                                <td><span className="badge badge-unscheduled">New</span></td>
                                <td><span className="slots-assigned-count">-</span></td>
                                <td><button className="btn btn-primary btn-sm" onClick={handleAddRow}>{icons.plus} Add</button></td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    )
}
