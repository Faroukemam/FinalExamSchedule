function pad2(value) {
    return String(value).padStart(2, '0')
}

// ISO is the internal format. Year-first slashes are supported for older exports.
export function normalizeExamDateForInput(value) {
    const raw = String(value ?? '').trim()
    let year, month, day
    let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw)
    if (match) [, year, month, day] = match
    else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw))) [, day, month, year] = match
    else if ((match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(raw))) [, year, day, month] = match
    else return ''
    const parsed = new Date(0)
    parsed.setUTCFullYear(Number(year), Number(month) - 1, Number(day))
    parsed.setUTCHours(0, 0, 0, 0)
    if (Number(year) < 1900 || parsed.getUTCFullYear() !== Number(year) ||
        parsed.getUTCMonth() !== Number(month) - 1 || parsed.getUTCDate() !== Number(day)) return ''
    return `${year}-${pad2(month)}-${pad2(day)}`
}

export function normalizeExamDateForSort(value) {
    const raw = String(value ?? '').split('&')[0].trim()
    return normalizeExamDateForInput(raw) || raw
}

export function formatExamDateDisplay(value) {
    const raw = String(value ?? '').trim()
    if (raw.includes('&')) return raw.split('&').map(part => formatExamDateDisplay(part)).join(' & ')
    const iso = normalizeExamDateForInput(raw)
    if (!iso) return raw
    const [year, month, day] = iso.split('-')
    return `${day}/${month}/${year}`
}

export function formatDateTimeDisplay(value) {
    const raw = String(value ?? '').trim()
    if (!raw) return ''
    // SQLite datetime('now') timestamps are UTC even though they omit a zone.
    const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)
        ? raw.replace(' ', 'T') + 'Z' : raw
    const date = new Date(normalized)
    if (Number.isNaN(date.getTime())) return raw
    return date.toLocaleString('en-GB', { timeZone: 'Africa/Cairo', hour12: false })
}

export function formatDatesInText(value) {
    return String(value ?? '').replace(/\b\d{4}-\d{2}-\d{2}\b/g, formatExamDateDisplay)
}

export function sortRowsByDate(rows) {
    return [...(rows || [])].sort((a, b) => {
        const aDate = normalizeExamDateForSort(a?.Exam_Date || a?.Date || '')
        const bDate = normalizeExamDateForSort(b?.Exam_Date || b?.Date || '')
        if (aDate !== bDate) return aDate.localeCompare(bDate)

        const aStart = String(a?.Start_Time || '').trim()
        const bStart = String(b?.Start_Time || '').trim()
        if (aStart !== bStart) return aStart.localeCompare(bStart)

        const aEnd = String(a?.End_Time || '').trim()
        const bEnd = String(b?.End_Time || '').trim()
        if (aEnd !== bEnd) return aEnd.localeCompare(bEnd)

        const aPeriod = String(a?.Period || '').trim()
        const bPeriod = String(b?.Period || '').trim()
        if (aPeriod !== bPeriod) return aPeriod.localeCompare(bPeriod)

        const aCode = String(a?.Subject_Code || a?.Student_ID || a?.Department || a?.Metric || '').trim()
        const bCode = String(b?.Subject_Code || b?.Student_ID || b?.Department || b?.Metric || '').trim()
        return aCode.localeCompare(bCode)
    })
}
