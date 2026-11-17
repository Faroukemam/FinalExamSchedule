import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { icons, useToast } from '../App'
import { downloadMultiSheetExcelFromBackend, downloadWordFromBackend } from '../utils/export'
import { buildReportData, buildReportPacks, fullReportSheets } from '../utils/reports'
import { buildStudentScheduleHtml } from '../utils/studentScheduleWord'

export default function FinalReports() {
    const addToast = useToast()
    const [loading, setLoading] = useState(true)
    const [loadError, setLoadError] = useState('')
    const [source, setSource] = useState(null)
    const [exporting, setExporting] = useState('')
    const [selectedProgram, setSelectedProgram] = useState('')

    useEffect(() => { loadReportsData() }, [])

    async function loadReportsData() {
        setLoading(true)
        setLoadError('')
        try {
            const [schedule, subjects, periods, conflicts, dashboard, settings] = await Promise.all([
                api.getSchedule(), api.getSubjects(), api.getPeriods(), api.getConflicts(), api.getDashboard(), api.getSettings()
            ])
            if (schedule.some(row => !['major', 'minor'].includes(row.capacity_pool) || typeof row.capacity_valid !== 'boolean')) {
                throw new Error('Restart the backend to load automatic capacity allocation, then refresh reports.')
            }
            setSource({ schedule, subjects, periods, conflicts, dashboard, settings, generatedAt: new Date().toISOString() })
        } catch (error) {
            setLoadError(error.message || 'Failed to load report data')
            setSource(null)
        } finally { setLoading(false) }
    }

    const reportData = useMemo(() => buildReportData(source || {}), [source])
    const packs = useMemo(() => buildReportPacks(reportData), [reportData])
    const programs = Object.keys(reportData.programSchedulesMap)
    const activeProgram = programs.includes(selectedProgram) ? selectedProgram : programs[0] || ''
    const periods = source?.periods || []
    const overview = reportData.executiveSummary[0]

    async function exportWorkbook(id, filename, sheets) {
        if (!sheets.some(sheet => sheet.data.length)) { addToast('No data available to export', 'warning'); return }
        setExporting(id)
        try {
            if (await downloadMultiSheetExcelFromBackend(filename, sheets)) addToast(`Exported ${filename}`, 'success')
        } catch (error) { addToast(error.message, 'error') }
        finally { setExporting('') }
    }

    async function exportPack(pack) {
        if (pack.word) {
            setExporting(pack.id)
            try {
                if (await exportStudentScheduleFormWord()) addToast(`Exported ${pack.filename}`, 'success')
            } catch (error) { addToast(error.message, 'error') }
            finally { setExporting('') }
        } else { await exportWorkbook(pack.id, pack.filename, pack.sheets) }
    }

    async function exportStudentScheduleFormWord() {
        const rows = reportData.studentScheduleFormReport
        if (!rows.length) { addToast('No rows to export for this report', 'warning'); return false }
        return downloadWordFromBackend('final_university_form.doc', buildStudentScheduleHtml(rows, periods))
    }

    if (loading) return <div className="text-center mt-lg"><div className="spinner" style={{ margin: '40px auto' }}></div></div>

    return (
        <div className="reports-shell">
            <div className="section-header">
                <div>
                    <h2 className="section-title">Final Reports</h2>
                    <p className="section-subtitle">Schedules, capacity planning and final review in {packs.length} focused reports.</p>
                </div>
                <div className="flex gap-sm">
                    <button className="btn btn-primary" disabled={!source || !!exporting} onClick={() => exportWorkbook('full', 'final_report_pack.xlsx', fullReportSheets(packs))}>
                        {icons.download} <span>{exporting === 'full' ? 'Exporting?' : 'Export Full Excel Pack'}</span>
                    </button>
                    <button className="btn btn-secondary" disabled={!!exporting} onClick={loadReportsData}>{icons.search} <span>Refresh Data</span></button>
                </div>
            </div>
            {loadError ? (
                <div className="card" role="alert"><strong>Reports could not be loaded</strong><p>{loadError}</p></div>
            ) : (
                <>
                    <div className="card reports-hero mb-lg">
                        <div className="reports-hero-head"><strong className="reports-hero-title">Report Pack</strong><span className="text-sm text-muted">Updated {overview.Generated_At_Cairo} ? Cairo</span></div>
                        <div className="reports-kpi-strip">
                            <div className="reports-kpi"><span>Scheduled subjects</span><strong>{overview.Scheduled_Subjects}</strong></div>
                            <div className="reports-kpi"><span>Unscheduled subjects</span><strong>{overview.Unscheduled_Subjects}</strong></div>
                            <div className="reports-kpi"><span>Slots using Minor</span><strong>{overview.Slots_Using_Minor}</strong></div>
                            <div className="reports-kpi"><span>Slots over capacity</span><strong>{overview.Slots_Over_Capacity}</strong></div>
                        </div>
                        <p className="text-sm text-muted">Pool allocation is automatic: Major first, Minor when needed. Each subject must fit in one pool. Workload totals count student exam assignments, so one student can appear in multiple exams.</p>
                        {overview.Subjects_With_Data_Issues > 0 && <p role="status" className="text-sm">{overview.Subjects_With_Data_Issues} subjects have inconsistent source data. See the Data Issues column in Subject Status.</p>}
                    </div>
                    <div className="summary-grid reports-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
                        {packs.map(pack => {
                            const rowCount = pack.word ? pack.rows.length : (pack.sheets[0]?.data.length ?? 0)
                            const empty = pack.word ? !pack.rows.length : !pack.sheets.some(sheet => sheet.data.length)
                            return (
                                <div className="card report-card" key={pack.id}>
                                    <div className="report-card-top"><span className="report-card-icon">{pack.id === 'conflicts' ? icons.conflicts : pack.id === 'capacity' ? icons.dashboard : icons.reports}</span><span className="badge badge-no-final">{pack.category}</span></div>
                                    <div className="flex items-center justify-between"><h3 className="report-card-title">{pack.title}</h3><span className="badge badge-unscheduled">{rowCount} rows</span></div>
                                    <p className="text-sm text-muted report-card-description">{pack.description}</p>
                                    {!pack.word && <p className="text-sm text-muted">{pack.sheets.length} {pack.sheets.length === 1 ? 'sheet' : 'sheets'}</p>}
                                    <button className="btn btn-primary btn-sm" style={{ alignSelf: 'flex-start' }} disabled={empty || !!exporting} onClick={() => exportPack(pack)}>{icons.download} <span>{exporting === pack.id ? 'Exporting?' : pack.word ? 'Export Word' : 'Export Excel'}</span></button>
                                </div>
                            )
                        })}
                    </div>
                    {programs.length > 0 && (
                        <div className="card mt-lg">
                            <h3 className="report-card-title">Export One Program Grid</h3>
                            <p className="text-sm text-muted">Choose a program to export its timetable grid only.</p>
                            <div className="flex gap-sm" style={{ flexWrap: 'wrap' }}>
                                <select className="form-select" aria-label="Program to export" style={{ width: 'auto', minWidth: 220 }} value={activeProgram} onChange={event => setSelectedProgram(event.target.value)}>
                                    {programs.map(program => <option key={program} value={program}>{program}</option>)}
                                </select>
                                <button className="btn btn-secondary" disabled={!!exporting} onClick={() => exportWorkbook('program', `final_program_grid_${activeProgram.replace(/[^a-zA-Z0-9_-]/g, '_')}.xlsx`, [
                                    { sheetName: 'Schedule Grid', data: reportData.programSchedulesGridMap[activeProgram] }
                                ])}>{icons.download} <span>{exporting === 'program' ? 'Exporting?' : 'Export Program Grid'}</span></button>
                            </div>
                        </div>
                    )}
                </>
            )}
        </div>
    )
}
