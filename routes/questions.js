const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { verifyAuth } = require('../verifyAuth');
const { requireAdmin } = require('../requireAdmin');

const db = admin.firestore();

// ---------- helpers ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function assertDate(date) {
  if (!DATE_RE.test(date)) {
    const e = new Error('Invalid date format (YYYY-MM-DD)');
    e.status = 400;
    throw e;
  }
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function isVotingOpen(qDoc) {
  const data = qDoc.data() || {};
  if (data.closesAt instanceof admin.firestore.Timestamp) {
    return admin.firestore.Timestamp.now().toMillis() < data.closesAt.toMillis();
  }
  return qDoc.id === todayStr();
}

// ---------- routes ----------

// GET /api/questions/today
router.get('/today', async (req, res) => {
  try {
    const today = todayStr();
    const doc = await db.collection('questions').doc(today).get();
    if (!doc.exists) return res.status(404).json({ error: 'No question found for today.' });
    res.json(doc.data());
  } catch (err) {
    console.error('Error fetching question:', err);
    res.status(500).json({ error: 'Error fetching question.' });
  }
});

// ✅ GET /api/questions/:date → fetch question text for that date
router.get('/:date', async (req, res) => {
  try {
    const { date } = req.params;
    assertDate(date);

    const doc = await db.collection('questions').doc(date).get();
    if (!doc.exists) {
      return res.status(404).json({ error: 'No question found for this date.' });
    }

    const data = doc.data();
    if (data.time && data.time.toDate) {
      data.time = data.time.toDate().toISOString();
    }

    res.json(data);
  } catch (err) {
    console.error('Error fetching question by date:', err);
    res.status(err.status || 500).json({ error: err.message || 'Error fetching question.' });
  }
});

// GET /api/questions/:date/answers  (sorted by votes desc)
router.get('/:date/answers', async (req, res) => {
  try {
    const { date } = req.params;
    assertDate(date);

    const snap = await db
      .collection('questions').doc(date)
      .collection('answers')
      .orderBy('votes', 'desc')
      .get();

    const answers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ count: answers.length, answers });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Error fetching answers.' });
  }
});

// ✅ POST /api/questions/:date/answers → create a new answer
// POST /api/questions/:date/answers → create a new answer (1 per user)
router.post('/:date/answers', verifyAuth, async (req, res) => {
  try {
    const { date } = req.params;
    assertDate(date);

    const { text } = req.body || {};
    const uid = req.user?.uid || null;
    const displayName = req.user?.displayName || 'Anonymous';

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Answer text is required.' });
    }

    const qRef = db.collection('questions').doc(date);
    const qDoc = await qRef.get();
    if (!qDoc.exists) {
      return res.status(404).json({ error: 'Question not found for this date.' });
    }

    // ✅ Check if this user already answered
    const answersSnap = await qRef
      .collection('answers')
      .where('userId', '==', uid)
      .limit(1)
      .get();

    if (!answersSnap.empty) {
      return res.status(403).json({ error: 'You have already submitted an answer for today.' });
    }

    // create new answer
    const aRef = qRef.collection('answers').doc();
    const newAnswer = {
      id: aRef.id,
      text: text.trim(),
      userId: uid,
      displayName,
      votes: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await aRef.set(newAnswer);

    // notify sockets
    const io = req.app.get('io');
    if (io) io.to(date).emit('answer:created', newAnswer);

    res.status(201).json(newAnswer);
  } catch (err) {
    console.error('Error creating answer:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to create answer.' });
  }
});


// POST /api/questions/:date   (seed/update a question)
router.post('/:date', async (req, res) => {
  try {
    const { date } = req.params;
    assertDate(date);

    const { text, closesAt } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text is required' });

    const data = { text };
    if (closesAt) {
      data.closesAt = admin.firestore.Timestamp.fromDate(new Date(closesAt));
    }

    await db.collection('questions').doc(date).set(data, { merge: true });
    res.status(201).json({ message: 'Question saved.' });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'Failed to save question.' });
  }
});

// POST /api/questions/:date/answers/:answerId/vote
router.post('/:date/answers/:answerId/vote', verifyAuth, async (req, res) => {
  const { date, answerId } = req.params;
  const uid = req.user.uid;

  try {
    assertDate(date);
    let prevId = null;
    let changed = false;

    await db.runTransaction(async (tx) => {
      const qRef = db.collection('questions').doc(date);
      const qDoc = await tx.get(qRef);
      if (!qDoc.exists) { const e = new Error('Question not found'); e.status = 404; throw e; }
      if (!isVotingOpen(qDoc)) { const e = new Error('Voting closed'); e.status = 403; throw e; }

      const aRef = qRef.collection('answers').doc(answerId);
      const aDoc = await tx.get(aRef);
      if (!aDoc.exists) { const e = new Error('Answer not found'); e.status = 404; throw e; }

      if (aDoc.get('userId') === uid) {
        const e = new Error('Cannot vote your own answer'); e.status = 403; throw e;
      }

      const uvRef = db.collection('userVotes').doc(`${date}_${uid}`);
      const uvDoc = await tx.get(uvRef);

      if (!uvDoc.exists) {
        tx.set(uvRef, { date, uid, answerId, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        tx.update(aRef, { votes: admin.firestore.FieldValue.increment(1) });
        changed = true;
      } else {
        prevId = uvDoc.get('answerId');
        if (prevId !== answerId) {
          const prevRef = qRef.collection('answers').doc(prevId);
          const prevDoc = await tx.get(prevRef);
          if (prevDoc.exists) tx.update(prevRef, { votes: admin.firestore.FieldValue.increment(-1) });
          tx.update(aRef, { votes: admin.firestore.FieldValue.increment(1) });
          tx.update(uvRef, { answerId, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          changed = true;
        }
      }
    });

    const io = req.app.get('io');
    if (io && changed) io.to(date).emit('answer:voted', { answerId, prevAnswerId: prevId, uid });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'Vote failed' });
  }
});

// GET /api/questions/:date/vote
router.get('/:date/vote', verifyAuth, async (req, res) => {
  try {
    const { date } = req.params;
    assertDate(date);
    const uid = req.user.uid;

    const uvRef = db.collection('userVotes').doc(`${date}_${uid}`);
    const uvDoc = await uvRef.get();

    res.json({ answerId: uvDoc.exists ? uvDoc.get('answerId') : null });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'Failed to fetch vote.' });
  }
});

// DELETE /api/questions/:date/vote
router.delete('/:date/vote', verifyAuth, async (req, res) => {
  const { date } = req.params;
  const uid = req.user.uid;

  try {
    assertDate(date);

    await db.runTransaction(async (tx) => {
      const qRef = db.collection('questions').doc(date);
      const qDoc = await tx.get(qRef);
      if (!qDoc.exists) { const e = new Error('Question not found'); e.status = 404; throw e; }
      if (!isVotingOpen(qDoc)) { const e = new Error('Voting closed'); e.status = 403; throw e; }

      const uvRef = db.collection('userVotes').doc(`${date}_${uid}`);
      const uvDoc = await tx.get(uvRef);
      if (!uvDoc.exists) return;

      const answerId = uvDoc.get('answerId');
      const aRef = qRef.collection('answers').doc(answerId);
      const aDoc = await tx.get(aRef);
      if (aDoc.exists) {
        tx.update(aRef, { votes: admin.firestore.FieldValue.increment(-1) });
      }
      tx.delete(uvRef);
    });

    const io = req.app.get('io');
    if (io) io.to(date).emit('answer:unvoted', { uid });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'Unvote failed' });
  }
});

// DELETE /api/questions/:date/force-unvote/:uid  (ADMIN)
router.delete('/:date/force-unvote/:uid', verifyAuth, requireAdmin, async (req, res) => {
  const { date, uid } = req.params;

  try {
    assertDate(date);

    const uvRef = db.collection('userVotes').doc(`${date}_${uid}`);
    const uvDoc = await uvRef.get();
    if (!uvDoc.exists) return res.status(404).json({ error: 'Vote record not found' });

    const answerId = uvDoc.get('answerId');
    const aRef = db.collection('questions').doc(date).collection('answers').doc(answerId);

    await db.runTransaction(async (tx) => {
      tx.update(aRef, { votes: admin.firestore.FieldValue.increment(-1) });
      tx.delete(uvRef);
    });

    const io = req.app.get('io');
    if (io) io.to(date).emit('answer:unvoted', { answerId, uid, forced: true });

    res.json({ ok: true, message: `Vote removed for user ${uid}` });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'Failed to remove vote' });
  }
});

// GET /api/questions/:date/winner (ADMIN)
router.get('/:date/winner', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { date } = req.params;
    assertDate(date);

    const qRef = db.collection('questions').doc(date);
    const qDoc = await qRef.get();
    if (!qDoc.exists) return res.status(404).json({ error: 'Question not found' });

    const snap = await qRef.collection('answers').orderBy('votes', 'desc').limit(1).get();
    if (snap.empty) return res.json({ winner: null });

    const d = snap.docs[0];
    res.json({ winner: { id: d.id, ...d.data() } });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'Failed to fetch winner.' });
  }
});

// POST /api/questions/:date/compute-winner  (ADMIN)
router.post('/:date/compute-winner', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { date } = req.params;
    assertDate(date);

    const qRef = db.collection('questions').doc(date);
    const qDoc = await qRef.get();
    if (!qDoc.exists) return res.status(404).json({ error: 'Question not found' });

    const snap = await qRef.collection('answers').orderBy('votes', 'desc').limit(1).get();
    const winner = snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };

    await qRef.set({
      winner: winner ? {
        id: winner.id,
        text: winner.text || '',
        userId: winner.userId || null,
        votes: winner.votes || 0,
        computedAt: admin.firestore.FieldValue.serverTimestamp(),
        payoutStatus: 'pending'
      } : null
    }, { merge: true });

    res.json({ winner });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'Failed to compute winner.' });
  }
});

module.exports = router;
