const { SSF } = require('xlsx');

const aliases = {
    exam_date: ['examdate', 'date'],
    start_time: ['starttime', 'start'],
    end_time: ['endtime', 'end'],
    major_cap: ['majorcap', 'majorcapacity', 'studentcap', 'cap'],
    minor_cap: ['minorcap', 'minorcapacity'],
    subject_cap: ['subjectcap', 'maxstudentspersubject', 'maximumstudentspersubject'],
};
const ignored = new Set(['duration', 'capstatus', 'assignedsubjects', 'majorstudents', 'minorstudents', 'rownumber']);
const headerKey = value => String(value).replace(/^\uFEFF/, '').toLowerCase().replace(/[\s_-]/g, '');

function readImportRow(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Expected a slot row object');
    const normalized = {};
    for (const [header, value] of Object.entries(row)) {
        const key = headerKey(header);
        const field = Object.keys(aliases).find(name => aliases[name].includes(key));
        if (field) {
            if (Object.hasOwn(normalized, field)) throw new Error(`Duplicate columns for ${field}`);
            normalized[field] = value;
        } else if (!ignored.has(key)) {
            throw new Error(`Unknown column "${header}". Use exam_date, start_time, end_time, major_cap, minor_cap, subject_cap`);
        }
    }
    return normalized;
}

function validDate(year, month, day) {
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(0, 0, 0, 0);
    if (year < 1900 || year > 9999 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        throw new Error('Invalid calendar date');
    }
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeSlotDate(value, date1904 = false) {
    if (typeof value === 'number') {
        const parsed = Number.isFinite(value) && value >= 0 && SSF.parse_date_code(value, { date1904 });
        if (!parsed) throw new Error('Invalid Excel date');
        return validDate(parsed.y, parsed.m, parsed.d);
    }
    const text = String(value ?? '').trim();
    let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
    if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
    match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text);
    if (match) return validDate(Number(match[1]), Number(match[3]), Number(match[2]));
    match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
    if (match) return validDate(Number(match[3]), Number(match[2]), Number(match[1]));
    throw new Error('Date must be DD/MM/YYYY, YYYY-MM-DD or an Excel date');
}

function normalizeSlotTime(value) {
    let hours, minutes;
    if (typeof value === 'number') {
        const total = value * 1440;
        if (!Number.isFinite(value) || value < 0 || value >= 1 || Math.abs(total - Math.round(total)) > 0.000001) {
            throw new Error('Excel time must be between 00:00 and 23:59, with whole minutes');
        }
        hours = Math.floor(Math.round(total) / 60);
        minutes = Math.round(total) % 60;
    } else {
        const match = /^(\d{1,2}):(\d{2})(?::00)?\s*(AM|PM)?$/i.exec(String(value ?? '').trim());
        if (!match) throw new Error('Time must be HH:mm or h:mm AM/PM, with whole minutes');
        hours = Number(match[1]);
        minutes = Number(match[2]);
        if (match[3]) {
            if (hours < 1 || hours > 12) throw new Error('Invalid 12-hour time');
            hours = (hours % 12) + (match[3].toUpperCase() === 'PM' ? 12 : 0);
        }
    }
    if (hours > 23 || minutes > 59) throw new Error('Invalid clock time');
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function normalizeSlot(row, date1904 = false) {
    const slot = { ...row, exam_date: normalizeSlotDate(row.exam_date, date1904), start_time: normalizeSlotTime(row.start_time), end_time: normalizeSlotTime(row.end_time) };
    if (slot.start_time === slot.end_time) throw new Error('Start and end times must differ');
    return slot;
}

const slotKey = slot => `${slot.exam_date}|${slot.start_time}|${slot.end_time}`;
module.exports = { readImportRow, normalizeSlot, normalizeSlotDate, normalizeSlotTime, slotKey };
