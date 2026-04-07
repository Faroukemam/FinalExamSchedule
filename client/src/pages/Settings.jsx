import { useState, useEffect } from 'react'
import { api } from '../api'
import { icons, useToast } from '../App'

export default function Settings() {
    const [settings, setSettings] = useState({})
    const [users, setUsers] = useState([])
    const [loading, setLoading] = useState(true)
    const addToast = useToast()

    useEffect(() => { loadSettings() }, [])

    async function loadSettings() {
        setLoading(true)
        try {
            const [s, u] = await Promise.all([api.getSettings(), api.getUsers()])
            setSettings(s)
            setUsers(u)
        } catch (err) { addToast('Failed to load settings', 'error') }
        setLoading(false)
    }

    async function updateSetting(key, value) {
        try {
            await api.updateSetting(key, value)
            setSettings(s => ({ ...s, [key]: value }))
            addToast(`Setting updated: ${key} = ${value}`, 'success')
        } catch (err) { addToast(err.message, 'error') }
    }

    if (loading) return <div className="text-center mt-lg"><div className="spinner" style={{ margin: '40px auto' }}></div></div>

    const roleBadge = (role) => {
        const map = { admin: 'badge-same-period', coordinator: 'badge-overlapping', viewer: 'badge-same-day' }
        return <span className={`badge ${map[role] || ''}`}>{role}</span>
    }

    return (
        <div>
            <div className="section-header">
                <h2 className="section-title">Settings</h2>
            </div>

            {/* Back-to-back Configuration */}
            <div className="card mb-lg">
                <h3 style={{ marginBottom: 'var(--space-md)' }}>Back-to-Back Exam Rule</h3>
                <p className="text-sm text-muted mb-md">
                    Configure how the system handles exams where one ends exactly when another starts on the same date.
                </p>
                <div className="form-group">
                    <label className="form-label">Back-to-Back Policy</label>
                    <select className="form-select" style={{ maxWidth: 300 }} value={settings.back_to_back || 'warning'}
                        onChange={e => updateSetting('back_to_back', e.target.value)}>
                        <option value="allowed">Allowed — No warning or conflict</option>
                        <option value="warning">Warning — Show as informational warning</option>
                        <option value="conflict">Conflict — Treat as scheduling conflict</option>
                    </select>
                </div>
            </div>

            <div className="card mb-lg">
                <h3 style={{ marginBottom: 'var(--space-md)' }}>Multiple Exams Per Subject</h3>
                <p className="text-sm text-muted mb-md">
                    Allow a subject to be assigned to more than one exam period when needed.
                </p>
                <div className="form-group">
                    <label className="form-label">Subject Exam Assignment Mode</label>
                    <select
                        className="form-select"
                        style={{ maxWidth: 420 }}
                        value={settings.allow_multi_exam_subject || 'false'}
                        onChange={e => updateSetting('allow_multi_exam_subject', e.target.value)}
                    >
                        <option value="false">Single Exam Only (default)</option>
                        <option value="true">Allow Multiple Exams</option>
                    </select>
                </div>
            </div>

            {/* Users */}
            <div className="card">
                <h3 style={{ marginBottom: 'var(--space-md)' }}>User Accounts</h3>
                <p className="text-sm text-muted mb-md">Default password for all demo accounts: <code>admin123</code></p>
                <table className="data-table">
                    <thead>
                        <tr><th>Username</th><th>Full Name</th><th>Role</th><th>Department</th></tr>
                    </thead>
                    <tbody>
                        {users.map(u => (
                            <tr key={u.id}>
                                <td><strong>{u.username}</strong></td>
                                <td>{u.full_name}</td>
                                <td>{roleBadge(u.role)}</td>
                                <td>{u.department || 'All'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    )
}
