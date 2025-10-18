// routes/comments.js
const express = require('express');
const router = express.Router({ mergeParams: true });
const admin = require('firebase-admin');
const { verifyAuth } = require('../verifyAuth');

const db = admin.firestore();

/**
 * Firestore layout:
 * questions/{date}/answers/{answerId}/comments/{commentId}
 * Each comment has: text, userId, displayName, parentId, createdAt
 */

// ===== CREATE a comment or reply =====
// ===== CREATE a comment or reply =====
router.post('/', verifyAuth, async (req, res) => {
  try {
    const { date, answerId } = req.params;
    const { text, parentId = null } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Text is required' });
    }

    const user = req.user;
    let displayName = 'Anonymous';

    // ✅ Fetch displayName from Firestore users collection
    const userDoc = await db.collection('users').doc(user.uid).get();
    if (userDoc.exists) {
      displayName = userDoc.data().displayName || 'Anonymous';
    }

    const comment = {
      text: text.trim(),
      userId: user.uid,
      displayName, // ✅ now uses the Firestore username
      parentId: parentId || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const ref = db
      .collection('questions')
      .doc(date)
      .collection('answers')
      .doc(answerId)
      .collection('comments')
      .doc();

    await ref.set(comment);

    const saved = { id: ref.id, ...comment };

    if (req.io) {
      req.io.to(`answer:${answerId}`).emit('comment:created', saved);
    }

    return res.status(201).json(saved);
  } catch (err) {
    console.error('[POST /comments] Error:', err);
    return res.status(500).json({ error: err.message });
  }
});


// ===== GET all comments (flat or threaded) =====
router.get('/', async (req, res) => {
  try {
    const { date, answerId } = req.params;

    const snap = await db
      .collection('questions')
      .doc(date)
      .collection('answers')
      .doc(answerId)
      .collection('comments')
      .orderBy('createdAt', 'asc')
      .get();

    const comments = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    return res.json(comments);
  } catch (err) {
    console.error('[GET /comments] Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ===== DELETE comment (author or admin) =====
router.delete('/:commentId', verifyAuth, async (req, res) => {
  try {
    const { date, answerId, commentId } = req.params;
    const user = req.user;

    const ref = db
      .collection('questions')
      .doc(date)
      .collection('answers')
      .doc(answerId)
      .collection('comments')
      .doc(commentId);

    const doc = await ref.get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    const data = doc.data();
    if (data.userId !== user.uid && !user.admin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await ref.delete();

    const io = req.io;
    if (io) {
      io.to(`answer:${answerId}`).emit('comment:deleted', { id: commentId });
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /comments] Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
