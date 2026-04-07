const express = require('express');
const router = express.Router();

function resultToObjects(result) {
    if (!result || result.length === 0) return [];
    const columns = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        columns.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

// GET audit log
router.get('/', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { subject_code, action } = req.query;
        let query = `SELECT * FROM audit_log`;
        const conditions = [];
        const params = [];
        if (subject_code) { conditions.push(`subject_code LIKE ?`); params.push(`%${subject_code}%`); }
        if (action) { conditions.push(`action = ?`); params.push(action); }
        if (conditions.length) query += ` WHERE ` + conditions.join(' AND ');
        query += ` ORDER BY timestamp DESC LIMIT 500`;
        res.json(resultToObjects(db.exec(query, params)));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
