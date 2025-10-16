const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { verifyAuth } = require('../verifyAuth');

const db = admin.firestore();

// POST /api/answers -> create answer for today's question (auth required)
router.post('/', verifyAuth, async (req, res) => {
  try {
    const { text, displayName = 'Anonymous' } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Answer text is required.' });
    }

    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const answerRef = db.collection('questions').doc(today).collection('answers').doc();

    await answerRef.set({
      text: text.trim(),
      userId: req.user.uid, // from verified token
      displayName,
      votes: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      highlighted: false,
    });
    const io = req.app.get('io');
    if (io) {
      io.to(today).emit('answer:created', {
        id: answerRef.id,
        text: text.trim(),
        userId: req.user.uid,
        displayName,
        votes: 0,
        createdAt: Date.now(),
      });
    }
    res.status(201).json({ id: answerRef.id, message: 'Answer submitted successfully.' });
  } catch (err) {
    console.error('Error saving answer:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});
// ADD this under your existing POST '/' route

// POST /api/answers/:date  -> create answer for a specific YYYY-MM-DD (auth required)
router.post('/:date', verifyAuth, async (req, res) => {
  try {
    const { date } = req.params;
    const { text, displayName = 'Anonymous' } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format (YYYY-MM-DD)' });
    }
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Answer text is required.' });
    }

    const qRef = db.collection('questions').doc(date);
    const qSnap = await qRef.get();
    if (!qSnap.exists) {
      await qRef.set({ text: '(auto-created)', createdAt: admin.firestore.FieldValue.serverTimestamp() });
    }

    const answerRef = qRef.collection('answers').doc();
    await answerRef.set({
      text: text.trim(),
      userId: req.user.uid,
      displayName,
      votes: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      highlighted: false,
    });

    // emit realtime to that date room
    const io = req.app.get('io');
    if (io) {
      io.to(date).emit('answer:created', {
        id: answerRef.id, text: text.trim(), userId: req.user.uid, displayName, votes: 0, createdAt: Date.now(),
      });
    }

    res.status(201).json({ id: answerRef.id, message: 'Answer submitted successfully.' });
  } catch (err) {
    console.error('Error saving answer (dated):', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});
// ADD this under your existing POST '/' route



module.exports = router;
