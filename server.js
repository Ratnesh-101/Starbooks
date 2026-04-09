const express = require('express');
const mysql   = require('mysql2');
const cors    = require('cors');
const path    = require('path');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'starbooks_secret_change_in_production';
const SALT_ROUNDS = 10;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend')));

// ── Database connection ──────────────────────────────────────────────
const db = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               process.env.DB_PORT     || 3307,
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASSWORD || '',
  database:           process.env.DB_NAME     || 'openlibrary',
  waitForConnections: true,
  connectionLimit:    10,
});

db.getConnection((err) => {
  if (err) { console.error('❌ DB connection failed:', err.message); return; }
  console.log('✅ Connected to MySQL (openlibrary)');
});

// ── Helper: tag-based similarity score ──────────────────────────────
function scoreByTags(books, wantedTags) {
  return books
    .map(b => {
      const bookTags = (b.tags || '').toLowerCase().split(',').map(t => t.trim());
      const matches  = bookTags.filter(t => wantedTags.includes(t)).length;
      return { ...b, _score: matches * 10 + parseFloat(b.rating || 0) };
    })
    .sort((a, b) => b._score - a._score);
}

// ── GET /books  — search or list all ─────────────────────────────────
app.get('/books', (req, res) => {
  const { q, subject } = req.query;

  let sql    = 'SELECT * FROM books';
  let params = [];

  if (q && subject) {
    const like = `%${q}%`;
    sql   += ' WHERE subject = ? AND (title LIKE ? OR author LIKE ? OR description LIKE ?)';
    params = [subject, like, like, like];
  } else if (q) {
    const like = `%${q}%`;
    sql   += ' WHERE title LIKE ? OR author LIKE ? OR description LIKE ? OR tags LIKE ?';
    params = [like, like, like, like];
  } else if (subject) {
    sql   += ' WHERE subject = ?';
    params = [subject];
  }

  sql += ' ORDER BY rating DESC, id ASC';

  db.query(sql, params, (err, results) =>
    err ? res.status(500).json({ error: err.message }) : res.json(results)
  );
});

// ── GET /books/recommend ─────────────────────────────────────────────
app.get('/books/recommend', (req, res) => {
  const { interests } = req.query;

  db.query('SELECT * FROM books', (err, books) => {
    if (err) return res.status(500).json({ error: err.message });

    if (!interests) {
      return res.json(books.sort((a, b) => b.rating - a.rating));
    }

    const wantedTags = interests.toLowerCase().split(',').map(t => t.trim());
    res.json(scoreByTags(books, wantedTags));
  });
});

// ── GET /books/:id ───────────────────────────────────────────────────
app.get('/books/:id', (req, res) => {
  db.query('SELECT * FROM books WHERE id = ?', [req.params.id], (err, results) => {
    if (err)              return res.status(500).json({ error: err.message });
    if (!results.length)  return res.status(404).json({ error: 'Book not found' });
    res.json(results[0]);
  });
});

// ── GET /books/:id/similar ───────────────────────────────────────────
app.get('/books/:id/similar', (req, res) => {
  const id = req.params.id;
  db.query('SELECT * FROM books WHERE id = ?', [id], (err, r) => {
    if (err || !r.length) return res.status(404).json({ error: 'Not found' });

    const book       = r[0];
    const bookTags   = (book.tags || '').toLowerCase().split(',').map(t => t.trim());

    db.query('SELECT * FROM books WHERE id != ?', [id], (err2, others) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json(scoreByTags(others, bookTags).slice(0, 6));
    });
  });
});

// ── GET /subjects ────────────────────────────────────────────────────
app.get('/subjects', (req, res) => {
  db.query('SELECT DISTINCT subject FROM books ORDER BY subject', (err, r) =>
    err ? res.status(500).json({ error: err.message }) : res.json(r.map(x => x.subject))
  );
});

// ── POST /books/:id/rate ─────────────────────────────────────────────
app.post('/books/:id/rate', (req, res) => {
  const { rating } = req.body;
  const bookId = req.params.id;

  if (!rating || rating < 1 || rating > 5)
    return res.status(400).json({ error: 'Rating must be 1–5' });

  db.query(
    'INSERT INTO user_ratings (book_id, rating) VALUES (?, ?)',
    [bookId, rating],
    (err) => {
      if (err) return res.status(500).json({ error: err.message });

      // Recalculate average from all ratings
      db.query(
        `UPDATE books SET
           rating       = (SELECT ROUND(AVG(rating),2) FROM user_ratings WHERE book_id = ?),
           rating_count = (SELECT COUNT(*)             FROM user_ratings WHERE book_id = ?)
         WHERE id = ?`,
        [bookId, bookId, bookId],
        (err2) => err2
          ? res.status(500).json({ error: err2.message })
          : res.json({ message: 'Rating saved!', rating })
      );
    }
  );
});

// ── POST /books/:id/view ─────────────────────────────────────────────
app.post('/books/:id/view', (req, res) => {
  db.query('INSERT INTO user_views (book_id) VALUES (?)', [req.params.id], (err) =>
    err ? res.status(500).json({ error: err.message }) : res.json({ ok: true })
  );
});

// ── POST /auth/signup ─────────────────────────────────────────────────
app.post('/auth/signup', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password)
    return res.status(400).json({ error: 'Name, email, and password are required.' });

  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  try {
    db.query('SELECT id FROM users WHERE email = ?', [email], async (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      if (rows.length) return res.status(409).json({ error: 'Email already in use.' });

      const hash = await bcrypt.hash(password, SALT_ROUNDS);

      db.query(
        'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
        [name, email, hash],
        (err2, result) => {
          if (err2) return res.status(500).json({ error: err2.message });

          const token = jwt.sign(
            { id: result.insertId, name, email },
            JWT_SECRET,
            { expiresIn: '7d' }
          );

          res.status(201).json({
            message: 'Account created successfully!',
            token,
            user: { id: result.insertId, name, email }
          });
        }
      );
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /auth/login ──────────────────────────────────────────────────
app.post('/auth/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res.status(400).json({ error: 'Email and password are required.' });

  db.query('SELECT * FROM users WHERE email = ?', [email], async (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!rows.length) return res.status(401).json({ error: 'Invalid email or password.' });

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) return res.status(401).json({ error: 'Invalid email or password.' });

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful!',
      token,
      user: { id: user.id, name: user.name, email: user.email }
    });
  });
});

// ── GET /auth/me  (verify token + return user info) ───────────────────
app.get('/auth/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided.' });

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ user: { id: decoded.id, name: decoded.name, email: decoded.email } });
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
});

// ── Catch-all → serve index.html ─────────────────────────────────────
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'))
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));