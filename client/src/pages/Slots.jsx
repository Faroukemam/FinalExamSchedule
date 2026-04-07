import { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { api } from '../api'
import { icons, useToast } from '../App'
import { downloadExcelFromBackend } from '../utils/export'
import { formatExamDateDisplay, sortRowsByDate } from '../utils/date'

function normalizeCapValue(value) {
    if (value === '' || value === null || value === undefined) return ''
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? String(Math.round(parsed)) : ''
}

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
    const [allCap, setAllCap] = useState('')
    const [newRow, setNewRow] = useState({ exam_date: '', start_time: '09:00', end_time: '11:00', student_cap: '' })
    const [editingId, setEditingId] = useState(null)
    const [editingRow, setEditingRow] = useState(null)

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
                student_cap: normalizeCapValue(row.student_cap)
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
                student_cap: normalizeCapValue(newRow.student_cap)
            })
            addToast('Slot added', 'success')
            setNewRow({ exam_date: '', start_time: '09:00', end_time: '11:00', student_cap: '' })
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

    async function handleApplyCapToAll(clearCap = false) {
        try {
            await api.setAllPeriodsCap(clearCap ? '' : allCap)
            addToast(clearCap ? 'All slots set to open cap' : 'Applied cap to all slots', 'success')
            if (clearCap) setAllCap('')
            loadData()
        } catch (err) {
            addToast(err.message, 'error')
        }
    }

    async function handleImport(e) {
        const file = e.target.files?.[0]
        if (!file) return
        try {
            const buffer = await file.arrayBuffer()
            const wb = XLSX.read(buffer, { type: 'array' })
            const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]])
            const result = await api.importPeriods(data)
            addToast(`Imported ${result.imported} slots, updated ${result.updated}`, 'success')
            loadData()
        } catch (err) {
            addToast(err.message, 'error')
        }
        if (fileRef.current) fileRef.current.value = ''
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
                Student_Cap: period.student_cap || '',
                Cap_Status: period.student_cap ? 'Capped' : 'Open',
                Assigned_Subjects: schedule.filter(row => row.exam_period_id === period.id).length
            })))
        downloadExcelFromBackend('slots_and_caps.xlsx', 'Slots', rows)
        addToast('Exported slots_and_caps.xlsx', 'success')
    }

    function downloadTemplate() {
        downloadExcelFromBackend('slots_import_template.xlsx', 'Slots Template', [
            { exam_date: '2026/10/05', start_time: '09:00', end_time: '11:00', student_cap: 250 },
            { exam_date: '2026/10/05', start_time: '12:00', end_time: '14:00', student_cap: '' },
            { exam_date: '2026/11/05', start_time: '09:00', end_time: '12:00', student_cap: 300 }
        ])
        addToast('Template downloaded', 'success')
    }

    const stats = useMemo(() => {
        const total = periods.length
        const capped = periods.filter(period => Number(period.student_cap) > 0).length
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
                            <input
                                className="form-input"
                                type="number"
                                min="1"
                                placeholder="Cap for all slots"
                                value={allCap}
                                onChange={e => setAllCap(e.target.value)}
                            />
                            <button className="btn btn-secondary" onClick={() => handleApplyCapToAll(false)}>Apply Cap To All</button>
                            <button className="btn btn-secondary" onClick={() => handleApplyCapToAll(true)}>Clear To Open</button>
                        </div>
                        <div className="slots-action-group">
                            <button className="btn btn-secondary" onClick={downloadTemplate}>{icons.download} <span>Template</span></button>
                            <button className="btn btn-secondary" onClick={() => fileRef.current?.click()}>{icons.upload} <span>Import</span></button>
                            <button className="btn btn-primary" onClick={exportSlots}>{icons.download} <span>Export</span></button>
                        </div>
                        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleImport} style={{ display: 'none' }} />
                    </div>
                </div>
                <div className="slots-hero-note">
                    Dates are shown as <strong>YYYY/DD/MM</strong>. Empty cap means the slot stays open.
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

            <div className="panel slots-panel">
                <div className="panel-header slots-panel-header">
                    <div>
                        <h3 className="panel-title">Slot Register</h3>
                        <p className="section-subtitle">Each row is a schedulable period. Leave cap empty to keep the slot open.</p>
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
                                    <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
                                </th>
                                <th>Date</th>
                                <th>Start</th>
                                <th>End</th>
                                <th>Duration</th>
                                <th>Cap</th>
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
                                                    checked={selectedIds.includes(period.id)}
                                                    onChange={() => toggleRowSelection(period.id)}
                                                    disabled={isEditing}
                                                />
                                            </td>
                                            <td>{isEditing ? <input className="form-input" type="date" value={row.exam_date} onChange={e => setEditingRow({ ...row, exam_date: e.target.value })} /> : formatExamDateDisplay(period.exam_date)}</td>
                                            <td>{isEditing ? <input className="form-input" type="time" value={row.start_time} onChange={e => setEditingRow({ ...row, start_time: e.target.value })} /> : period.start_time}</td>
                                            <td>{isEditing ? <input className="form-input" type="time" value={row.end_time} onChange={e => setEditingRow({ ...row, end_time: e.target.value })} /> : period.end_time}</td>
                                            <td><span className="slots-duration-pill">{durationText(row.start_time, row.end_time)}</span></td>
                                            <td>{isEditing ? <input className="form-input" type="number" min="1" placeholder="Open" value={row.student_cap ?? ''} onChange={e => setEditingRow({ ...row, student_cap: e.target.value })} /> : (period.student_cap || <span className="text-muted">Open</span>)}</td>
                                            <td><span className={`badge ${period.student_cap ? 'badge-scheduled' : 'badge-unscheduled'}`}>{period.student_cap ? 'Capped' : 'Open'}</span></td>
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
                                                            <button className="btn btn-ghost btn-sm" onClick={() => { setEditingId(period.id); setEditingRow({ ...period, student_cap: period.student_cap ?? '' }) }}>{icons.audit}</button>
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
                                <td><input className="form-input" type="date" value={newRow.exam_date} onChange={e => setNewRow({ ...newRow, exam_date: e.target.value })} /></td>
                                <td><input className="form-input" type="time" value={newRow.start_time} onChange={e => setNewRow({ ...newRow, start_time: e.target.value })} /></td>
                                <td><input className="form-input" type="time" value={newRow.end_time} onChange={e => setNewRow({ ...newRow, end_time: e.target.value })} /></td>
                                <td><span className="slots-duration-pill">{durationText(newRow.start_time, newRow.end_time)}</span></td>
                                <td><input className="form-input" type="number" min="1" placeholder="Open" value={newRow.student_cap} onChange={e => setNewRow({ ...newRow, student_cap: e.target.value })} /></td>
                                <td><span className={`badge ${newRow.student_cap ? 'badge-scheduled' : 'badge-unscheduled'}`}>{newRow.student_cap ? 'Capped' : 'Open'}</span></td>
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
