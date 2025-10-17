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
router.post('/', verifyAuth, async (req, res) => {
  try {
    const { date, answerId } = req.params;
    const { text, parentId = null } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Text is required' });
    }

    const user = req.user;
    const comment = {
      id: null, // will fill in later
      text: text.trim(),
      userId: user.uid,
      displayName: user.name || user.email || 'Anonymous',
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

    comment.id = ref.id;

    await ref.set(comment);

    // ✅ Broadcast the new comment to others in this thread
    const io = req.app.get('io');
    if (io) {
      io.to(`answer:${answerId}`).emit('comment:created', comment);
    }

    return res.status(201).json(comment);
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
