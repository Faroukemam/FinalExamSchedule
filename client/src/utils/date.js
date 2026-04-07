function pad2(value) {
    return String(value).padStart(2, '0')
}

export function normalizeExamDateForSort(value) {
    const raw = String(value || '').trim()
    if (!raw) return ''

    if (raw.includes('&')) {
        return normalizeExamDateForSort(raw.split('&')[0].trim())
    }

    if (raw.includes('-')) {
        const [year, month, day] = raw.split('-')
        if (year && month && day) return `${year}-${pad2(month)}-${pad2(day)}`
    }

    if (raw.includes('/')) {
        const [year, day, month] = raw.split('/')
        if (year && day && month) return `${year}-${pad2(month)}-${pad2(day)}`
    }

    return raw
}

export function formatExamDateDisplay(value) {
    const raw = String(value || '').trim()
    if (!raw) return ''

    if (raw.includes('&')) {
        return raw
            .split('&')
            .map(part => formatExamDateDisplay(part.trim()))
            .join(' & ')
    }

    if (raw.includes('-')) {
        const [year, month, day] = raw.split('-')
        return `${year}/${pad2(day)}/${pad2(month)}`
    }

    if (raw.includes('/')) {
        const [year, day, month] = raw.split('/')
        return `${year}/${pad2(day)}/${pad2(month)}`
    }

    return raw
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
