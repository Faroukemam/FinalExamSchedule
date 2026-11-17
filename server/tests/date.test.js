const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExamDate, formatExamDateDisplay: serverDisplay } = require('../utils/date');
let dates;
before(async () => { dates = await import('../../client/src/utils/date.js'); });

test('existing ISO dates and older slash exports display in day/month/year without changing the day', () => {
    for (const [input, iso, display] of [
        ['2026-12-25', '2026-12-25', '25/12/2026'],
        ['2027-01-09', '2027-01-09', '09/01/2027'],
        ['2026/25/12', '2026-12-25', '25/12/2026'],
        ['2026/10/05', '2026-05-10', '10/05/2026'],
        ['09/01/2027', '2027-01-09', '09/01/2027'],
        ['1/2/2028', '2028-02-01', '01/02/2028'],
        ['29/02/2028', '2028-02-29', '29/02/2028']
    ]) {
        assert.equal(normalizeExamDate(input), iso);
        assert.equal(dates.normalizeExamDateForInput(input), iso);
        assert.equal(dates.formatExamDateDisplay(input), display);
        assert.equal(serverDisplay(input), display);
    }
    assert.equal(dates.formatExamDateDisplay('2026-12-31 & 2027-01-01'), '31/12/2026 & 01/01/2027');
    assert.equal(dates.formatExamDateDisplay(null), '');
    assert.equal(normalizeExamDate(''), '');
});

test('invalid dates are rejected instead of swapping the month/day or rolling into another month', () => {
    for (const input of ['31/02/2026', '29/02/2027', '12/25/2026', '2026-02-30', '00/01/2026', '2026/10/15', 'bad']) {
        assert.throws(() => normalizeExamDate(input), error => error.status === 400);
        assert.equal(dates.normalizeExamDateForInput(input), '');
        assert.equal(dates.formatExamDateDisplay(input), input);
    }
});

test('day-first dates sort chronologically across months and years with time tie breaks', () => {
    const rows = [
        { Date: '01/01/2027', Start_Time: '09:00' },
        { Date: '02/12/2026', Start_Time: '11:00' },
        { Date: '31/12/2026', Start_Time: '09:00' },
        { Date: '02/12/2026', Start_Time: '09:00' }
    ];
    assert.deepEqual(dates.sortRowsByDate(rows), [rows[3], rows[1], rows[2], rows[0]]);
    assert.equal(dates.normalizeExamDateForSort('31/12/2026 & 01/01/2027'), '2026-12-31');
    assert.equal(rows[0].Date, '01/01/2027');
});

test('audit timestamps use Cairo time and standard day-first dates with explicit UTC interpretation', () => {
    assert.equal(dates.formatDateTimeDisplay('2026-12-31 23:30:00'), '01/01/2027, 01:30:00');
    assert.equal(dates.formatDateTimeDisplay('2026-12-31T23:30:00Z'), '01/01/2027, 01:30:00');
    assert.equal(dates.formatDateTimeDisplay(''), '');
    assert.equal(dates.formatDatesInText('Slot 2027-01-09 09:30; previous 2026-12-25'), 'Slot 09/01/2027 09:30; previous 25/12/2026');
});
