const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { verifyAuth } = require('../verifyAuth');

const db = admin.firestore();

/**
 * POST /api/answers
 * Create answer for today's question (auth required)
 */
router.post('/', verifyAuth, async (req, res) => {
  try {
    const { text, displayName = 'Anonymous' } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Answer text is required.' });
    }

    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const answerRef = db.collection('questions').doc(today).collection('answers').doc();

    const answerData = {
      text: text.trim(),
      userId: req.user.uid, // from verified token
      displayName,
      votes: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      highlighted: false,
      isPremium: false,        // ✅ default
      premiumStyle: {},        // ✅ default
    };

    await answerRef.set(answerData);

    const io = req.app.get('io');
    if (io) {
      io.to(today).emit('answer:created', {
        id: answerRef.id,
        ...answerData,
        createdAt: Date.now(),
      });
    }

    res.status(201).json({ id: answerRef.id, ...answerData });
  } catch (err) {
    console.error('🔥 Error saving answer:', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

/**
 * POST /api/answers/:date
 * Create answer for a specific YYYY-MM-DD (auth required)
 */
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
      await qRef.set({
        text: '(auto-created)',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    const answerRef = qRef.collection('answers').doc();

    const answerData = {
      text: text.trim(),
      userId: req.user.uid,
      displayName,
      votes: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      highlighted: false,
      isPremium: false,        // ✅ default
      premiumStyle: {},        // ✅ default
    };

    await answerRef.set(answerData);

    const io = req.app.get('io');
    if (io) {
      io.to(date).emit('answer:created', {
        id: answerRef.id,
        ...answerData,
        createdAt: Date.now(),
      });
    }

    res.status(201).json({ id: answerRef.id, ...answerData });
  } catch (err) {
    console.error('🔥 Error saving answer (dated):', err);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

/**
 * POST /api/answers/:date/:answerId/premium
 * Activate or update premium design for an answer (auth required)
 */
router.post('/:date/:answerId/premium', verifyAuth, async (req, res) => {
  try {
    const { date, answerId } = req.params;
    const { style } = req.body;

    if (!style || typeof style !== 'object') {
      return res.status(400).json({ error: 'Style data missing or invalid.' });
    }

    const ref = db
      .collection('questions')
      .doc(date)
      .collection('answers')
      .doc(answerId);

    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ error: 'Answer not found.' });
    }

    const data = snap.data();
    if (data.userId !== req.user.uid) {
      return res.status(403).json({ error: 'You can only style your own answers.' });
    }

    await ref.update({
      isPremium: true,
      premiumStyle: style,
    });

    res.json({ message: '✅ Premium style applied successfully.' });
  } catch (err) {
    console.error('🔥 Error in POST /answers/:date/:answerId/premium:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

