const { formatExamDateDisplay } = require('./date');
const { buildAllocatedScheduleEntries } = require('./scheduleAllocation');
const { capForType, allocatePools } = require('./poolAllocation');

const CAPACITY_TYPES = ['major', 'minor'];

function normalizeCapacityType(value = 'major') {
    const type = String(value).trim().toLowerCase();
    if (!CAPACITY_TYPES.includes(type)) {
        const error = new Error('Capacity type must be Major or Minor');
        error.status = 400;
        throw error;
    }
    return type;
}

// Blank is unlimited; zero explicitly prevents assignments in this pool.
function normalizeCap(value) {
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null;
    const cap = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
    if (!Number.isSafeInteger(cap) || cap < 0) {
        const error = new Error('Capacity must be a non-negative whole number, or blank for unlimited');
        error.status = 400;
        throw error;
    }
    return cap;
}

function getCapacityUsage(db, entries = buildAllocatedScheduleEntries(db)) {
    const usage = {};
    for (const row of entries) {
        const periodUsage = usage[row.exam_period_id] ||= { major: 0, minor: 0 };
        periodUsage[row.capacity_pool || 'major'] += Number(row.student_count) || 0;
    }
    return usage;
}

function capacityState(db) {
    const result = db.exec('SELECT id, exam_date, start_time, major_cap, minor_cap, subject_cap FROM exam_periods');
    if (!result.length) return new Map();
    const entries = buildAllocatedScheduleEntries(db);
    const usage = getCapacityUsage(db, entries);
    const subjectUsage = {};
    for (const row of entries) {
        const bySubject = subjectUsage[row.exam_period_id] ||= {};
        bySubject[row.subject_code] = (bySubject[row.subject_code] || 0) + Number(row.student_count || 0);
    }
    return new Map(result[0].values.map(values => {
        const period = Object.fromEntries(result[0].columns.map((key, index) => [key, values[index]]));
        const counts = usage[period.id] || { major: 0, minor: 0 };
        const subjects = Object.fromEntries(Object.entries(subjectUsage[period.id] || {}).sort(([a], [b]) => a.localeCompare(b)));
        return [Number(period.id), { period, counts, subjects, signature: JSON.stringify([period, counts, subjects]) }];
    }));
}

function assertSlotCapacities(state, periodIds, { enforcePoolCaps = true } = {}) {
    for (const periodId of periodIds) {
        const current = state.get(Number(periodId));
        if (!current) continue; // A deleted slot no longer consumes capacity.
        const { period, subjects } = current;
        const subjectCap = capForType(period, 'subject');
        for (const [code, count] of Object.entries(subjects)) {
            if (count > subjectCap) {
                const error = new Error(`Subject ${code} exceeds the per-subject limit for ${formatExamDateDisplay(period.exam_date)} ${period.start_time}: ${count} students, limit ${subjectCap}`);
                error.status = 409;
                throw error;
            }
        }
        if (enforcePoolCaps && !allocatePools(period, subjects).ok) {
            const show = type => Number.isFinite(capForType(period, type)) ? capForType(period, type) : 'Unlimited';
            const error = new Error(`Slot capacity exceeded for ${formatExamDateDisplay(period.exam_date)} ${period.start_time}: whole subjects must fit within one pool (Major ${show('major')}, Minor ${show('minor')})`);
            error.status = 409;
            throw error;
        }
    }
}

let transactionId = 0;
function withCapacityTransaction(db, action, periodIds = [], options = {}) {
    const name = `capacity_${++transactionId}`;
    db.run(`SAVEPOINT ${name}`);
    try {
        const before = capacityState(db);
        const result = action();
        const after = capacityState(db);
        // Include allocation changes in other slots (e.g. split-program moves).
        // Pre-existing overloads in untouched slots must not block this action.
        const affected = new Set(periodIds.map(Number));
        for (const [id, state] of after) {
            if (state.signature !== before.get(id)?.signature) affected.add(id);
        }
        assertSlotCapacities(after, affected, options);
        db.run(`RELEASE SAVEPOINT ${name}`);
        return result;
    } catch (error) {
        db.run(`ROLLBACK TO SAVEPOINT ${name}`);
        db.run(`RELEASE SAVEPOINT ${name}`);
        throw error;
    }
}

module.exports = { CAPACITY_TYPES, normalizeCapacityType, normalizeCap, capForType, getCapacityUsage, withCapacityTransaction };
