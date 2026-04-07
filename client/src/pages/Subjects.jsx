import { useState, useEffect, useRef } from 'react'
import { api } from '../api'
import { icons, useToast } from '../App'
import * as XLSX from 'xlsx'

import { downloadExcelFromBackend } from '../utils/export';

export default function Subjects() {
    const [subjects, setSubjects] = useState([])
    const [samePeriodGroups, setSamePeriodGroups] = useState([])
    const [samePeriodGroupName, setSamePeriodGroupName] = useState('')
    const [selectedGroupSubjects, setSelectedGroupSubjects] = useState([])
    const [search, setSearch] = useState('')
    const [statusFilter, setStatusFilter] = useState('')
    const [loading, setLoading] = useState(true)
    const [editSubject, setEditSubject] = useState(null)
    const [tab, setTab] = useState('all') // all, remaining, no-final
    const [confirmClearSubjects, setConfirmClearSubjects] = useState(false)
    const [showImport, setShowImport] = useState(false)
    const [importing, setImporting] = useState(false)
    const fileRef = useRef()
    const addToast = useToast()

    useEffect(() => { loadSubjects() }, [search, statusFilter])
    useEffect(() => { loadSamePeriodGroups() }, [])

    async function loadSubjects() {
        setLoading(true)
        try {
            const params = {}
            if (search) params.search = search
            if (statusFilter) params.status = statusFilter
            setSubjects(await api.getSubjects(params))
        } catch (err) { addToast('Failed to load subjects', 'error') }
        setLoading(false)
    }

    async function loadSamePeriodGroups() {
        try {
            setSamePeriodGroups(await api.getSamePeriodGroups())
        } catch (err) { addToast('Failed to load same-period groups', 'error') }
    }

    async function updateStatus(code, status) {
        try {
            await api.updateSubject(code, { status })
            addToast(`${code} marked as ${status.replace(/_/g, ' ')}`, 'success')
            loadSubjects()
        } catch (err) { addToast(err.message, 'error') }
    }

    async function saveEdit() {
        if (!editSubject) return
        try {
            await api.updateSubject(editSubject.subject_code, editSubject)
            addToast(`${editSubject.subject_code} updated`, 'success')
            setEditSubject(null)
            loadSubjects()
        } catch (err) { addToast(err.message, 'error') }
    }

    async function handleImport(e) {
        const file = e.target.files?.[0]
        if (!file) return
        setImporting(true)
        try {
            const buffer = await file.arrayBuffer()
            const wb = XLSX.read(buffer, { type: 'array' })
            const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]])
            if (data.length === 0) { addToast('No data found in file', 'warning'); setImporting(false); return }
            const result = await api.importSubjects(data)
            let msg = `Imported ${result.imported} new subjects`
            if (result.updated > 0) msg += `, updated ${result.updated}`
            addToast(msg, 'success')
            if (result.errors?.length) addToast(`${result.errors.length} rows had errors`, 'warning')
            setShowImport(false)
            loadSubjects()
            loadSamePeriodGroups()
        } catch (err) { addToast('Import failed: ' + err.message, 'error') }
        setImporting(false)
        if (fileRef.current) fileRef.current.value = ''
    }

    async function handleClearAllSubjects() {
        try {
            const result = await api.clearAllSubjects()
            addToast(`Cleared ${result.cleared} subjects and all registrations`, 'success')
            setConfirmClearSubjects(false)
            loadSubjects()
            loadSamePeriodGroups()
        } catch (err) { addToast(err.message, 'error') }
    }

    async function createSamePeriodGroup() {
        if (selectedGroupSubjects.length < 2) {
            addToast('Select at least two subjects', 'warning')
            return
        }
        try {
            await api.createSamePeriodGroup(samePeriodGroupName, selectedGroupSubjects)
            addToast('Same-period group created', 'success')
            setSamePeriodGroupName('')
            setSelectedGroupSubjects([])
            loadSamePeriodGroups()
        } catch (err) { addToast(err.message, 'error') }
    }

    async function deleteSamePeriodGroup(groupId) {
        try {
            await api.deleteSamePeriodGroup(groupId)
            addToast('Same-period group removed', 'success')
            loadSamePeriodGroups()
        } catch (err) { addToast(err.message, 'error') }
    }

    function exportSubjects() {
        const data = subjects.map(s => ({
            Subject_Code: s.subject_code, Name: s.subject_name,
            Department: s.department, Program: s.program, Level: s.level,
            Room_Placement_Type: s.room_placement_type || 'TH',
            Students: s.student_count, Status: s.status, Notes: s.notes
        }))
        downloadExcelFromBackend('subjects_export.xlsx', 'Subjects', data);
        addToast('Exported', 'success')
    }

    function downloadSubjectsTemplate() {
        const template = [
            { subject_code: 'CSE565', subject_name: 'Advanced Algorithms', department: 'Computer Science', program: 'BSc Computer Science', level: 'Level 3', room_placement_type: 'TH', exam_duration: 120, notes: '', no_exam: 'no' },
            { subject_code: 'CSE575', subject_name: 'Machine Learning', department: 'Computer Science', program: 'BSc Computer Science', level: 'Level 4', room_placement_type: 'LAB', exam_duration: 120, notes: '', no_exam: 'no' },
            { subject_code: 'MTH301', subject_name: 'Calculus III', department: 'Mathematics', program: 'BSc Mathematics', level: 'Level 2', room_placement_type: 'TH', exam_duration: 90, notes: 'Open book allowed', no_exam: 'no' },
            { subject_code: 'PE101', subject_name: 'Physical Education', department: 'General', program: '', level: 'Level 1', room_placement_type: 'DH', exam_duration: 0, notes: 'No written exam', no_exam: 'yes' }
        ]
        downloadExcelFromBackend('subjects_import_template.xlsx', 'Subjects Template', template);
        addToast('Template downloaded', 'success')
    }

    const filtered = subjects.filter(s => {
        if (tab === 'remaining') return s.status === 'unscheduled'
        if (tab === 'no-final') return s.status === 'no_final_exam'
        return true
    })
    const groupedSubjectSet = new Set(samePeriodGroups.flatMap(group => group.subject_codes || []))
    const availableForGrouping = subjects.filter(subject =>
        subject.status !== 'no_final_exam' && !groupedSubjectSet.has(subject.subject_code)
    )

    const statusBadge = (status) => {
        const map = { scheduled: 'badge-scheduled', unscheduled: 'badge-unscheduled', no_final_exam: 'badge-no-final' }
        return <span className={`badge ${map[status] || ''}`}>{status?.replace(/_/g, ' ')}</span>
    }

    return (
        <div>
            <div className="section-header">
                <div>
                    <h2 className="section-title">Subjects</h2>
                    <p className="section-subtitle">{subjects.length} total subjects</p>
                </div>
                <div className="flex gap-sm">
                    <button className="btn btn-primary" onClick={() => setShowImport(i => !i)}>{icons.upload} <span>Import</span></button>
                    <button className="btn btn-secondary" onClick={exportSubjects}>{icons.download} <span>Export</span></button>
                    <button className="btn btn-danger" onClick={() => setConfirmClearSubjects(true)}>{icons.trash} <span>Clear All</span></button>
                </div>
            </div>

            {/* Import Panel */}
            {showImport && (
                <div className="card mb-lg">
                    <div className="flex items-center justify-between mb-md">
                        <p className="text-sm text-muted" style={{ margin: 0 }}>
                            Upload <strong>Excel/CSV</strong> with <code>subject_code</code> (required), <code>subject_name</code>, <code>department</code>, <code>program</code>, <code>level</code>, <code>room_placement_type</code> (TH/LAB/DH), <code>exam_duration</code>, <code>no_exam</code> (yes/no), and <code>notes</code>
                        </p>
                        <button className="btn btn-secondary btn-sm" onClick={downloadSubjectsTemplate} style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
                            {icons.download} <span>Download Template</span>
                        </button>
                    </div>
                    <div className="file-upload-zone" onClick={() => fileRef.current?.click()}>
                        <div className="file-upload-icon">{icons.upload}</div>
                        <div className="file-upload-text">
                            {importing
                                ? <><div className="spinner" style={{ margin: '0 auto 8px' }}></div>Processing...</>
                                : <>Click to upload or drag an <strong>Excel / CSV</strong> file</>
                            }
                        </div>
                    </div>
                    <input type="file" ref={fileRef} accept=".xlsx,.xls,.csv" onChange={handleImport} style={{ display: 'none' }} />
                </div>
            )}

            <div className="card mb-lg">
                <div className="section-header" style={{ marginBottom: 16 }}>
                    <div>
                        <h3 className="section-title">Same Period Groups</h3>
                        <p className="section-subtitle">Select two or more subjects that must share one exam period during auto-scheduling.</p>
                    </div>
                </div>
                <div className="form-row">
                    <div className="form-group">
                        <label className="form-label">Group Name</label>
                        <input
                            className="form-input"
                            placeholder="Optional group label"
                            value={samePeriodGroupName}
                            onChange={e => setSamePeriodGroupName(e.target.value)}
                        />
                    </div>
                </div>
                <div className="form-group">
                    <label className="form-label">Select Subjects</label>
                    <select
                        className="form-select"
                        multiple
                        value={selectedGroupSubjects}
                        onChange={e => setSelectedGroupSubjects(Array.from(e.target.selectedOptions).map(option => option.value))}
                        style={{ minHeight: 160 }}
                    >
                        {availableForGrouping.map(subject => (
                            <option key={subject.subject_code} value={subject.subject_code}>
                                {subject.subject_code} - {subject.subject_name || subject.subject_code}
                            </option>
                        ))}
                    </select>
                    <p className="text-sm text-muted" style={{ marginTop: 8 }}>
                        Hold Ctrl/Cmd to select multiple subjects. Grouped subjects must share the same exam duration.
                    </p>
                </div>
                <div className="flex gap-sm" style={{ marginBottom: 20 }}>
                    <button className="btn btn-primary" onClick={createSamePeriodGroup}>{icons.plus} <span>Create Group</span></button>
                </div>
                <div className="table-container">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>Group</th>
                                <th>Subjects</th>
                                <th>Count</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {samePeriodGroups.length === 0 ? (
                                <tr><td colSpan="4" className="text-center text-muted" style={{ padding: 24 }}>No same-period groups defined</td></tr>
                            ) : samePeriodGroups.map(group => (
                                <tr key={group.id}>
                                    <td><strong>{group.group_name}</strong></td>
                                    <td>{(group.subject_codes || []).join(', ')}</td>
                                    <td>{group.subject_count}</td>
                                    <td>
                                        <button className="btn btn-ghost btn-sm" onClick={() => deleteSamePeriodGroup(group.id)} title="Delete group">
                                            {icons.trash}
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            <div className="tabs">
                <button className={`tab${tab === 'all' ? ' active' : ''}`} onClick={() => setTab('all')}>
                    All Subjects ({subjects.length})
                </button>
                <button className={`tab${tab === 'remaining' ? ' active' : ''}`} onClick={() => setTab('remaining')}>
                    Remaining ({subjects.filter(s => s.status === 'unscheduled').length})
                </button>
                <button className={`tab${tab === 'no-final' ? ' active' : ''}`} onClick={() => setTab('no-final')}>
                    No Final Exam ({subjects.filter(s => s.status === 'no_final_exam').length})
                </button>
            </div>

            <div className="table-container">
                <div className="table-toolbar">
                    <div className="table-toolbar-left">
                        <div className="search-wrapper">
                            {icons.search}
                            <input className="table-search" placeholder="Search subjects..." value={search} onChange={e => setSearch(e.target.value)} />
                        </div>
                    </div>
                </div>
                {loading ? (
                    <div className="text-center" style={{ padding: 40 }}><div className="spinner" style={{ margin: '0 auto' }}></div></div>
                ) : (
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>Code</th><th>Name</th><th>Department</th><th>Program</th><th>Level</th>
                                <th>Room Type</th><th>Students</th><th>Duration</th><th>Status</th><th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.length === 0 ? (
                                <tr><td colSpan="10" className="text-center text-muted" style={{ padding: 40 }}>No subjects found</td></tr>
                            ) : filtered.map(s => (
                                <tr key={s.subject_code}>
                                    <td><strong>{s.subject_code}</strong></td>
                                    <td>{s.subject_name || '—'}</td>
                                    <td>{s.department || '—'}</td>
                                    <td>{s.program || '—'}</td>
                                    <td>{s.level || '—'}</td>
                                    <td>{s.room_placement_type || 'TH'}</td>
                                    <td>{s.student_count}</td>
                                    <td>{s.exam_duration} min</td>
                                    <td>{statusBadge(s.status)}</td>
                                    <td>
                                        <div className="flex gap-sm">
                                            <button className="btn btn-ghost btn-sm" onClick={() => setEditSubject({ ...s })} title="Edit">{icons.audit}</button>
                                            {s.status === 'unscheduled' && (
                                                <button className="btn btn-ghost btn-sm" onClick={() => updateStatus(s.subject_code, 'no_final_exam')} title="Mark No Final">
                                                    {icons.close}
                                                </button>
                                            )}
                                            {s.status === 'no_final_exam' && (
                                                <button className="btn btn-ghost btn-sm" onClick={() => updateStatus(s.subject_code, 'unscheduled')} title="Restore">
                                                    {icons.check}
                                                </button>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Edit Modal */}
            {
                editSubject && (
                    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setEditSubject(null) }}>
                        <div className="modal">
                            <div className="modal-header">
                                <h3 className="modal-title">Edit Subject: {editSubject.subject_code}</h3>
                                <button className="btn-icon" onClick={() => setEditSubject(null)}>{icons.close}</button>
                            </div>
                            <div className="modal-body">
                                <div className="form-row">
                                    <div className="form-group">
                                        <label className="form-label">Subject Name</label>
                                        <input className="form-input" value={editSubject.subject_name || ''} onChange={e => setEditSubject({ ...editSubject, subject_name: e.target.value })} />
                                    </div>
                                    <div className="form-group">
                                        <label className="form-label">Department</label>
                                        <input className="form-input" value={editSubject.department || ''} onChange={e => setEditSubject({ ...editSubject, department: e.target.value })} />
                                    </div>
                                </div>
                                <div className="form-row mt-md">
                                    <div className="form-group">
                                        <label className="form-label">Program</label>
                                        <input className="form-input" value={editSubject.program || ''} onChange={e => setEditSubject({ ...editSubject, program: e.target.value })} />
                                    </div>
                                    <div className="form-group">
                                        <label className="form-label">Level</label>
                                        <input className="form-input" value={editSubject.level || ''} onChange={e => setEditSubject({ ...editSubject, level: e.target.value })} />
                                    </div>
                                </div>
                                <div className="form-row mt-md">
                                    <div className="form-group">
                                        <label className="form-label">Exam Duration (min)</label>
                                        <input type="number" className="form-input" value={editSubject.exam_duration || 120} onChange={e => setEditSubject({ ...editSubject, exam_duration: parseInt(e.target.value) })} />
                                    </div>
                                    <div className="form-group">
                                        <label className="form-label">Room Placement Type</label>
                                        <select className="form-select" value={editSubject.room_placement_type || 'TH'} onChange={e => setEditSubject({ ...editSubject, room_placement_type: e.target.value })}>
                                            <option value="TH">TH</option>
                                            <option value="LAB">LAB</option>
                                            <option value="DH">DH</option>
                                        </select>
                                    </div>
                                </div>
                                <div className="form-row mt-md">
                                    <div className="form-group">
                                        <label className="form-label">Status</label>
                                        <select className="form-select" value={editSubject.status} onChange={e => setEditSubject({ ...editSubject, status: e.target.value })}>
                                            <option value="unscheduled">Unscheduled</option>
                                            <option value="scheduled">Scheduled</option>
                                            <option value="no_final_exam">No Final Exam</option>
                                        </select>
                                    </div>
                                </div>
                                <div className="form-group mt-md">
                                    <label className="form-label">Notes</label>
                                    <textarea className="form-textarea" value={editSubject.notes || ''} onChange={e => setEditSubject({ ...editSubject, notes: e.target.value })} />
                                </div>
                            </div>
                            <div className="modal-footer">
                                <button className="btn btn-secondary" onClick={() => setEditSubject(null)}>Cancel</button>
                                <button className="btn btn-primary" onClick={saveEdit}>Save Changes</button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Confirm Clear All Subjects Modal */}
            {
                confirmClearSubjects && (
                    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setConfirmClearSubjects(false) }}>
                        <div className="modal" style={{ maxWidth: 440 }}>
                            <div className="modal-body">
                                <div className="confirm-dialog">
                                    <div className="confirm-icon danger">{icons.trash}</div>
                                    <h3 className="confirm-title">Clear All Subjects?</h3>
                                    <p className="confirm-message">
                                        This will permanently delete <strong>all {subjects.length} subjects</strong>,
                                        all student registrations, and all schedule assignments.
                                        This action cannot be undone.
                                    </p>
                                    <div className="confirm-actions">
                                        <button className="btn btn-secondary" onClick={() => setConfirmClearSubjects(false)}>Cancel</button>
                                        <button className="btn btn-danger" onClick={handleClearAllSubjects}>Yes, Clear All Subjects</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )
            }
        </div >
    )
}
