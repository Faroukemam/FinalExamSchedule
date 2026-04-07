const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

function resultToObjects(result) {
    if (!result || result.length === 0) return [];
    const columns = result[0].columns;
    return result[0].values.map(row => {
        const obj = {};
        columns.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
    });
}

// POST login
router.post('/login', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { username, password } = req.body;
        const result = db.exec(`SELECT * FROM users WHERE username = ?`, [username]);
        const users = resultToObjects(result);
        if (users.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

        const user = users[0];
        if (!bcrypt.compareSync(password, user.password_hash)) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        res.json({
            id: user.id,
            username: user.username,
            full_name: user.full_name,
            role: user.role,
            department: user.department
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET users
router.get('/users', (req, res) => {
    const db = req.app.locals.db;
    try {
        const result = db.exec(`SELECT id, username, full_name, role, department, created_at FROM users`);
        res.json(resultToObjects(result));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET settings
router.get('/settings', (req, res) => {
    const db = req.app.locals.db;
    try {
        const result = db.exec(`SELECT * FROM settings`);
        const settings = {};
        if (result.length) {
            for (const row of result[0].values) {
                settings[row[0]] = row[1];
            }
        }
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT update settings
router.put('/settings', (req, res) => {
    const db = req.app.locals.db;
    try {
        const { key, value } = req.body;
        db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`, [key, value]);
        db.saveToFile();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
