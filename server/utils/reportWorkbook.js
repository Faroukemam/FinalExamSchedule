const ExcelJS = require('exceljs');

const slotColumn = /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/;
const dateColumn = /^\d{2}\/\d{2}\/\d{4}$/;
const gridColumn = key => slotColumn.test(key) || dateColumn.test(key);
const border = { style: 'thin', color: { argb: 'FFD7E0EB' } };

function columnWidth(key, rows) {
    if (gridColumn(key)) {
        let longest = key.length;
        for (const row of rows) {
            for (const line of String(row[key] ?? '').split('\n')) longest = Math.max(longest, line.length);
        }
        return Math.max(20, Math.min(255, longest + 4));
    }
    if (key === 'Day_Index') return 8;
    if (key === 'Period') return 20;
    if (key === 'Day') return 12;
    if (/Date/i.test(key)) return 14;
    if (key === 'Student_Exam_Assignments') return 18;
    const longest = Math.max(key.length, ...rows.slice(0, 100).map(row =>
        Math.max(...String(row[key] ?? '').split('\n').map(line => line.length))));
    return Math.max(14, Math.min(44, longest + 2));
}

function addReportSheet(workbook, name, rows, { title, autoFilter = true, printHeaderFooter = true } = {}) {
    // Preserve column names and values so exported files remain usable as data.
    const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
    const firstSlot = keys.findIndex(gridColumn);
    const grid = firstSlot >= 0;
    const hasTitle = typeof title === 'string' && Boolean(title.trim());
    const headerRow = hasTitle ? 2 : 1;
    const sheet = workbook.addWorksheet(name, {
        properties: { defaultRowHeight: 24, tabColor: { argb: grid ? 'FF0D9488' : 'FF24476A' } },
        views: [{ state: 'frozen', xSplit: grid ? firstSlot : 0, ySplit: keys.length ? headerRow : 0, showGridLines: false }],
        pageSetup: {
            paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
            margins: { left: 0.25, right: 0.25, top: 0.4, bottom: 0.4, header: 0.15, footer: 0.15 }
        },
        headerFooter: printHeaderFooter === false ? {} : { oddHeader: '&C&B' + name.replace(/&/g, '&&'), oddFooter: '&LExam Schedule&RPage &P of &N' }
    });
    if (!keys.length) return sheet;
    sheet.columns = keys.map(key => ({ key, width: columnWidth(key, rows) }));
    if (hasTitle) {
        const titleRow = sheet.addRow([title.trim()]);
        if (keys.length > 1) sheet.mergeCells(1, 1, 1, keys.length);
        titleRow.height = 36;
        const cell = titleRow.getCell(1);
        cell.font = { name: 'Calibri', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF183650' } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    }
    const header = sheet.addRow(keys);
    header.height = grid ? 36 : 44;
    header.eachCell(cell => {
        cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF183650' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        cell.border = { top: border, bottom: border, left: border, right: border };
    });
    rows.forEach((data, index) => {
        const row = sheet.addRow(keys.map(key => data[key] ?? null));
        let lines = 1;
        keys.forEach((key, column) => {
            const cell = row.getCell(column + 1);
            const timeCell = gridColumn(key);
            const numeric = typeof cell.value === 'number';
            const width = sheet.getColumn(column + 1).width - 3;
            // Explicit newlines and long subject/program names both affect height.
            lines = Math.max(lines, String(cell.value ?? '').split('\n').reduce((sum, line) =>
                sum + Math.max(1, Math.ceil(line.length / width)), 0));
            cell.font = { name: 'Calibri', size: grid ? 10 : 11, color: { argb: 'FF22364B' }, bold: grid && !timeCell };
            cell.alignment = { vertical: grid ? 'top' : 'middle', horizontal: numeric || (grid && !timeCell) ? 'center' : 'left', wrapText: true };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: grid && !timeCell
                ? (index % 2 ? 'FFE2EDF5' : 'FFEDF4F9') : (index % 2 ? 'FFF3F7FB' : 'FFFFFFFF') } };
            cell.border = { top: border, bottom: border, left: border, right: border };
            if (numeric) cell.numFmt = Number.isInteger(cell.value) ? '#,##0' : '#,##0.##';
        });
        row.height = Math.min(409, Math.max(grid ? 24 : 26, lines * (grid ? 14 : 16) + (grid ? 8 : 14)));
    });
    if (autoFilter !== false) {
        sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: rows.length + headerRow, column: keys.length } };
    }
    sheet.pageSetup.printTitlesRow = `1:${headerRow}`;
    if (grid && firstSlot) sheet.pageSetup.printTitlesColumn = `A:${sheet.getColumn(firstSlot).letter}`;
    sheet.pageSetup.printArea = `A1:${sheet.getColumn(keys.length).letter}${rows.length + headerRow}`;
    return sheet;
}

function createReportWorkbook() {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Exam Scheduler';
    return workbook;
}

module.exports = { createReportWorkbook, addReportSheet };
