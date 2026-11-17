const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const XLSX = require('xlsx');
const initSqlJs = require('sql.js');
let buildReportData, buildReportPacks, fullReportSheets, buildStudentScheduleHtml, SQL;
before(async () => {
    ({ buildReportData, buildReportPacks, fullReportSheets } = await import('../../client/src/utils/reports.js'));
    ({ buildStudentScheduleHtml } = await import('../../client/src/utils/studentScheduleWord.js'));
    SQL = await initSqlJs();
});

function source() {
    const periods = [
        { id: 1, exam_date: '2026-12-25', start_time: '09:00', end_time: '11:00', major_cap: 100, minor_cap: 50, subject_cap: 100 },
        { id: 2, exam_date: '2026-12-26', start_time: '12:00', end_time: '15:00', major_cap: 0, minor_cap: null, subject_cap: 0 }
    ];
    const base = { exam_period_id: 1, exam_date: '2026-12-25', start_time: '09:00', end_time: '11:00', department: 'Science', capacity_valid: true, room_placement_type: 'TH' };
    const schedule = [
        { ...base, subject_code: 'A', student_count: 60, capacity_pool: 'major', target_program: 'P', program_counts: 'P::60' },
        { ...base, subject_code: 'A', student_count: 40, capacity_pool: 'major', program_counts: '', program: 'Do not infer' },
        { ...base, subject_code: 'B', student_count: 50, capacity_pool: 'minor', program_counts: 'Q::50', room_placement_type: 'LAB' }
    ];
    const subjects = [
        { subject_code: 'A', student_count: 100, status: 'unscheduled', exam_duration: 120 },
        { subject_code: 'B', student_count: 50, status: 'scheduled', exam_duration: 120 },
        { subject_code: 'C', student_count: 25, status: 'scheduled', exam_duration: 180 },
        { subject_code: 'D', student_count: 10, status: 'no_final_exam', exam_duration: 0 }
    ];
    return { schedule, subjects, periods, dashboard: { totalStudents: 100, scheduledSubjects: 99 },
        conflicts: { conflicts: [
            { student_id: 's1', student_name: 'One', subject_codes: ['A', 'B'], exam_date: '2026-12-25', conflict_type: 'same_period' },
            { student_id: 's1', student_name: 'One', subject_codes: ['A', 'C'], exam_date: '2026-12-25', conflict_type: 'back_to_back_warning' }
        ], summary: { total: 99 } }, generatedAt: '2026-11-14T12:00:00Z' };
}

test('capacity report uses automatic pools, aggregates split subjects and distinguishes assignments from students', () => {
    const data = buildReportData(source());
    const row = data.slotCapacity[0];
    assert.equal(row.Assigned_Subjects, 2);
    assert.equal(row.Schedule_Entries, 3);
    assert.equal(row.Student_Exam_Assignments, 150);
    assert.equal(row.Major_Students, 100);
    assert.equal(row.Minor_Students, 50);
    assert.equal(row.Major_Remaining, 0);
    assert.equal(row.Minor_Remaining, 0);
    assert.equal(row.Largest_Subject, 100);
    assert.equal(row.Capacity_Status, 'Within Capacity');
    assert.equal(data.executiveSummary[0].Registered_Students, 100);
    assert.equal(data.executiveSummary[0].Student_Exam_Assignments, 150);
    assert.equal(data.executiveSummary[0].Slots_Using_Minor, 1);
    assert.equal(data.dailyLoad[0].Student_Exam_Assignments, 150);
    assert.equal(data.masterSchedule[0].Exam_Date, '25/12/2026');
    assert.equal(data.examScheduleGrid[0].Date, '25/12/2026');
    assert.equal(data.departmentScheduleGrids.Science[0].Date, '25/12/2026');
    assert.equal(data.programSchedulesGridMap.P[0].Date, '25/12/2026');
    assert.equal(data.studentScheduleFormReport[0].Date, '25/12/2026');
    assert.match(buildStudentScheduleHtml(data.studentScheduleFormReport, source().periods), /25\/12\/2026/);
});

test('capacity reports preserve zero, unlimited and empty slots and detect aggregate subject-limit violations', () => {
    const input = source();
    input.periods[0].subject_cap = 90;
    const data = buildReportData(input);
    assert.equal(data.slotCapacity[0].Oversized_Subjects, 'A');
    assert.equal(data.slotCapacity[0].Capacity_Status, 'Over Capacity');
    assert.equal(data.slotCapacity[1].Major_Cap, 0);
    assert.equal(data.slotCapacity[1].Minor_Cap, 'Unlimited');
    assert.equal(data.slotCapacity[1].Max_Students_Per_Subject, 0);
    assert.equal(data.slotCapacity[1].Capacity_Status, 'Empty');
    assert.equal(data.executiveSummary[0].Slots_Over_Capacity, 1);
});

test('invalid whole-subject allocation and missing pool metadata cannot appear within capacity', () => {
    const input = source();
    input.schedule[0].capacity_valid = false;
    assert.equal(buildReportData(input).slotCapacity[0].Capacity_Status, 'Over Capacity');
    input.schedule[0].capacity_valid = undefined;
    input.schedule[0].capacity_pool = undefined;
    const data = buildReportData(input);
    assert.equal(data.slotCapacity[0].Capacity_Status, 'Allocation unavailable');
    assert.equal(data.slotCapacity[0].Unallocated_Students, 60);
    assert.equal(data.slotCapacity[0].Major_Students, 40);
});

test('exports omit zero-student subjects and assignments while retaining calendar and positive counts', async () => {
    const input = source();
    for (const [index, count] of [0, '0', null, undefined].entries()) {
        const code = `ZERO${index}`;
        input.subjects.push({ subject_code: code, student_count: count, status: index === 0 ? 'no_final_exam' : 'unscheduled', department: 'Science' });
        input.schedule.push({ ...input.schedule[0], subject_code: code, student_count: count, program_counts: 'Zero Program::0' });
    }
    // An unused room/program split must not leak into a positive subject's details.
    input.schedule.push({ ...input.schedule[0], student_count: 0, room_placement_type: 'DH', program_counts: 'Zero Program::0', assigned_student_id_range: 'unused IDs' });
    input.schedule.push({ ...input.schedule[0], subject_code: 'ZERO_DAY', student_count: 0, exam_period_id: 3, exam_date: '2026-12-27' });
    // Preserve real assigned students even when the enrollment metadata is stale.
    input.subjects.push({ subject_code: 'ACTIVE', student_count: 0, status: 'scheduled', department: 'Science' });
    input.schedule.push({ ...input.schedule[0], subject_code: 'ACTIVE', student_count: 5, program_counts: 'P::5' });
    const data = buildReportData(input);
    assert.equal(data.masterSchedule.length, 4);
    assert.ok(data.masterSchedule.every(row => row.Assigned_Students > 0));
    assert.ok(data.subjectRegister.every(row => row.Enrolled_Students > 0 || row.Assigned_Students > 0));
    assert.equal(data.subjectRegister.find(row => row.Subject_Code === 'ACTIVE').Assigned_Students, 5);
    assert.ok(!Object.hasOwn(data.programSchedulesMap, 'Zero Program'));
    assert.equal(data.examScheduleGrid.length, 3);
    assert.equal(data.examScheduleGrid[2]['09:00-11:00'], '');
    assert.equal(data.examScheduleGrid[0].Student_Exam_Assignments, 155);
    assert.equal(data.slotCapacity[0].Assigned_Subjects, 3);
    assert.equal(data.slotCapacity[0].Schedule_Entries, 4);
    assert.equal(data.slotCapacity[1].Capacity_Status, 'Empty');
    const detailed = data.departmentScheduleGrids.Science[0]['09:00-11:00'];
    assert.doesNotMatch(detailed, /ZERO|Zero Program|DH|unused IDs/);
    assert.match(detailed, /Students: 100/);
    const html = buildStudentScheduleHtml(data.studentScheduleFormReport, input.periods);
    assert.doesNotMatch(html, /ZERO|Zero Program|DH/);
    const sheets = fullReportSheets(buildReportPacks(data));
    assert.doesNotMatch(JSON.stringify(sheets), /ZERO|Zero Program|unused IDs/);
    const { router, files } = exportRouter();
    const response = await call(router, 'post', '/export-excel', { sheets_json: JSON.stringify(sheets) });
    assert.equal(response.statusCode, 200);
    const workbook = XLSX.read(files[0].content, { type: 'buffer' });
    for (const name of workbook.SheetNames) {
        assert.doesNotMatch(XLSX.utils.sheet_to_csv(workbook.Sheets[name]), /ZERO|Zero Program|unused IDs/);
    }
    // Source records remain available for editing and scheduling.
    assert.equal(input.schedule.length, 10);
    assert.equal(input.subjects.length, 9);
});

test('subject reports derive actual status, count unique periods and surface stale source statuses', () => {
    const data = buildReportData(source());
    const a = data.subjectRegister.find(row => row.Subject_Code === 'A');
    assert.equal(a.Status, 'scheduled');
    assert.equal(a.Assigned_Students, 100);
    assert.equal(a.Periods_Assigned, 1);
    assert.equal(a.Schedule_Entries, 2);
    assert.match(a.Data_Issues, /Stored status/);
    assert.deepEqual(data.unscheduledSubjects.map(row => row.Subject_Code), ['C']);
    assert.deepEqual(data.noFinalExamSubjects.map(row => row.Subject_Code), ['D']);
    assert.equal(data.noFinalExamSubjects[0].Exam_Duration_Min, 0);
    assert.equal(data.executiveSummary[0].Scheduled_Subjects, 2);
});

test('program reports preserve unknown-program assignments and exact split totals', () => {
    const data = buildReportData(source());
    assert.deepEqual(Object.keys(data.programSchedulesMap), ['P', 'Q', 'Unspecified']);
    assert.equal(data.allProgramsSchedule.reduce((sum, row) => sum + row.Students_In_Program, 0), 150);
    assert.equal(data.programSchedulesMap.Unspecified[0].Students_In_Program, 40);
    assert.equal(data.programSchedulesGridMap.P[0]['09:00-11:00'], 'A (60)');
    assert.ok(data.masterSchedule.every(row => row.Capacity_Pool === 'Major' || row.Capacity_Pool === 'Minor'));
    assert.equal(data.roomRequirements[0].TH_Students, 100);
    assert.equal(data.roomRequirements[0].LAB_Students, 50);
});

test('conflict reports use actual records and affected students without invented risk levels', () => {
    const data = buildReportData(source());
    assert.equal(data.executiveSummary[0].Conflict_Records, 2);
    assert.equal(data.executiveSummary[0].Students_With_Conflicts, 1);
    assert.equal(data.affectedStudents[0].Clash_Records, 1);
    assert.equal(data.affectedStudents[0].Other_Conflict_Records, 1);
    assert.equal(data.conflictSummary.find(row => row.Conflict_Type === 'back_to_back_warning').Records, 1);
    assert.ok(!Object.hasOwn(data.affectedStudents[0], 'Risk_Level'));
});

test('Word timetable preserves its subject/count layout and excludes all capacity-pool details', () => {
    const input = source();
    const data = buildReportData(input);
    const html = buildStudentScheduleHtml(data.studentScheduleFormReport, input.periods);
    assert.match(html, /Actual Students/);
    assert.match(html, /A \(60\)/);
    assert.match(html, /B \(50, LAB\)/);
    assert.doesNotMatch(html, /Major|Minor|Capacity_Pool|Within Capacity/i);
    assert.ok(html.includes('>150</td>'));
    const escaped = buildStudentScheduleHtml([{ Day: '<script>', Date: '2026/25/12', '09:00': 'A & B', '09:00 Actual_Students': 0 }], input.periods);
    assert.match(escaped, /&lt;script&gt;/);
    assert.match(escaped, /A &amp; B/);
    assert.ok(escaped.includes('>0</td>'));
});

test('report packs consolidate duplicates and full Excel pack includes every retained sheet once', () => {
    const data = buildReportData(source());
    const packs = buildReportPacks(data);
    assert.equal(packs.length, 9);
    assert.deepEqual(packs.map(pack => pack.id), ['schedule', 'student-form', 'programs', 'student-form-grids', 'department-grids', 'rooms', 'capacity', 'conflicts', 'subjects']);
    const sheets = fullReportSheets(packs);
    assert.equal(sheets.length, packs.filter(pack => !pack.word).reduce((count, pack) => count + pack.sheets.length, 0) - 1);
    assert.equal(sheets.filter(sheet => sheet.sheetName === 'Schedule Grid').length, 1);
    assert.equal(sheets.filter(sheet => sheet.sheetName === 'Slot Capacity').length, 1);
    assert.ok(!sheets.some(sheet => /Risk|Footprint|Period Utilization/.test(sheet.sheetName)));
    assert.ok(sheets.every(sheet => Array.isArray(sheet.data)));
    assert.equal(buildReportPacks(buildReportData()).length, 9);
});

test('Program Schedule Grids exports a combined Schedule Grid followed by one grid per program', async () => {
    const data = buildReportData(source());
    const packs = buildReportPacks(data);
    const programs = packs.find(pack => pack.id === 'programs');
    assert.equal(programs.title, 'Program Schedule Grids');
    assert.deepEqual(programs.sheets.map(sheet => sheet.sheetName), ['Schedule Grid', 'P Grid', 'Q Grid', 'Unspecified Grid']);
    assert.equal(programs.sheets.length, Object.keys(data.programSchedulesMap).length + 1);
    assert.equal(programs.sheets[0].sheetName, 'Schedule Grid');
    assert.equal(programs.sheets[0].data[0].Student_Exam_Assignments, 150);
    assert.equal(programs.sheets[1].data[0]['09:00-11:00'], 'A (60)');
    assert.ok(!programs.sheets.some(sheet => /Detail|All Programs/.test(sheet.sheetName)));
    assert.equal(packs.find(pack => pack.id === 'department-grids').title, 'Detailed Schedule Grid');
    const { router, files } = exportRouter();
    assert.equal((await call(router, 'post', '/export-excel', { sheets_json: JSON.stringify(programs.sheets) })).statusCode, 200);
    const workbook = XLSX.read(files[0].content, { type: 'buffer' });
    assert.deepEqual(workbook.SheetNames, ['Schedule Grid', 'P Grid', 'Q Grid', 'Unspecified Grid']);
    assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets['P Grid'])[0]['09:00-11:00'], 'A (60)');
});

test('Student form exports date columns, actual period rows and program identifiers above each table', async () => {
    const input = source();
    // Different durations at the same start time must keep their own rows.
    input.periods.push({ id: 3, exam_date: '2026-12-25', start_time: '09:00', end_time: '12:00' });
    input.schedule.push({ ...input.schedule[0], exam_period_id: 3, end_time: '12:00', subject_code: 'LONG', student_count: 10, program_counts: 'P::10' });
    input.schedule.push({ ...input.schedule[0], subject_code: 'ZERO', student_count: 0, program_counts: '' });
    const data = buildReportData(input);
    const pack = buildReportPacks(data).find(pack => pack.id === 'student-form-grids');
    assert.equal(pack.title, 'Student form');
    assert.equal(pack.filename, 'final_student_form.xlsx');
    assert.deepEqual(pack.sheets.map(sheet => sheet.sheetName), ['All Programs Student Form', 'P Student Form', 'Q Student Form', 'Unspecified Student Form']);
    assert.equal(pack.sheets[0].title, 'Student form — All Programs');
    assert.equal(pack.sheets[1].title, 'Student form — P');
    assert.deepEqual(Object.keys(pack.sheets[0].data[0]), ['Period', '25/12/2026', '26/12/2026']);
    assert.deepEqual(pack.sheets[0].data.map(row => row.Period), ['09:00 - 11:00', '09:00 - 12:00', '12:00 - 15:00']);
    assert.equal(pack.sheets[0].data[0]['25/12/2026'], 'A (100)\nB (50)');
    assert.equal(pack.sheets[1].data[0]['25/12/2026'], 'A (60)');
    assert.equal(pack.sheets[1].data[1]['25/12/2026'], 'LONG (10)');
    assert.equal(pack.sheets[1].data[0]['26/12/2026'], '');
    assert.doesNotMatch(JSON.stringify(pack), /ZERO/);
    const { router, files } = exportRouter();
    assert.equal((await call(router, 'post', '/export-excel', { filename: pack.filename, sheets_json: JSON.stringify(pack.sheets) })).statusCode, 200);
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(files[0].content);
    for (const [index, sheet] of workbook.worksheets.entries()) {
        assert.equal(sheet.getCell('A1').value, pack.sheets[index].title);
        assert.equal(sheet.getCell('A1').font.bold, true);
        assert.equal(sheet.getCell('A1').font.size, 16);
        assert.equal(sheet.getCell('C1').isMerged, true);
        assert.equal(sheet.getCell('A2').value, 'Period');
        assert.equal(sheet.getCell('B2').value, '25/12/2026');
        assert.equal(sheet.getCell('C2').value, '26/12/2026');
        assert.equal(sheet.getCell('A3').value, '09:00 - 11:00');
        assert.equal(sheet.getCell('A4').value, '09:00 - 12:00');
        assert.equal(sheet.getCell('B3').value, pack.sheets[index].data[0]['25/12/2026']);
        assert.equal(sheet.getCell('B3').alignment.wrapText, true);
        assert.equal(sheet.views[0].xSplit, 1);
        assert.equal(sheet.views[0].ySplit, 2);
        assert.equal(sheet.autoFilter, undefined);
        for (const field of ['oddHeader', 'oddFooter', 'evenHeader', 'evenFooter', 'firstHeader', 'firstFooter']) {
            assert.ok(!sheet.headerFooter?.[field]);
        }
        assert.equal(sheet.pageSetup.printTitlesRow, '1:2');
        assert.equal(sheet.pageSetup.printTitlesColumn, 'A:A');
        assert.equal(sheet.pageSetup.printArea, 'A1:C5');
        assert.equal(sheet.pageSetup.orientation, 'landscape');
    }
    assert.equal(fullReportSheets(buildReportPacks(data)).filter(sheet => sheet.title?.startsWith('Student form — ')).length, 4);
    const empty = buildReportPacks(buildReportData()).find(pack => pack.id === 'student-form-grids');
    assert.deepEqual(empty.sheets[0].data, []);
});

test('detailed schedule grid workbook contains only departmental sheets with full subject details', async () => {
    const input = source();
    input.subjects[0].department = 'Science';
    input.subjects[1].department = 'Engineering';
    input.subjects[2].department = 'Arts';
    input.subjects[3].department = 'Arts';
    input.schedule[0].department = 'Science';
    input.schedule[0].subject_name = 'Algorithms';
    input.schedule[0].assigned_student_id_range = '100 - 159';
    input.schedule[1].department = 'Science';
    input.schedule[1].subject_name = 'Algorithms';
    input.schedule[1].assigned_student_id_range = '200 - 239';
    input.schedule[2].department = 'Engineering';
    input.schedule[2].subject_name = 'Networks';
    const data = buildReportData(input);
    const science = data.departmentScheduleGrids.Science;
    const engineering = data.departmentScheduleGrids.Engineering;
    const cell = science[0]['09:00-11:00'];
    assert.match(cell, /A - Algorithms/);
    assert.match(cell, /Programs: P \(60\), Unspecified \(40\)/);
    assert.match(cell, /Room: TH \| Students: 100/);
    assert.match(cell, /Student IDs: 100 - 159 \| 200 - 239/);
    assert.equal(cell.split('A - Algorithms').length - 1, 1);
    assert.equal(science[0].Day, 'Friday');
    assert.equal(science[0].Student_Exam_Assignments, 100);
    assert.equal(engineering[0].Student_Exam_Assignments, 50);
    assert.match(engineering[0]['09:00-11:00'], /B - Networks/);
    assert.match(engineering[0]['09:00-11:00'], /Room: LAB \| Students: 50/);
    assert.doesNotMatch(cell, /Networks/);
    assert.equal(science[1]['12:00-15:00'], '');
    assert.equal(data.departmentScheduleGrids.Arts[0].Student_Exam_Assignments, 0);
    assert.deepEqual(Object.keys(science[0]), Object.keys(engineering[0]));
    assert.equal(Object.values(data.departmentScheduleGrids).reduce((sum, rows) => sum + rows[0].Student_Exam_Assignments, 0), 150);
    const pack = buildReportPacks(data).find(pack => pack.id === 'department-grids');
    assert.deepEqual(pack.sheets.map(sheet => sheet.sheetName), ['Arts', 'Engineering', 'Science']);
    const { router, files } = exportRouter();
    assert.equal((await call(router, 'post', '/export-excel', { sheets_json: JSON.stringify(pack.sheets) })).statusCode, 200);
    const wb = XLSX.read(files[0].content, { type: 'buffer' });
    assert.equal(wb.SheetNames.length, 3);
    assert.ok(!wb.SheetNames.some(name => /All Departments|Combined/.test(name)));
    assert.equal(XLSX.utils.sheet_to_json(wb.Sheets.Science)[0]['09:00-11:00'], cell);
});

test('detailed department grids combine program splits and retain unspecified departments', () => {
    const input = source();
    input.schedule[1].program_counts = 'P::40';
    input.schedule[2].department = '';
    const data = buildReportData(input);
    assert.match(data.departmentScheduleGrids.Science[0]['09:00-11:00'], /Programs: P \(100\)/);
    assert.equal(data.departmentScheduleGrids.Unspecified[0].Student_Exam_Assignments, 50);
    assert.equal(Object.values(data.departmentScheduleGrids).reduce((sum, rows) => sum + rows[0].Student_Exam_Assignments, 0), 150);
    assert.ok(!Object.hasOwn(data, 'allDepartmentProgramsGrid'));
});

function exportRouter() {
    const filename = path.join(__dirname, '../routes/reports.js');
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    const files = [];
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, exports: module.exports, __dirname: path.dirname(filename), setTimeout: () => {},
        require: name => name === 'fs' ? { existsSync: () => true, writeFileSync: (name, content) => files.push({ name, content }) } : localRequire(name)
    });
    return { router: module.exports, files };
}

test('downloaded timetable persists readable styles, frozen panes and landscape print settings', async () => {
    const ExcelJS = require('exceljs');
    const { router, files } = exportRouter();
    const details = 'A - Algorithms\nPrograms: P (100)\nRoom: TH | Students: 100\nStudent IDs: 100 - 199';
    const data = [
        { Day_Index: 1, Day: 'Friday', Date: '2026-12-25', Student_Exam_Assignments: 100, '09:00-11:00': details },
        { Day_Index: 2, Day: 'Saturday', Date: '2026-12-26', Student_Exam_Assignments: 0, '09:00-11:00': '' }
    ];
    const response = await call(router, 'post', '/export-excel', { sheetName: 'Science', data_json: JSON.stringify(data) });
    assert.equal(response.statusCode, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(files[0].content);
    const sheet = workbook.getWorksheet('Science');
    assert.equal(sheet.getCell('A1').font.bold, true);
    assert.equal(sheet.getCell('A1').fill.fgColor.argb, 'FF183650');
    assert.equal(sheet.getCell('E2').alignment.wrapText, true);
    assert.equal(sheet.getCell('E2').alignment.vertical, 'top');
    assert.equal(sheet.getCell('E2').border.bottom.style, 'thin');
    assert.equal(sheet.getCell('E2').value, details);
    assert.equal(sheet.getCell('D3').value, 0);
    assert.equal(sheet.getCell('D3').numFmt, '#,##0');
    assert.notEqual(sheet.getCell('E2').fill.fgColor.argb, sheet.getCell('E3').fill.fgColor.argb);
    assert.ok(sheet.getColumn(5).width >= Math.max(...details.split('\n').map(line => line.length)) + 3);
    assert.ok(sheet.getRow(2).height >= 64);
    assert.equal(sheet.views[0].state, 'frozen');
    assert.equal(sheet.views[0].xSplit, 4);
    assert.equal(sheet.views[0].ySplit, 1);
    assert.equal(sheet.views[0].showGridLines, false);
    assert.equal(sheet.pageSetup.orientation, 'landscape');
    assert.equal(sheet.pageSetup.fitToWidth, 1);
    assert.equal(sheet.pageSetup.fitToHeight, 0);
    assert.equal(sheet.pageSetup.printTitlesRow, '1:1');
    assert.equal(sheet.pageSetup.printTitlesColumn, 'A:D');
    assert.equal(sheet.autoFilter, 'A1:E3');
});

test('schedule grids put each subject on one line and size cells to the subject count', async () => {
    const input = source();
    input.schedule[0].subject_name = 'Algorithms';
    input.schedule[1].subject_name = 'Algorithms';
    input.schedule[1].room_placement_type = 'LAB';
    input.schedule[0].assigned_student_id_range = '100 - 159';
    input.schedule[1].assigned_student_id_range = '200 - 239';
    const data = buildReportData(input);
    assert.equal(data.examScheduleGrid[0]['09:00-11:00'], 'A (100)\nB (50)');
    assert.equal(data.programSchedulesGridMap.P[0]['09:00-11:00'], 'A (60)');
    const details = data.departmentScheduleGrids.Science[0]['09:00-11:00'];
    const lines = details.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^A - Algorithms \| Programs: P \(60\), Unspecified \(40\) \| Room: LAB \(40\), TH \(60\) \| Students: 100 \| Student IDs: 100 - 159 \| 200 - 239$/);
    assert.match(lines[1], /^B \| Programs: Q \(50\) \| Room: LAB \| Students: 50$/);
    assert.equal(details.includes('\n\n'), false);

    const { router, files } = exportRouter();
    const response = await call(router, 'post', '/export-excel', { sheets_json: JSON.stringify([
        { sheetName: 'Schedule Grid', data: data.examScheduleGrid },
        { sheetName: 'Science', data: data.departmentScheduleGrids.Science }
    ]) });
    assert.equal(response.statusCode, 200);
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(files[0].content);
    const grid = workbook.getWorksheet('Schedule Grid');
    const detailed = workbook.getWorksheet('Science');
    assert.equal(grid.getCell('D2').value, 'A (100)\nB (50)');
    assert.equal(detailed.getCell('E2').value, details);
    assert.equal(grid.getRow(2).height, 36);
    assert.equal(detailed.getRow(2).height, 36);
    assert.equal(grid.getRow(3).height, 24);
    assert.ok(detailed.getColumn(5).width > Math.max(...lines.map(line => line.length)));
    assert.ok(grid.getColumn(4).width < 48);
    assert.equal(detailed.getCell('E2').alignment.wrapText, true);
    assert.equal(detailed.getCell('E2').font.size, 10);
});

test('formatted export supports empty sheets and preserves plain-table headers and values', async () => {
    const { router, files } = exportRouter();
    const response = await call(router, 'post', '/export-excel', { sheets_json: JSON.stringify([
        { sheetName: 'Empty', data: [] },
        { sheetName: 'Capacity', data: [{ Major_Cap: 0, Minor_Cap: 'Unlimited', Description: 'Long detail '.repeat(100) }] }
    ]) });
    assert.equal(response.statusCode, 200);
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(files[0].content);
    assert.equal(workbook.getWorksheet('Empty').rowCount, 0);
    const sheet = workbook.getWorksheet('Capacity');
    assert.equal(sheet.getCell('A1').value, 'Major_Cap');
    assert.equal(sheet.getCell('A2').value, 0);
    assert.equal(sheet.getCell('B2').value, 'Unlimited');
    assert.equal(sheet.getCell('C2').value, 'Long detail '.repeat(100));
    assert.ok(sheet.getRow(2).height <= 409);
    assert.equal(sheet.views[0].ySplit, 1);
});
async function call(router, method, route, body, db) {
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(body) { this.body = body; return this; } };
    await router.stack.find(layer => layer.route?.path === route && layer.route.methods[method]).route.stack[0].handle({ body, app: { locals: { db } } }, res);
    return res;
}

test('full report pack serializes to a real workbook, including long and case-colliding program sheet names', async () => {
    const input = source();
    input.schedule[0].program_counts = `${'Long Program '.repeat(5)}::60`;
    input.schedule[1].program_counts = 'ABC::40';
    input.schedule[2].program_counts = 'abc::50';
    const sheets = fullReportSheets(buildReportPacks(buildReportData(input)));
    const { router, files } = exportRouter();
    const result = await call(router, 'post', '/export-excel', { sheets_json: JSON.stringify(sheets), filename: 'report.html' });
    assert.equal(result.statusCode, 200);
    assert.match(result.body.url, /\.xlsx$/);
    const workbook = XLSX.read(files[0].content, { type: 'buffer' });
    assert.equal(workbook.SheetNames.length, sheets.length);
    assert.equal(new Set(workbook.SheetNames.map(name => name.toLowerCase())).size, sheets.length);
    assert.ok(workbook.SheetNames.every(name => name.length <= 31));
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets['Slot Capacity']);
    assert.equal(rows[0].Minor_Students, 50);
    assert.equal(rows[1].Major_Cap, 0);
});

test('export endpoints reject malformed data and force document extensions', async () => {
    const { router, files } = exportRouter();
    for (const body of [{ data_json: '{' }, { data_json: '{}' }, { sheets_json: JSON.stringify([{ data: {} }]) }]) {
        assert.equal((await call(router, 'post', '/export-excel', body)).statusCode, 400);
    }
    assert.equal((await call(router, 'post', '/export-word', { html: { unexpected: true } })).statusCode, 400);
    const first = await call(router, 'post', '/export-word', { html: '<p>Schedule</p>', filename: 'schedule.html' });
    const second = await call(router, 'post', '/export-word', { html: '<p>Schedule</p>', filename: 'schedule.html' });
    assert.match(first.body.url, /\.doc$/);
    assert.notEqual(first.body.url, second.body.url);
    assert.equal(files.length, 2);
});

test('remaining/no-final report APIs agree with actual assignments rather than stale status flags', async () => {
    const db = new SQL.Database();
    db.run('CREATE TABLE subjects(subject_code TEXT,status TEXT)');
    db.run('CREATE TABLE schedule(subject_code TEXT)');
    db.run("INSERT INTO subjects VALUES('A','unscheduled'),('B','scheduled'),('C','no_final_exam'),('D','no_final_exam')");
    db.run("INSERT INTO schedule VALUES('A'),('D')");
    const { router } = exportRouter();
    const remaining = await call(router, 'get', '/remaining', {}, db);
    assert.equal(remaining.body.length, 1);
    assert.equal(remaining.body[0].subject_code, 'B');
    assert.equal(remaining.body[0].status, 'unscheduled');
    const noFinal = await call(router, 'get', '/no-final', {}, db);
    assert.equal(noFinal.body.length, 1);
    assert.equal(noFinal.body[0].subject_code, 'C');
    db.close();
});
