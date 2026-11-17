export async function downloadExcelFromBackend(filename, sheetName, data) {
    try {
        // Step 1: Send data to backend to generate the file
        const res = await fetch('/api/reports/export-excel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, sheetName, data_json: JSON.stringify(data) })
        });

        if (!res.ok) throw new Error('Failed to generate export file');

        const { url } = await res.json();

        // Step 2: Trigger standard browser GET download
        // Because the URL ends in .xlsx (e.g. /uploads/12345_exam_schedule.xlsx), 
        // the browser will natively save it with that extension and name.
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url; // Hits the backend directly relative to the frontend Vite proxy
        a.download = filename; // Still attempt to provide nice clean filename
        document.body.appendChild(a);
        a.click();

        // Cleanup
        setTimeout(() => {
            if (document.body.contains(a)) {
                document.body.removeChild(a);
            }
        }, 100);
        return true;
    } catch (err) {
        console.error("Export error:", err);
        alert("Export failed: " + err.message);
        return false;
    }
}

export async function downloadMultiSheetExcelFromBackend(filename, sheets) {
    try {
        const res = await fetch('/api/reports/export-excel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, sheets_json: JSON.stringify(sheets) })
        });

        if (!res.ok) throw new Error('Failed to generate export file');

        const { url } = await res.json();
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();

        setTimeout(() => {
            if (document.body.contains(a)) {
                document.body.removeChild(a);
            }
        }, 100);
        return true;
    } catch (err) {
        console.error("Export error:", err);
        alert("Export failed: " + err.message);
        return false;
    }
}

export async function downloadWordFromBackend(filename, html) {
    try {
        const res = await fetch('/api/reports/export-word', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, html })
        });

        if (!res.ok) throw new Error('Failed to generate Word file');

        const { url } = await res.json();
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();

        setTimeout(() => {
            if (document.body.contains(a)) {
                document.body.removeChild(a);
            }
        }, 100);
        return true;
    } catch (err) {
        console.error("Export error:", err);
        alert("Export failed: " + err.message);
        return false;
    }
}
