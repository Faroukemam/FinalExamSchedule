const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'examflow.db');

function corruptBackupPath() {
    return path.join(
        __dirname,
        `examflow.corrupt.${new Date().toISOString().replace(/[:.]/g, '-')}.db`
    );
}

async function initDB() {
    const SQL = await initSqlJs();

    let db;
    if (fs.existsSync(DB_PATH)) {
        const buffer = fs.readFileSync(DB_PATH);
        try {
            db = new SQL.Database(buffer);
            // Force a lightweight read to verify the file is actually a valid SQLite database.
            db.exec(`SELECT name FROM sqlite_master LIMIT 1`);
        } catch (err) {
            const backupPath = corruptBackupPath();
            fs.copyFileSync(DB_PATH, backupPath);
            console.warn(`Database file is invalid. Backed up to ${backupPath} and created a new database.`);
            db = new SQL.Database();
        }
    } else {
        db = new SQL.Database();
    }

    // Enable WAL mode for better concurrency
    try {
        db.run('PRAGMA journal_mode=WAL');
        db.run('PRAGMA foreign_keys=ON');
    } catch (err) {
        if (fs.existsSync(DB_PATH)) {
            const backupPath = corruptBackupPath();
            fs.copyFileSync(DB_PATH, backupPath);
            console.warn(`Database pragmas failed. Backed up invalid database to ${backupPath} and recreated it.`);
        }
        db = new SQL.Database();
        db.run('PRAGMA journal_mode=WAL');
        db.run('PRAGMA foreign_keys=ON');
    }

    // Create tables
    db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('admin','coordinator','viewer')),
    department TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS students (
    student_id TEXT PRIMARY KEY,
    student_name TEXT NOT NULL,
    department TEXT,
    program TEXT,
    level TEXT,
    section TEXT
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    subject_code TEXT NOT NULL,
    UNIQUE(student_id, subject_code),
    FOREIGN KEY(student_id) REFERENCES students(student_id) ON DELETE CASCADE
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS subjects (
    subject_code TEXT PRIMARY KEY,
    subject_name TEXT DEFAULT '',
    department TEXT DEFAULT '',
    program TEXT DEFAULT '',
    level TEXT DEFAULT '',
    room_placement_type TEXT DEFAULT 'TH' CHECK(room_placement_type IN ('TH','LAB','DH')),
    capacity_type TEXT NOT NULL DEFAULT 'major' CHECK(capacity_type IN ('major', 'minor')),
    exam_duration INTEGER DEFAULT 120,
    student_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'unscheduled' CHECK(status IN ('scheduled','unscheduled','no_final_exam')),
    notes TEXT DEFAULT ''
  )`);

    const subjectsCols = db.exec(`PRAGMA table_info(subjects)`);
    const hasRoomPlacementType = subjectsCols.length > 0 &&
        subjectsCols[0].values.some(col => col[1] === 'room_placement_type');
    if (!hasRoomPlacementType) {
        db.run(`ALTER TABLE subjects ADD COLUMN room_placement_type TEXT DEFAULT 'TH'`);
        db.run(`UPDATE subjects SET room_placement_type = 'TH' WHERE room_placement_type IS NULL OR TRIM(room_placement_type) = ''`);
    }

    if (!subjectsCols[0].values.some(col => col[1] === 'capacity_type')) {
        db.run("ALTER TABLE subjects ADD COLUMN capacity_type TEXT NOT NULL DEFAULT 'major' CHECK(capacity_type IN ('major', 'minor'))");
    }

    db.run(`CREATE TABLE IF NOT EXISTS exam_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    student_cap INTEGER,
    major_cap INTEGER,
    minor_cap INTEGER,
    subject_cap INTEGER,
    UNIQUE(exam_date, start_time, end_time)
  )`);

    const examPeriodsCols = db.exec(`PRAGMA table_info(exam_periods)`);
    const hasStudentCap = examPeriodsCols.length > 0 &&
        examPeriodsCols[0].values.some(col => col[1] === 'student_cap');
    if (!hasStudentCap) {
        db.run(`ALTER TABLE exam_periods ADD COLUMN student_cap INTEGER`);
    }
    if (!examPeriodsCols[0].values.some(col => col[1] === 'major_cap')) {
        db.run('ALTER TABLE exam_periods ADD COLUMN major_cap INTEGER');
        db.run('UPDATE exam_periods SET major_cap = student_cap WHERE student_cap > 0');
    }
    if (!examPeriodsCols[0].values.some(col => col[1] === 'minor_cap')) {
        db.run('ALTER TABLE exam_periods ADD COLUMN minor_cap INTEGER');
    }
    if (!examPeriodsCols[0].values.some(col => col[1] === 'subject_cap')) {
        db.run('ALTER TABLE exam_periods ADD COLUMN subject_cap INTEGER');
    }

    db.run(`CREATE TABLE IF NOT EXISTS schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_period_id INTEGER NOT NULL,
    subject_code TEXT NOT NULL,
    target_program TEXT DEFAULT '',
    UNIQUE(exam_period_id, subject_code, target_program),
    FOREIGN KEY(exam_period_id) REFERENCES exam_periods(id) ON DELETE CASCADE,
    FOREIGN KEY(subject_code) REFERENCES subjects(subject_code) ON DELETE CASCADE
  )`);

    // Migration: normalize schedule schema to include target_program and composite uniqueness.
    const tableInfo = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='schedule'");
    const scheduleSql = tableInfo.length > 0 ? tableInfo[0].values[0][0] : '';
    const needsScheduleMigration =
        scheduleSql.includes('UNIQUE(subject_code)') ||
        !scheduleSql.includes('target_program') ||
        !scheduleSql.includes('UNIQUE(exam_period_id, subject_code, target_program)');

    if (needsScheduleMigration) {
        console.log("Migrating schedule table to program-aware schema...");
        db.run('PRAGMA foreign_keys=OFF');
        db.run('ALTER TABLE schedule RENAME TO schedule_old');
        db.run(`CREATE TABLE schedule (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exam_period_id INTEGER NOT NULL,
            subject_code TEXT NOT NULL,
            target_program TEXT DEFAULT '',
            UNIQUE(exam_period_id, subject_code, target_program),
            FOREIGN KEY(exam_period_id) REFERENCES exam_periods(id) ON DELETE CASCADE,
            FOREIGN KEY(subject_code) REFERENCES subjects(subject_code) ON DELETE CASCADE
        )`);

        const oldCols = db.exec(`PRAGMA table_info(schedule_old)`);
        const hasTargetProgram = oldCols.length > 0 && oldCols[0].values.some(c => c[1] === 'target_program');
        if (hasTargetProgram) {
            db.run(`INSERT INTO schedule (id, exam_period_id, subject_code, target_program)
                    SELECT id, exam_period_id, subject_code, COALESCE(target_program, '') FROM schedule_old`);
        } else {
            db.run(`INSERT INTO schedule (id, exam_period_id, subject_code, target_program)
                    SELECT id, exam_period_id, subject_code, '' FROM schedule_old`);
        }

        db.run('DROP TABLE schedule_old');
        db.run('PRAGMA foreign_keys=ON');
    }

    // Remove exact duplicate rows while preserving valid multi-period and multi-program assignments.
    const duplicateAssignments = db.exec(`
        SELECT subject_code, exam_period_id, COALESCE(target_program, '') as target_program, MAX(id) as keep_id
        FROM schedule
        GROUP BY subject_code, exam_period_id, COALESCE(target_program, '')
        HAVING COUNT(*) > 1
    `);
    if (duplicateAssignments.length > 0) {
        for (const row of duplicateAssignments[0].values) {
            const subjectCode = row[0];
            const periodId = row[1];
            const targetProgram = row[2];
            const keepId = row[3];
            db.run(`DELETE FROM schedule 
                    WHERE subject_code = ? AND exam_period_id = ? AND COALESCE(target_program, '') = ? AND id != ?`,
                [subjectCode, periodId, targetProgram, keepId]);
        }
    }

    db.run(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_name TEXT DEFAULT 'Admin',
    action TEXT NOT NULL,
    subject_code TEXT,
    old_value TEXT,
    new_value TEXT,
    timestamp TEXT DEFAULT (datetime('now'))
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS same_period_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_name TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

    db.run(`CREATE TABLE IF NOT EXISTS same_period_group_subjects (
    group_id INTEGER NOT NULL,
    subject_code TEXT NOT NULL UNIQUE,
    UNIQUE(group_id, subject_code),
    FOREIGN KEY(group_id) REFERENCES same_period_groups(id) ON DELETE CASCADE,
    FOREIGN KEY(subject_code) REFERENCES subjects(subject_code) ON DELETE CASCADE
  )`);

    // Default settings
    db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('back_to_back', 'warning')");
    db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('allow_multi_exam_subject', 'false')");

    // Seed default admin user
    const userCount = db.exec("SELECT COUNT(*) as c FROM users");
    if (userCount[0].values[0][0] === 0) {
        const hash = bcrypt.hashSync('admin123', 10);
        db.run("INSERT INTO users (username, password_hash, full_name, role) VALUES ('admin', ?, 'System Administrator', 'admin')", [hash]);
        db.run("INSERT INTO users (username, password_hash, full_name, role, department) VALUES ('coordinator', ?, 'Dept. Coordinator', 'coordinator', 'Computer Science')", [hash]);
        db.run("INSERT INTO users (username, password_hash, full_name, role) VALUES ('viewer', ?, 'Read Only User', 'viewer')", [hash]);
    }

    // Seed demo data
    const studentCount = db.exec("SELECT COUNT(*) as c FROM students");
    if (studentCount[0].values[0][0] === 0) {
        seedDemoData(db);
    }

    // Save function
    db.saveToFile = () => {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(DB_PATH, buffer);
    };

    // Auto-save every 5 seconds
    setInterval(() => {
        try { db.saveToFile(); } catch (e) { }
    }, 5000);

    // Save on first init
    db.saveToFile();

    return db;
}

function seedDemoData(db) {
    const departments = ['Computer Science', 'Information Systems', 'Software Engineering'];
    const programs = ['BSc CS', 'BSc IS', 'BSc SE'];
    const levels = ['Freshman', 'Sophomore', 'Junior', 'Senior'];

    // Subjects
    const subjects = [
        ['CSE101', 'Introduction to Computer Science', 'Computer Science', 'BSc CS', 'Freshman'],
        ['CSE201', 'Data Structures', 'Computer Science', 'BSc CS', 'Sophomore'],
        ['CSE301', 'Algorithms', 'Computer Science', 'BSc CS', 'Junior'],
        ['CSE310', 'Database Systems', 'Computer Science', 'BSc CS', 'Junior'],
        ['CSE320', 'Operating Systems', 'Computer Science', 'BSc CS', 'Junior'],
        ['CSE401', 'Software Engineering', 'Computer Science', 'BSc CS', 'Senior'],
        ['CSE410', 'Computer Networks', 'Computer Science', 'BSc CS', 'Senior'],
        ['CSE420', 'Artificial Intelligence', 'Computer Science', 'BSc CS', 'Senior'],
        ['CSE450', 'Machine Learning', 'Computer Science', 'BSc CS', 'Senior'],
        ['CSE460', 'Cybersecurity', 'Computer Science', 'BSc CS', 'Senior'],
        ['CSE470', 'Cloud Computing', 'Computer Science', 'BSc CS', 'Senior'],
        ['CSE565', 'Advanced Topics in AI', 'Computer Science', 'BSc CS', 'Senior'],
        ['CSE575', 'Deep Learning', 'Computer Science', 'BSc CS', 'Senior'],
        ['ISE201', 'Information Systems Fundamentals', 'Information Systems', 'BSc IS', 'Sophomore'],
        ['ISE301', 'Systems Analysis', 'Information Systems', 'BSc IS', 'Junior'],
        ['ISE310', 'Business Intelligence', 'Information Systems', 'BSc IS', 'Junior'],
        ['ISE401', 'IT Project Management', 'Information Systems', 'BSc IS', 'Senior'],
        ['SWE201', 'Software Design Patterns', 'Software Engineering', 'BSc SE', 'Sophomore'],
        ['SWE301', 'Software Testing', 'Software Engineering', 'BSc SE', 'Junior'],
        ['SWE310', 'Web Development', 'Software Engineering', 'BSc SE', 'Junior'],
        ['SWE401', 'DevOps Engineering', 'Software Engineering', 'BSc SE', 'Senior'],
        ['MTH101', 'Calculus I', 'Computer Science', 'BSc CS', 'Freshman'],
        ['MTH201', 'Linear Algebra', 'Computer Science', 'BSc CS', 'Sophomore'],
        ['MTH301', 'Probability & Statistics', 'Computer Science', 'BSc CS', 'Junior'],
        ['PHY101', 'Physics I', 'Computer Science', 'BSc CS', 'Freshman'],
        ['ENG101', 'English Composition', 'Computer Science', 'BSc CS', 'Freshman'],
        ['GEN100', 'University Skills', 'Computer Science', 'BSc CS', 'Freshman'],
        ['GEN200', 'Ethics in Technology', 'Computer Science', 'BSc CS', 'Sophomore'],
        ['CSE480', 'Capstone Project', 'Computer Science', 'BSc CS', 'Senior'],
        ['ISE480', 'IS Capstone Project', 'Information Systems', 'BSc IS', 'Senior'],
    ];

    for (const [code, name, dept, prog, lvl] of subjects) {
        db.run(`INSERT OR IGNORE INTO subjects (subject_code, subject_name, department, program, level, status)
            VALUES (?, ?, ?, ?, ?, 'unscheduled')`, [code, name, dept, prog, lvl]);
    }

    // Mark capstone projects as no_final_exam
    db.run("UPDATE subjects SET status='no_final_exam', notes='Project-based assessment' WHERE subject_code IN ('CSE480','ISE480')");

    // Generate students and registrations
    const firstNames = ['Ahmed', 'Sara', 'Mohammed', 'Fatima', 'Omar', 'Layla', 'Ali', 'Noor', 'Khalid', 'Hana', 'Yousef', 'Mariam', 'Hassan', 'Aisha', 'Faisal', 'Reem', 'Tariq', 'Dana', 'Zaid', 'Lina', 'Ibrahim', 'Salma', 'Nasser', 'Maha', 'Hamad', 'Rania', 'Sami', 'Dina', 'Khaled', 'Noura'];
    const lastNames = ['Al-Rashid', 'Al-Faris', 'Al-Saud', 'Al-Nasser', 'Al-Qahtani', 'Al-Zahrani', 'Al-Ghamdi', 'Al-Shehri', 'Al-Dosari', 'Al-Malki', 'Al-Harbi', 'Al-Otaibi', 'Al-Mutairi', 'Al-Yami', 'Al-Asmari'];

    // Course pools by level
    const coursesByLevel = {
        'Freshman': ['CSE101', 'MTH101', 'PHY101', 'ENG101', 'GEN100'],
        'Sophomore': ['CSE201', 'MTH201', 'ISE201', 'SWE201', 'GEN200'],
        'Junior': ['CSE301', 'CSE310', 'CSE320', 'ISE301', 'ISE310', 'SWE301', 'SWE310', 'MTH301'],
        'Senior': ['CSE401', 'CSE410', 'CSE420', 'CSE450', 'CSE460', 'CSE470', 'CSE565', 'CSE575', 'ISE401', 'SWE401', 'CSE480', 'ISE480']
    };

    let studentNum = 1;
    for (let i = 0; i < 100; i++) {
        const studentId = `STU${String(1000 + studentNum).padStart(5, '0')}`;
        const fn = firstNames[i % firstNames.length];
        const ln = lastNames[i % lastNames.length];
        const deptIdx = i % 3;
        const dept = departments[deptIdx];
        const prog = programs[deptIdx];
        const levelIdx = Math.floor(i / 25) % 4;
        const level = levels[levelIdx];
        const section = String.fromCharCode(65 + (i % 3));

        db.run(`INSERT OR IGNORE INTO students (student_id, student_name, department, program, level, section)
            VALUES (?, ?, ?, ?, ?, ?)`, [studentId, `${fn} ${ln}`, dept, prog, level, section]);

        // Register for courses based on level
        const pool = coursesByLevel[level];
        const numCourses = 4 + Math.floor(Math.random() * 3); // 4-6 courses
        const selectedCourses = new Set();
        while (selectedCourses.size < Math.min(numCourses, pool.length)) {
            selectedCourses.add(pool[Math.floor(Math.random() * pool.length)]);
        }
        // Add some cross-level courses for conflict potential
        if (Math.random() > 0.6 && levelIdx < 3) {
            const nextPool = coursesByLevel[levels[levelIdx + 1]];
            selectedCourses.add(nextPool[Math.floor(Math.random() * nextPool.length)]);
        }

        for (const courseCode of selectedCourses) {
            db.run(`INSERT OR IGNORE INTO registrations (student_id, subject_code)
              VALUES (?, ?)`, [studentId, courseCode]);
        }

        studentNum++;
    }

    // Update student counts
    const counts = db.exec(`SELECT subject_code, COUNT(DISTINCT student_id) as cnt FROM registrations GROUP BY subject_code`);
    if (counts.length > 0) {
        for (const row of counts[0].values) {
            db.run(`UPDATE subjects SET student_count = ? WHERE subject_code = ?`, [row[1], row[0]]);
        }
    }

    // Create some exam periods (2 weeks of exams)
    const examDates = [
        '2026-05-10', '2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14',
        '2026-05-17', '2026-05-18', '2026-05-19', '2026-05-20', '2026-05-21'
    ];
    const timePeriods = [
        ['09:00', '11:00'],
        ['12:00', '14:00'],
        ['15:00', '17:00']
    ];

    for (const date of examDates) {
        for (const [start, end] of timePeriods) {
            db.run(`INSERT OR IGNORE INTO exam_periods (exam_date, start_time, end_time)
              VALUES (?, ?, ?)`, [date, start, end]);
        }
    }

    // Schedule a few subjects to demonstrate the grid
    const scheduledItems = [
        ['CSE101', '2026-05-10', '09:00', '11:00'],
        ['MTH101', '2026-05-10', '09:00', '11:00'], // Same period - creates conflict
        ['CSE201', '2026-05-10', '12:00', '14:00'],
        ['CSE301', '2026-05-11', '09:00', '11:00'],
        ['CSE310', '2026-05-11', '12:00', '14:00'],
        ['CSE320', '2026-05-12', '09:00', '11:00'],
        ['CSE401', '2026-05-12', '15:00', '17:00'],
        ['MTH201', '2026-05-13', '09:00', '11:00'],
        ['ISE201', '2026-05-13', '12:00', '14:00'],
    ];

    for (const [code, date, start, end] of scheduledItems) {
        const period = db.exec(`SELECT id FROM exam_periods WHERE exam_date=? AND start_time=? AND end_time=?`, [date, start, end]);
        if (period.length > 0 && period[0].values.length > 0) {
            const periodId = period[0].values[0][0];
            db.run(`INSERT OR IGNORE INTO schedule (exam_period_id, subject_code) VALUES (?, ?)`, [periodId, code]);
            db.run(`UPDATE subjects SET status='scheduled' WHERE subject_code=?`, [code]);
        }
    }

    console.log('✅ Demo data seeded: 100 students, 30 subjects, 10 exam days');
}

module.exports = { initDB };
