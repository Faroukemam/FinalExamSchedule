import { useState, useEffect } from 'react'
import { api } from '../api'
import { icons, useToast } from '../App'

export default function AuditLog() {
    const [logs, setLogs] = useState([])
    const [loading, setLoading] = useState(true)
    const [filterAction, setFilterAction] = useState('')
    const addToast = useToast()

    useEffect(() => { loadLogs() }, [filterAction])

    async function loadLogs() {
        setLoading(true)
        try {
            const params = {}
            if (filterAction) params.action = filterAction
            setLogs(await api.getAuditLog(params))
        } catch (err) { addToast('Failed to load audit log', 'error') }
        setLoading(false)
    }

    const actionBadge = (action) => {
        const colors = {
            schedule_assign: 'badge-scheduled',
            schedule_remove: 'badge-unscheduled',
            schedule_move: 'badge-overlapping',
            status_change: 'badge-same-day'
        }
        return <span className={`badge ${colors[action] || ''}`}>{action?.replace(/_/g, ' ')}</span>
    }

    return (
        <div>
            <div className="section-header">
                <h2 className="section-title">Audit Trail</h2>
            </div>

            <div className="filter-bar">
                <select className="form-select" style={{ width: 200 }} value={filterAction} onChange={e => setFilterAction(e.target.value)}>
                    <option value="">All Actions</option>
                    <option value="schedule_assign">Schedule Assign</option>
                    <option value="schedule_remove">Schedule Remove</option>
                    <option value="schedule_move">Schedule Move</option>
                    <option value="status_change">Status Change</option>
                </select>
            </div>

            <div className="table-container">
                {loading ? (
                    <div className="text-center" style={{ padding: 40 }}><div className="spinner" style={{ margin: '0 auto' }}></div></div>
                ) : (
                    <table className="data-table">
                        <thead>
                            <tr><th>Timestamp</th><th>User</th><th>Action</th><th>Subject</th><th>Old Value</th><th>New Value</th></tr>
                        </thead>
                        <tbody>
                            {logs.length === 0 ? (
                                <tr><td colSpan="6" className="text-center text-muted" style={{ padding: 40 }}>No audit entries</td></tr>
                            ) : logs.map(log => (
                                <tr key={log.id}>
                                    <td className="text-sm">{log.timestamp}</td>
                                    <td>{log.user_name || 'System'}</td>
                                    <td>{actionBadge(log.action)}</td>
                                    <td><strong>{log.subject_code}</strong></td>
                                    <td className="text-sm text-muted">{log.old_value || '—'}</td>
                                    <td className="text-sm">{log.new_value || '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    )
}
