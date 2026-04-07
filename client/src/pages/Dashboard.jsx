import { useState, useEffect } from 'react'
import { api } from '../api'
import { icons, useToast } from '../App'

export default function Dashboard() {
    const [stats, setStats] = useState(null)
    const [conflictSummary, setConflictSummary] = useState(null)
    const addToast = useToast()

    useEffect(() => {
        loadData()
    }, [])

    async function loadData() {
        const [dashboardResult, conflictsResult] = await Promise.allSettled([
            api.getDashboard(),
            api.getConflicts()
        ])

        if (dashboardResult.status === 'fulfilled') {
            setStats(dashboardResult.value)
        } else {
            addToast('Failed to load dashboard', 'error')
            return
        }

        if (conflictsResult.status === 'fulfilled') {
            setConflictSummary(conflictsResult.value.summary)
        } else {
            setConflictSummary(null)
            addToast('Conflict summary is unavailable', 'warning')
        }
    }

    if (!stats) return <div className="text-center mt-lg"><div className="spinner" style={{ margin: '40px auto' }}></div></div>

    const cards = [
        { label: 'Total Students', value: stats.totalStudents, color: 'blue', icon: icons.students },
        { label: 'Total Subjects', value: stats.totalSubjects, color: 'purple', icon: icons.subjects },
        { label: 'Scheduled', value: stats.scheduledSubjects, color: 'success', icon: icons.check },
        { label: 'Remaining', value: stats.unscheduledSubjects, color: 'warning', icon: icons.schedule },
        { label: 'No Final Exam', value: stats.noFinalExam, color: 'info', icon: icons.info },
        { label: 'Exam Periods', value: stats.totalPeriods, color: 'teal', icon: icons.schedule },
        { label: 'Total Conflicts', value: conflictSummary?.total || 0, color: 'danger', icon: icons.conflicts },
        { label: 'Same-Period', value: conflictSummary?.same_period || 0, color: 'danger', icon: icons.conflicts },
        { label: 'Overlapping', value: conflictSummary?.overlapping || 0, color: 'warning', icon: icons.conflicts },
        { label: 'Same-Day', value: conflictSummary?.same_day || 0, color: 'warning', icon: icons.info },
        { label: 'Consec. Day', value: conflictSummary?.consecutive_day || 0, color: 'info', icon: icons.schedule },
    ]

    return (
        <div>
            <div className="section-header">
                <div>
                    <h2 className="section-title">Dashboard Overview</h2>
                    <p className="section-subtitle">Real-time exam scheduling statistics</p>
                </div>
            </div>

            <div className="summary-grid">
                {cards.map((card, i) => (
                    <div key={i} className={`summary-card ${card.color}`}>
                        <div className="summary-card-icon">{card.icon}</div>
                        <div className="summary-card-value">{card.value}</div>
                        <div className="summary-card-label">{card.label}</div>
                    </div>
                ))}
            </div>

            {/* Quick status overview */}
            {stats.unscheduledSubjects > 0 && (
                <div className="card" style={{ borderColor: 'rgba(245,158,11,0.3)', marginTop: 'var(--space-lg)' }}>
                    <div className="flex items-center gap-md">
                        <div style={{ color: 'var(--warning)' }}>{icons.conflicts}</div>
                        <div>
                            <strong style={{ color: 'var(--warning)' }}>{stats.unscheduledSubjects} subjects</strong>
                            <span style={{ color: 'var(--text-secondary)', marginLeft: 8 }}>still need to be scheduled</span>
                        </div>
                    </div>
                </div>
            )}

            {(conflictSummary?.same_period > 0) && (
                <div className="card" style={{ borderColor: 'rgba(239,68,68,0.3)', marginTop: 'var(--space-md)' }}>
                    <div className="flex items-center gap-md">
                        <div style={{ color: 'var(--danger)' }}>{icons.conflicts}</div>
                        <div>
                            <strong style={{ color: 'var(--danger)' }}>{conflictSummary.same_period} same-period conflicts</strong>
                            <span style={{ color: 'var(--text-secondary)', marginLeft: 8 }}>detected — students have overlapping exams</span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
