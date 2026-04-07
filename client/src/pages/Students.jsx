import { useState, useEffect, useRef } from 'react'
import { api } from '../api'
import { icons, useToast } from '../App'
import * as XLSX from 'xlsx'

import { downloadExcelFromBackend } from '../utils/export';

export default function Students() {
    const [students, setStudents] = useState([])
    const [search, setSearch] = useState('')
    const [loading, setLoading] = useState(true)
    const [showImport, setShowImport] = useState(false)
    const [importing, setImporting] = useState(false)
    const [page, setPage] = useState(1)
    const [filters, setFilters] = useState({ department: '', level: '' })
    const fileRef = useRef()
    const addToast = useToast()
    const perPage = 20

    useEffect(() => { loadStudents() }, [search, filters])

    async function loadStudents() {
        setLoading(true)
        try {
            const params = { search }
            if (filters.department) params.department = filters.department
            if (filters.level) params.level = filters.level
            const data = await api.getStudents(params)
            setStudents(data)
            setPage(1)
        } catch (err) {
            addToast('Failed to load students', 'error')
        }
        setLoading(false)
    }

    async function handleFileImport(e) {
        const file = e.target.files?.[0]
        if (!file) return
        setImporting(true)
        try {
            const buffer = await file.arrayBuffer()
            const wb = XLSX.read(buffer, { type: 'array' })
            const ws = wb.Sheets[wb.SheetNames[0]]
            const data = XLSX.utils.sheet_to_json(ws)

            if (data.length === 0) {
                addToast('No data found in file', 'warning')
                setImporting(false)
                return
            }

            const result = await api.importStudents(data)
            addToast(`Imported ${result.studentsImported} students, ${result.registrationsImported} registrations`, 'success')
            if (result.totalErrors > 0) {
                addToast(`${result.totalErrors} rows had errors`, 'warning')
            }
            setShowImport(false)
            loadStudents()
        } catch (err) {
            addToast('Import failed: ' + err.message, 'error')
        }
        setImporting(false)
        if (fileRef.current) fileRef.current.value = ''
    }

    async function handleDeleteAll() {
        if (!confirm('Delete ALL students and registrations? This cannot be undone.')) return
        try {
            await api.deleteAllStudents()
            addToast('All students deleted', 'success')
            loadStudents()
        } catch (err) {
            addToast('Error: ' + err.message, 'error')
        }
    }

    function exportStudents() {
        const exportData = students.map(s => ({
            Student_ID: s.student_id,
            Name: s.student_name,
            Department: s.department,
            Program: s.program,
            Level: s.level,
            Section: s.section,
            Courses: s.courses || ''
        }))
        downloadExcelFromBackend('students_export.xlsx', 'Students', exportData);
        addToast('Exported to students_export.xlsx', 'success')
    }

    function downloadStudentsTemplate() {
        const template = [
            {
                student_id: 'STU00001',
                student_name: 'Ahmed Al-Rashid',
                courses: 'CSE565-4643, CSE575-4640, CSE580-1234',
                department: 'Computer Science',
                program: 'BSc Computer Science',
                level: 'Level 3',
                section: 'A'
            },
            {
                student_id: 'STU00002',
                student_name: 'Sara Mohamed',
                courses: 'CSE560-2211, CSE570-3302',
                department: 'Computer Science',
                program: 'BSc Computer Science',
                level: 'Level 2',
                section: 'B'
            }
        ]
        downloadExcelFromBackend('students_import_template.xlsx', 'Students Template', template);
        addToast('Template downloaded', 'success')
    }

    const totalPages = Math.ceil(students.length / perPage)
    const paginated = students.slice((page - 1) * perPage, page * perPage)

    const departments = [...new Set(students.map(s => s.department).filter(Boolean))]
    const levels = [...new Set(students.map(s => s.level).filter(Boolean))]

    return (
        <div>
            <div className="section-header">
                <div>
                    <h2 className="section-title">Students</h2>
                    <p className="section-subtitle">{students.length} registered students</p>
                </div>
                <div className="flex gap-sm">
                    <button className="btn btn-primary" onClick={() => setShowImport(!showImport)}>
                        {icons.upload} <span>Import</span>
                    </button>
                    <button className="btn btn-secondary" onClick={exportStudents}>
                        {icons.download} <span>Export</span>
                    </button>
                    <button className="btn btn-danger btn-sm" onClick={handleDeleteAll}>
                        {icons.trash}
                    </button>
                </div>
            </div>

            {showImport && (
                <div className="card mb-lg">
                    <div className="flex items-center justify-between mb-md">
                        <p className="text-sm text-muted" style={{ margin: 0 }}>
                            Upload <strong>Excel/CSV</strong> — columns: <code>student_id</code>, <code>student_name</code>, <code>courses</code> (comma-separated CRNs), <code>department</code>, <code>program</code>, <code>level</code>, <code>section</code>
                        </p>
                        <button className="btn btn-secondary btn-sm" onClick={downloadStudentsTemplate} style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
                            {icons.download} <span>Download Template</span>
                        </button>
                    </div>
                    <div className="file-upload-zone" onClick={() => fileRef.current?.click()}>
                        <div className="file-upload-icon">{icons.upload}</div>
                        <div className="file-upload-text">
                            {importing ? (
                                <><div className="spinner" style={{ margin: '0 auto 8px' }}></div>Processing...</>
                            ) : (
                                <>Click to upload or drag <strong>Excel/CSV</strong> file</>
                            )}
                        </div>
                    </div>
                    <input type="file" ref={fileRef} accept=".xlsx,.xls,.csv" onChange={handleFileImport} style={{ display: 'none' }} />
                </div>
            )}

            <div className="table-container">
                <div className="table-toolbar">
                    <div className="table-toolbar-left">
                        <div className="search-wrapper">
                            {icons.search}
                            <input className="table-search" placeholder="Search by ID or name..."
                                value={search} onChange={e => setSearch(e.target.value)} />
                        </div>
                        <select className="form-select" style={{ width: 'auto', padding: '7px 10px', fontSize: '0.8rem' }}
                            value={filters.department} onChange={e => setFilters(f => ({ ...f, department: e.target.value }))}>
                            <option value="">All Departments</option>
                            {departments.map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                        <select className="form-select" style={{ width: 'auto', padding: '7px 10px', fontSize: '0.8rem' }}
                            value={filters.level} onChange={e => setFilters(f => ({ ...f, level: e.target.value }))}>
                            <option value="">All Levels</option>
                            {levels.map(l => <option key={l} value={l}>{l}</option>)}
                        </select>
                    </div>
                </div>

                {loading ? (
                    <div className="text-center" style={{ padding: 40 }}><div className="spinner" style={{ margin: '0 auto' }}></div></div>
                ) : (
                    <>
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>Student ID</th>
                                    <th>Name</th>
                                    <th>Department</th>
                                    <th>Program</th>
                                    <th>Level</th>
                                    <th>Section</th>
                                    <th>Courses</th>
                                </tr>
                            </thead>
                            <tbody>
                                {paginated.length === 0 ? (
                                    <tr><td colSpan="7" className="text-center text-muted" style={{ padding: 40 }}>No students found</td></tr>
                                ) : paginated.map(s => (
                                    <tr key={s.student_id}>
                                        <td><strong>{s.student_id}</strong></td>
                                        <td>{s.student_name}</td>
                                        <td>{s.department}</td>
                                        <td>{s.program}</td>
                                        <td><span className="badge badge-unscheduled">{s.level}</span></td>
                                        <td>{s.section}</td>
                                        <td>
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                                {(s.courses || '').split(',').filter(Boolean).map(c => (
                                                    <span key={c} className="subject-chip">{c}</span>
                                                ))}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>

                        {totalPages > 1 && (
                            <div className="table-pagination">
                                <span>Showing {(page - 1) * perPage + 1}-{Math.min(page * perPage, students.length)} of {students.length}</span>
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
