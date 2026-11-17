const { normalizeSlotDate } = require('./slotImport');

function normalizeExamDate(value) {
    if (value === undefined || value === null || String(value).trim() === '') return '';
    try {
        return normalizeSlotDate(value);
    } catch (error) {
        error.status = 400;
        throw error;
    }
}

function formatExamDateDisplay(value) {
    const raw = String(value ?? '').trim();
    try {
        const [year, month, day] = normalizeExamDate(raw).split('-');
        return year ? `${day}/${month}/${year}` : '';
    } catch {
        return raw;
    }
}

module.exports = { normalizeExamDate, formatExamDateDisplay };
