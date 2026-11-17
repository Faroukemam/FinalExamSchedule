function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

export function buildStudentScheduleHtml(rows, periods) {
    if (!rows.length) return ''
    const slotKeys = Object.keys(rows[0]).filter(key => key !== 'Day' && key !== 'Date' && !key.endsWith(' Actual_Students'))
    const slotMeta = slotKeys.map((slot, index) => {
        const relatedPeriods = periods
            .filter(period => period.start_time === slot)
            .slice()
            .sort((a, b) => String(a.end_time || '').localeCompare(String(b.end_time || '')))
        const endTimes = [...new Set(relatedPeriods.map(period => String(period.end_time || '').trim()).filter(Boolean))]
        const timeLabel = endTimes.length === 0
            ? slot
            : endTimes.length === 1
                ? `${slot} - ${endTimes[0]}`
                : `${slot} - ${endTimes.join(' / ')}`
        return {
            slot,
            periodLabel: `Period ${index + 1}`,
            timeLabel
        }
    })
    const headerPeriods = slotMeta.map(meta => `
        <th colspan="2" style="border:1px solid #222;padding:6px 4px;text-align:center;background:#ececec;font-size:10pt;">${escapeHtml(meta.periodLabel)}</th>
    `).join('')
    const headerSlots = slotMeta.map(meta => `
        <th colspan="2" style="border:1px solid #222;padding:6px 4px;text-align:center;background:#f4f4f4;font-size:10pt;">${escapeHtml(meta.timeLabel)}</th>
    `).join('')
    const headerSubs = slotMeta.map(meta => `
        <th class="slot-subject" style="border:1px solid #222;padding:6px 4px;text-align:center;background:#fafafa;">Subject</th>
        <th class="slot-count" style="border:1px solid #222;padding:6px 4px;text-align:center;background:#fafafa;">Actual Students</th>
    `).join('')
    const bodyRows = rows.map(row => {
        const cells = slotMeta.map(meta => `
            <td class="slot-subject" style="border:1px solid #222;padding:10px 8px;vertical-align:top;height:58px;">${escapeHtml(row[meta.slot] || '')}</td>
            <td class="slot-count" style="border:1px solid #222;padding:10px 8px;text-align:center;height:58px;">${escapeHtml(row[`${meta.slot} Actual_Students`] ?? '')}</td>
        `).join('')
        return `
            <tr>
                <td class="day-col" style="border:1px solid #222;padding:10px 8px;text-align:center;font-weight:700;">${escapeHtml(row.Day || '')}</td>
                <td class="date-col" style="border:1px solid #222;padding:10px 8px;text-align:center;font-weight:700;">${escapeHtml(row.Date || '')}</td>
                ${cells}
            </tr>
        `
    }).join('')

    const html = `
        <html>
        <head>
            <meta charset="utf-8" />
            <title>University Form</title>
            <style>
                @page {
                    size: A4 landscape;
                    margin: 8mm;
                }
                body {
                    font-family: "Times New Roman", serif;
                    margin: 0;
                    color: #111;
                }
                h1 {
                    text-align: center;
                    margin: 0 0 10px 0;
                    font-size: 18pt;
                }
                .report-wrap {
                    width: 100%;
                }
                table {
                    border-collapse: collapse;
                    width: 100%;
                    table-layout: fixed;
                    font-size: 9pt;
                    border: 2px solid #111;
                }
                thead {
                    display: table-header-group;
                }
                tr {
                    page-break-inside: avoid;
                }
                th, td {
                    word-wrap: break-word;
                    overflow-wrap: anywhere;
                }
                .day-col {
                    width: 7%;
                }
                .date-col {
                    width: 8%;
                }
                .slot-subject {
                    width: 12%;
                }
                .slot-count {
                    width: 4.5%;
                }
            </style>
        </head>
        <body>
            <div class="report-wrap">
            <h1>University Form</h1>
            <table>
                <thead>
                    <tr>
                        <th class="day-col" rowspan="3" style="border:1px solid #222;padding:8px 6px;text-align:center;background:#e9e9e9;">Day</th>
                        <th class="date-col" rowspan="3" style="border:1px solid #222;padding:8px 6px;text-align:center;background:#e9e9e9;">Date</th>
                        ${headerPeriods}
                    </tr>
                    <tr>
                        ${headerSlots}
                    </tr>
                    <tr>
                        ${headerSubs}
                    </tr>
                </thead>
                <tbody>
                    ${bodyRows}
                </tbody>
            </table>
            </div>
        </body>
        </html>
    `

    return html
}
