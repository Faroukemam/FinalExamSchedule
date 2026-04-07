import { useState, useEffect, createContext, useContext, useCallback } from 'react'
import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom'
import { api } from './api'
import Dashboard from './pages/Dashboard'
import Students from './pages/Students'
import Subjects from './pages/Subjects'
import Schedule from './pages/Schedule'
import Slots from './pages/Slots'
import Conflicts from './pages/Conflicts'
import AuditLog from './pages/AuditLog'
import Settings from './pages/Settings'
import FinalReports from './pages/FinalReports'

// Toast context
export const ToastContext = createContext()

export function useToast() {
    return useContext(ToastContext)
}

// Icons (inline SVGs to avoid dependency issues)
const icons = {
    dashboard: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>,
    students: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>,
    subjects: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" /></svg>,
    schedule: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>,
    conflicts: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>,
    audit: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>,
    settings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" /></svg>,
    reports: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" /></svg>,
    close: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>,
    search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>,
    plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>,
    upload: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>,
    download: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>,
    trash: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>,
    check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>,
    info: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></svg>,
    wand: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 4-1 1" /><path d="m21 12-1 1" /><path d="m3 12 1 1" /><path d="m9 4 1 1" /><path d="m4 21 17-17" /></svg>,
    filter: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>,
    chevronLeft: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>,
    chevronRight: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>,
    maximize: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>,
    minimize: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></svg>,
}

export { icons }

// Page title mapping
const pageTitles = {
    '/': 'Dashboard',
    '/students': 'Student Management',
    '/subjects': 'Subject Management',
    '/schedule': 'Exam Schedule',
    '/slots': 'Slots And Caps',
    '/conflicts': 'Conflict Detection',
    '/audit': 'Audit Trail',
    '/settings': 'Settings',
    '/final-reports': 'Final Reports',
}

function Sidebar({ isCollapsed, toggleCollapse }) {
    const location = useLocation()
    const [conflictCount, setConflictCount] = useState(0)

    useEffect(() => {
        api.getConflicts().then(r => setConflictCount(r.summary?.same_period || 0)).catch(() => { })
    }, [location.pathname])

    const navItems = [
        { path: '/', icon: icons.dashboard, label: 'Dashboard' },
        { path: '/students', icon: icons.students, label: 'Students' },
        { path: '/subjects', icon: icons.subjects, label: 'Subjects' },
        { path: '/schedule', icon: icons.schedule, label: 'Exam Schedule' },
        { path: '/slots', icon: icons.schedule, label: 'Slots' },
        { path: '/conflicts', icon: icons.conflicts, label: 'Conflicts', badge: conflictCount > 0 ? conflictCount : null },
        { path: '/final-reports', icon: icons.reports, label: 'Final Reports' },
        { path: '/audit', icon: icons.audit, label: 'Audit Trail' },
        { path: '/settings', icon: icons.settings, label: 'Settings' },
    ]

    return (
        <aside className={`sidebar${isCollapsed ? ' collapsed' : ''}`}>
            <button className="sidebar-toggle" onClick={toggleCollapse} title={isCollapsed ? "Expand Menu" : "Collapse Menu"}>
                {isCollapsed ? icons.chevronRight : icons.chevronLeft}
            </button>
            <div className="sidebar-header">
                <div>
                    <div className="sidebar-title">ExamFlow</div>
                    <div className="sidebar-subtitle">Exam Scheduler</div>
                </div>
            </div>
            <nav className="sidebar-nav">
                <div className="nav-section-label">Main Menu</div>
                {navItems.map(item => (
                    <NavLink key={item.path} to={item.path} end={item.path === '/'}
                        className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                        title={isCollapsed ? item.label : undefined}>
                        {item.icon}
                        <span>{item.label}</span>
                        {item.badge && <span className="nav-badge">{item.badge}</span>}
                    </NavLink>
                ))}
            </nav>
        </aside>
    )
}

function TopBar() {
    const location = useLocation()
    const title = pageTitles[location.pathname] || 'ExamFlow'
    return (
        <header className="topbar">
            <div className="topbar-left">
                <h1 className="page-title">{title}</h1>
            </div>
            <div className="topbar-right">
                <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Admin</span>
            </div>
        </header>
    )
}

// Toast component
function ToastContainer({ toasts, onDismiss }) {
    return (
        <div className="toast-container">
            {toasts.map(t => (
                <div key={t.id} className={`toast toast-${t.type}`}>
                    <span className="toast-message">{t.message}</span>
                    <button className="toast-close" onClick={() => onDismiss(t.id)}>{icons.close}</button>
                </div>
            ))}
        </div>
    )
}

function App() {
    const [toasts, setToasts] = useState([])
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)

    const addToast = useCallback((message, type = 'info') => {
        const id = Date.now()
        setToasts(prev => [...prev, { id, message, type }])
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000)
    }, [])

    const dismissToast = useCallback((id) => {
        setToasts(prev => prev.filter(t => t.id !== id))
    }, [])

    return (
        <ToastContext.Provider value={addToast}>
            <BrowserRouter>
                <div className="app-layout">
                    <Sidebar
                        isCollapsed={isSidebarCollapsed}
                        toggleCollapse={() => setIsSidebarCollapsed(v => !v)}
                    />
                    <main className="main-area">
                        <TopBar />
                        <div className="content-area">
                            <Routes>
                                <Route path="/" element={<Dashboard />} />
                                <Route path="/students" element={<Students />} />
                                <Route path="/subjects" element={<Subjects />} />
                                <Route path="/schedule" element={<Schedule />} />
                                <Route path="/slots" element={<Slots />} />
                                <Route path="/conflicts" element={<Conflicts />} />
                                <Route path="/final-reports" element={<FinalReports />} />
                                <Route path="/audit" element={<AuditLog />} />
                                <Route path="/settings" element={<Settings />} />
                            </Routes>
                        </div>
                    </main>
                </div>
                <ToastContainer toasts={toasts} onDismiss={dismissToast} />
            </BrowserRouter>
        </ToastContext.Provider>
    )
}

export default App
