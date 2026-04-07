import { useState, useEffect } from 'react'
import { api } from '../api'
import { icons, useToast } from '../App'
import * as XLSX from 'xlsx'

import { downloadExcelFromBackend } from '../utils/export';
import { formatExamDateDisplay, sortRowsByDate } from '../utils/date'

export default function Conflicts() {
    const [data, setData] = useState({ conflicts: [], summary: {} })
    const [loading, setLoading] = useState(true)
    const [filters, setFilters] = useState({ student_id: '', subject_code: '', department: '', conflict_type: '', exam_date: '' })
    const [page, setPage] = useState(1)
    const addToast = useToast()
    const perPage = 25

    useEffect(() => { loadConflicts() }, [filters])

    async function loadConflicts() {
        setLoading(true)
        try {
            const params = {}
            Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v })
            const result = await api.getConflicts(params)
            setData(result)
            setPage(1)
        } catch (err) { addToast('Failed to load conflicts', 'error') }
        setLoading(false)
    }

    function exportConflicts() {
        const exportData = sortRowsByDate(data.conflicts.map(c => ({
            Student_ID: c.student_id,
            Student_Name: c.student_name,
            Department: c.department,
            Level: c.level,
            Subjects: c.subject_codes.join(', '),
            Exam_Date: formatExamDateDisplay(c.exam_date),
            Period: c.period_time,
            Conflict_Type: c.conflict_type,
            Notes: c.notes
        })))
        downloadExcelFromBackend('conflict_report.xlsx', 'Conflicts', exportData);
        addToast('Exported to conflict_report.xlsx', 'success')
    }

    const conflictTypeBadge = (type) => {
        const map = {
            same_period: 'badge-same-period',
            overlapping: 'badge-overlapping',
            same_day: 'badge-same-day',
            back_to_back_warning: 'badge-back-to-back',
            back_to_back_conflict: 'badge-same-period',
            consecutive_day: 'badge-consecutive-day'
        }
        return <span className={`badge ${map[type] || ''}`}>{type?.replace(/_/g, ' ')}</span>
    }

    const totalPages = Math.ceil(data.conflicts.length / perPage)
    const paginated = data.conflicts.slice((page - 1) * perPage, page * perPage)

    return (
        <div>
            <div className="section-header">
                <div>
                    <h2 className="section-title">Conflict Detection</h2>
                    <p className="section-subtitle">{data.conflicts.length} conflicts found</p>
                </div>
                <div className="flex gap-sm">
                    <button className="btn btn-secondary" onClick={loadConflicts}>{icons.search} <span>Recheck</span></button>
                    <button className="btn btn-secondary" onClick={exportConflicts}>{icons.download} <span>Export</span></button>
                </div>
            </div>

            {/* Summary cards */}
            <div className="summary-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
                <div className="summary-card danger">
                    <div className="summary-card-value">{data.summary?.total || 0}</div>
                    <div className="summary-card-label">Total Conflicts</div>
                </div>
                <div className="summary-card danger">
                    <div className="summary-card-value">{data.summary?.same_period || 0}</div>
                    <div className="summary-card-label">Same Period</div>
                </div>
                <div className="summary-card warning">
                    <div className="summary-card-value">{data.summary?.overlapping || 0}</div>
                    <div className="summary-card-label">Overlapping</div>
                </div>
                <div className="summary-card warning">
                    <div className="summary-card-value">{data.summary?.same_day || 0}</div>
                    <div className="summary-card-label">Same Day</div>
                </div>
                <div className="summary-card info">
                    <div className="summary-card-value">{data.summary?.back_to_back || 0}</div>
                    <div className="summary-card-label">Back-to-Back</div>
                </div>
                <div className="summary-card info" style={{ borderColor: 'var(--accent-purple-light)' }}>
                    <div className="summary-card-value text-purple">{data.summary?.consecutive_day || 0}</div>
                    <div className="summary-card-label">Consecutive Day</div>
                </div>
            </div>

            {/* Filters */}
            <div className="filter-bar">
                <input className="form-input" style={{ width: 160 }} placeholder="Student ID" value={filters.student_id}
                    onChange={e => setFilters(f => ({ ...f, student_id: e.target.value }))} />
                <input className="form-input" style={{ width: 160 }} placeholder="Subject Code" value={filters.subject_code}
                    onChange={e => setFilters(f => ({ ...f, subject_code: e.target.value }))} />
                <input className="form-input" style={{ width: 160 }} placeholder="Department" value={filters.department}
                    onChange={e => setFilters(f => ({ ...f, department: e.target.value }))} />
                <select className="form-select" style={{ width: 160 }} value={filters.conflict_type}
                    onChange={e => setFilters(f => ({ ...f, conflict_type: e.target.value }))}>
                    <option value="">All Types</option>
                    <option value="same_period">Same Period</option>
                    <option value="overlapping">Overlapping</option>
                    <option value="same_day">Same Day</option>
                    <option value="consecutive_day">Consecutive Day</option>
                    <option value="back_to_back_warning">Back-to-Back Warning</option>
                </select>
                <input className="form-input" style={{ width: 160 }} type="date" value={filters.exam_date}
                    onChange={e => setFilters(f => ({ ...f, exam_date: e.target.value }))} />
                <button className="btn btn-ghost btn-sm" onClick={() => setFilters({ student_id: '', subject_code: '', department: '', conflict_type: '', exam_date: '' })}>
                    Clear
                </button>
            </div>

            {/* Table */}
            <div className="table-container">
                {loading ? (
                    <div className="text-center" style={{ padding: 40 }}><div className="spinner" style={{ margin: '0 auto' }}></div></div>
                ) : (
                    <>
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>Student ID</th><th>Name</th><th>Department</th><th>Level</th>
                                    <th>Subjects</th><th>Date</th><th>Period</th><th>Type</th><th>Notes</th>
                                </tr>
                            </thead>
                            <tbody>
                                {paginated.length === 0 ? (
                                    <tr><td colSpan="9" className="text-center text-muted" style={{ padding: 40 }}>
                                        {data.conflicts.length === 0 ? '✅ No conflicts detected' : 'No matching conflicts'}
                                    </td></tr>
                                ) : paginated.map((c, i) => (
                                    <tr key={i}>
                                        <td><strong>{c.student_id}</strong></td>
                                        <td>{c.student_name}</td>
                                        <td>{c.department}</td>
                                        <td>{c.level}</td>
                                        <td>
                                            <div className="flex gap-sm" style={{ flexWrap: 'wrap' }}>
                                                {c.subject_codes.map(sc => <span key={sc} className="subject-chip conflict">{sc}</span>)}
                                            </div>
                                        </td>
                                        <td>{formatExamDateDisplay(c.exam_date)}</td>
                                        <td style={{ fontSize: '0.75rem' }}>{c.period_time}</td>
                                        <td>{conflictTypeBadge(c.conflict_type)}</td>
                                        <td className="text-sm text-muted">{c.notes}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>

                        {totalPages > 1 && (
                            <div className="table-pagination">
                                <span>Showing {(page - 1) * perPage + 1}-{Math.min(page * perPage, data.conflicts.length)} of {data.conflicts.length}</span>
                                <div className="pagination-btns">
                                    <button className="pagination-btn" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{icons.chevronLeft}</button>
                                    {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                                        const p = page <= 3 ? i + 1 : page - 2 + i
                                        if (p > totalPages) return null
                                        return <button key={p} className={`pagination-btn${p === page ? ' active' : ''}`} onClick={() => setPage(p)}>{p}</button>
                                    })}
                                    <button className="pagination-btn" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>{icons.chevronRight}</button>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    )
}
