const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db/db');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Initialize database then start
initDB().then(db => {
    // Share the db with routes
    app.locals.db = db;

    // API routes
    app.use('/api/students', require('./routes/students'));
    app.use('/api/subjects', require('./routes/subjects'));
    app.use('/api/periods', require('./routes/periods'));
    app.use('/api/schedule', require('./routes/schedule'));
    app.use('/api/conflicts', require('./routes/conflicts'));
    app.use('/api/reports', require('./routes/reports'));
    app.use('/api/audit', require('./routes/audit'));
    app.use('/api/auth', require('./routes/auth'));
    app.use('/api/dashboard', require('./routes/dashboard'));

    // Serve frontend in production
    const clientBuild = path.join(__dirname, '..', 'client', 'dist');
    app.use(express.static(clientBuild));
    app.get('*', (req, res) => {
        if (!req.path.startsWith('/api')) {
            res.sendFile(path.join(clientBuild, 'index.html'));
        }
    });

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🎓 ExamFlow server running on http://0.0.0.0:${PORT}`);
    });
}).catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
});
