// Player feedback (beta, week 8): POST /feedback stores a 1-5 rating and an optional comment;
// GET /feedback lists them for the team, but only with the FEEDBACK_TOKEN (Bearer header).
// Stored as JSON lines in FEEDBACK_FILE (default server/data/feedback.jsonl).
// Note: Render's free disk is wiped on every deploy/restart, so download the feedback before
// redeploying (or point FEEDBACK_FILE at a persistent disk).
const fs = require('fs');
const path = require('path');
const express = require('express');

const FILE = process.env.FEEDBACK_FILE || path.join(__dirname, 'data', 'feedback.jsonl');
const MAX_TEXT = 1000;
const LIMIT = 5; // submissions per IP per window
const WINDOW = 10 * 60 * 1000;
const PAGES = ['menu', 'game-over', 'lobby', 'game'];

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);

// Returns { entry } or { error } for a submitted body.
function validate(body) {
  const b = body && typeof body === 'object' ? body : {};
  const rating = Number(b.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { error: 'Pick a rating from 1 to 5' };
  const text = clean(b.text, MAX_TEXT);
  return {
    entry: {
      at: new Date().toISOString(),
      rating,
      text,
      page: PAGES.includes(b.page) ? b.page : 'menu',
      name: clean(b.name, 16) || null,
      gameId: clean(b.gameId, 40) || null,
    },
  };
}

function readAll() {
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function router({ token = process.env.FEEDBACK_TOKEN, now = Date.now } = {}) {
  const r = express.Router();
  const hits = new Map(); // ip -> [timestamps]

  r.post('/feedback', express.json({ limit: '4kb' }), (req, res) => {
    const ip = req.ip || 'unknown';
    const t = now();
    const recent = (hits.get(ip) || []).filter((x) => t - x < WINDOW);
    if (recent.length >= LIMIT) return res.status(429).json({ error: 'Thanks! You already sent a lot of feedback, try again later' });
    const { entry, error } = validate(req.body);
    if (error) return res.status(400).json({ error });
    recent.push(t);
    hits.set(ip, recent);
    if (hits.size > 5000) hits.clear(); // keep memory bounded
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.appendFileSync(FILE, JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error('Could not save feedback:', err.message);
      return res.status(500).json({ error: 'Could not save feedback' });
    }
    res.status(201).json({ ok: true });
  });

  // Team only. Without FEEDBACK_TOKEN configured the list is not served at all.
  r.get('/feedback', (req, res) => {
    if (!token) return res.status(404).end();
    if (req.get('authorization') !== `Bearer ${token}`) return res.status(401).json({ error: 'Unauthorized' });
    const all = readAll();
    const avg = all.length ? +(all.reduce((s, e) => s + e.rating, 0) / all.length).toFixed(2) : null;
    res.json({ count: all.length, averageRating: avg, latest: all.slice(-200).reverse() });
  });

  return r;
}

module.exports = { router, validate, FILE };
