const API_BASE = '/api';

async function apiFetch(url, options = {}) {
    const res = await fetch(`${API_BASE}${url}`, {
        headers: { 'Content-Type': 'application/json', ...options.headers },
        ...options
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'API Error');
    }
    return res.json();
}

export const api = {
    // Dashboard
    getDashboard: () => apiFetch('/dashboard'),

    // Students
    getStudents: (params = {}) => {
        const qs = new URLSearchParams(params).toString();
        return apiFetch(`/students${qs ? '?' + qs : ''}`);
    },
    getStudent: (id) => apiFetch(`/students/${id}`),
    importStudents: (data) => apiFetch('/students/import', { method: 'POST', body: JSON.stringify({ data }) }),
    deleteAllStudents: () => apiFetch('/students/all', { method: 'DELETE' }),

    // Subjects
    getSubjects: (params = {}) => {
        const qs = new URLSearchParams(params).toString();
        return apiFetch(`/subjects${qs ? '?' + qs : ''}`);
    },
    importSubjects: (data) => apiFetch('/subjects/import', { method: 'POST', body: JSON.stringify({ data }) }),
    updateSubject: (code, data) => apiFetch(`/subjects/${code}`, { method: 'PUT', body: JSON.stringify(data) }),
    createSubject: (data) => apiFetch('/subjects', { method: 'POST', body: JSON.stringify(data) }),
    bulkUpdateSubjects: (data) => apiFetch('/subjects/bulk-update', { method: 'POST', body: JSON.stringify({ data }) }),
    getSamePeriodGroups: () => apiFetch('/subjects/same-period-groups'),
    createSamePeriodGroup: (group_name, subject_codes) => apiFetch('/subjects/same-period-groups', { method: 'POST', body: JSON.stringify({ group_name, subject_codes }) }),
    deleteSamePeriodGroup: (id) => apiFetch(`/subjects/same-period-groups/${id}`, { method: 'DELETE' }),
    clearAllSubjects: () => apiFetch('/subjects/all', { method: 'DELETE' }),

    // Periods
    getPeriods: () => apiFetch('/periods'),
    createPeriod: (data) => apiFetch('/periods', { method: 'POST', body: JSON.stringify(data) }),
    updatePeriod: (id, data) => apiFetch(`/periods/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    bulkCreatePeriods: (dates, periods, student_cap = '') => apiFetch('/periods/bulk', { method: 'POST', body: JSON.stringify({ dates, periods, student_cap }) }),
    importPeriods: (data) => apiFetch('/periods/import', { method: 'POST', body: JSON.stringify({ data }) }),
    setAllPeriodsCap: (student_cap) => apiFetch('/periods/set-cap-all', { method: 'PUT', body: JSON.stringify({ student_cap }) }),
    deletePeriod: (id) => apiFetch(`/periods/${id}`, { method: 'DELETE' }),
    deleteAllPeriods: () => apiFetch('/periods', { method: 'DELETE' }),

    // Schedule
    getSchedule: () => apiFetch('/schedule'),
    assignSubject: (subject_code, exam_period_id, assignMode = 'move', target_program = '', target_programs = []) =>
        apiFetch('/schedule/assign', {
            method: 'POST',
            body: JSON.stringify({ subject_code, exam_period_id, assignMode, target_program, target_programs })
        }),
    unassignSubject: (code) => apiFetch(`/schedule/unassign/${code}`, { method: 'DELETE' }),
    unassignScheduleEntry: (id) => apiFetch(`/schedule/unassign-entry/${id}`, { method: 'DELETE' }),
    clearAllSchedule: () => apiFetch('/schedule/clear-all', { method: 'DELETE' }),
    importSchedule: (data) => apiFetch('/schedule/import', { method: 'POST', body: JSON.stringify({ data }) }),
    autoSchedule: () => apiFetch('/schedule/auto-schedule', { method: 'POST' }),

    // Conflicts
    getConflicts: (params = {}) => {
        const qs = new URLSearchParams(params).toString();
        return apiFetch(`/conflicts${qs ? '?' + qs : ''}`);
    },
    getCellConflicts: (periodId) => apiFetch(`/conflicts/cell/${periodId}`),

    // Reports
    getScheduleReport: () => apiFetch('/reports/schedule'),
    getRemainingReport: () => apiFetch('/reports/remaining'),
    getNoFinalReport: () => apiFetch('/reports/no-final'),

    // Audit
    getAuditLog: (params = {}) => {
        const qs = new URLSearchParams(params).toString();
        return apiFetch(`/audit${qs ? '?' + qs : ''}`);
    },

    // Auth
    login: (username, password) => apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
    getUsers: () => apiFetch('/auth/users'),
    getSettings: () => apiFetch('/auth/settings'),
    updateSetting: (key, value) => apiFetch('/auth/settings', { method: 'PUT', body: JSON.stringify({ key, value }) }),
};
