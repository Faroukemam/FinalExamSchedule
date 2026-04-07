function pad2(value) {
    return String(value).padStart(2, '0');
}

function normalizeExamDate(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    if (raw.includes('/')) {
        const [year, day, month] = raw.split('/').map(part => part.trim());
        if (year && day && month) {
            return `${year}-${pad2(month)}-${pad2(day)}`;
        }
    }

    if (raw.includes('-')) {
        const [year, month, day] = raw.split('-').map(part => part.trim());
        if (year && month && day) {
            return `${year}-${pad2(month)}-${pad2(day)}`;
        }
    }

    return raw;
}

module.exports = { normalizeExamDate };
