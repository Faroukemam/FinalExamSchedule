import * as XLSX from 'xlsx'

export function readSlotWorkbook(buffer) {
    // Keep native Excel serials for server-side conversion, including 1904 workbooks.
    const workbook = XLSX.read(buffer, { type: 'array', raw: true })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    if (!sheet) throw new Error('The workbook has no worksheets')
    const data = XLSX.utils.sheet_to_json(sheet, { raw: true, defval: null }).map(row => ({
        ...row,
        _row_number: row.__rowNum__ + 1
    }))
    if (!data.length) throw new Error('The first worksheet contains no slot rows')
    return { data, date1904: !!workbook.Workbook?.WBProps?.date1904 }
}

export function slotImportFeedback(result) {
    const message = `Imported ${result.imported} slots, updated ${result.updated}, rejected ${result.failed || 0} rows`
    return { message, type: !result.success ? 'error' : result.partial ? 'warning' : 'success' }
}
