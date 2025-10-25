// routes/comments.js
const express = require('express');
const router = express.Router({ mergeParams: true });
const admin = require('firebase-admin');
const { verifyAuth } = require('../verifyAuth');
const bannedWords = require('../utils/bannedWords');

const db = admin.firestore();

console.log("✅ comments.js loaded successfully on server startup");

/**
 * Firestore layout:
 * questions/{date}/answers/{answerId}/comments/{commentId}
 * Each comment has: text, userId, displayName, parentId, createdAt, depth
 */

// ===== Helper function to detect banned words =====
function containsBannedWord(text) {
  return bannedWords.some((word) =>
    text.toLowerCase().includes(word.toLowerCase())
  );
}

// ===== CREATE a comment or reply =====
router.post('/', verifyAuth, async (req, res) => {
  try {
    const { date, answerId } = req.params;
    const { text, parentId = null } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Text is required' });
    }

    // ✅ Check for banned words
    if (containsBannedWord(text)) {
      return res.status(400).json({
        error: 'Your comment contains banned words and cannot be posted.',
      });
    }

    const user = req.user;
    let displayName = 'Anonymous';

    // ✅ Get display name from Firestore
    const userDoc = await db.collection('users').doc(user.uid).get();
    if (userDoc.exists) {
      displayName = userDoc.data().displayName || 'Anonymous';
    }

    // ✅ Compute depth
    let depth = 0;
    if (parentId) {
      const parentRef = db
        .collection('questions')
        .doc(date)
        .collection('answers')
        .doc(answerId)
        .collection('comments')
        .doc(parentId);

      const parentDoc = await parentRef.get();
      if (parentDoc.exists) {
        const parentData = parentDoc.data();
        depth = (parentData.depth || 0) + 1;
      }
    }

    // ✅ Build comment object
    const comment = {
      text: text.trim(),
      userId: user.uid,
      displayName,
      parentId: parentId || null,
      depth,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      isPremium: false,
      premiumStyle: {},
    };

    // ✅ Save comment in Firestore
    const commentRef = db
      .collection('questions')
      .doc(date)
      .collection('answers')
      .doc(answerId)
      .collection('comments')
      .doc();

    await commentRef.set(comment);

    // ✅ Increment user's totalComments if top-level comment
    if (!parentId) {
      console.log(`🟢 Top-level comment by ${displayName} (${user.uid})`);
      const userRef = db.collection('users').doc(user.uid);

      await db.runTransaction(async (t) => {
        const userSnap = await t.get(userRef);
        const prev = userSnap.exists ? userSnap.data().totalComments || 0 : 0;
        t.set(
          userRef,
          { totalComments: prev + 1 },
          { merge: true }
        );
      });
    } else {
      console.log(`🟡 Reply (depth ${depth}) by ${displayName} (${user.uid}) — counter unchanged`);
    }

    const saved = { id: commentRef.id, ...comment };

    // ✅ Emit new comment via Socket.IO
    if (req.io) {
      req.io.to(`answer:${answerId}`).emit('comment:created', saved);
    }

    return res.status(201).json(saved);
  } catch (err) {
    console.error('[POST /comments] Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// ===== GET all comments =====
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

// ===== DELETE a comment =====
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

    // ✅ Emit delete event
    if (req.io) {
      req.io.to(`answer:${answerId}`).emit('comment:deleted', { id: commentId });
    }

    console.log(`🗑️ Comment deleted by ${user.uid}`);

    return res.json({ success: true });
  } catch (err) {
    console.error('[DELETE /comments] Error:', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;

