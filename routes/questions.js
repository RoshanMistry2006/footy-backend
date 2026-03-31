const express = require('express');
const router = express.Router();
const { admin, db } = require('../db');
const { verifyAuth } = require('../verifyAuth');
const { requireAdmin } = require('../requireAdmin');

const CRON_SECRET = process.env.CRON_SECRET;

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

// ---------- shared helper ----------
async function computeWinner(date, io) {
  const qRef = db.collection('questions').doc(date);
  const qDoc = await qRef.get();
  if (!qDoc.exists) throw Object.assign(new Error(`Question not found for ${date}`), { status: 404 });

  const snap = await qRef.collection('answers').orderBy('votes', 'desc').limit(1).get();
  if (snap.empty) return { winner: null, message: `No answers found for ${date}` };

  const winnerDoc = snap.docs[0];
  const winner = { id: winnerDoc.id, ...winnerDoc.data() };

  const qData = qDoc.data();
  if (qData.winner && qData.winner.userId === winner.userId) {
    return { winner, message: 'Winner already computed previously' };
  }

  let displayName = 'Anonymous';
  if (winner.userId) {
    const userDoc = await db.collection('users').doc(winner.userId).get();
    if (userDoc.exists) displayName = userDoc.data().displayName || 'Anonymous';
  }

  await qRef.set({
    winner: {
      id: winner.id,
      text: winner.text || '',
      userId: winner.userId || null,
      displayName,
      votes: winner.votes || 0,
      computedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
  }, { merge: true });

  if (winner.userId) {
    const userRef = db.collection('users').doc(winner.userId);
    await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      const prev = doc.exists ? doc.data().discussionsWon || 0 : 0;
      t.set(userRef, { discussionsWon: prev + 1 }, { merge: true });
    });
  }

  if (io) io.to(date).emit('winner:computed', { date, winner });
  return { winner, message: 'Winner computed successfully' };
}

function verifyCronSecret(req, res) {
  const cronKey = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (cronKey !== CRON_SECRET) {
    res.status(403).json({ error: 'Unauthorized (Cron only)' });
    return false;
  }
  return true;
}

// ---------- routes ----------

// CRON shortcut (must be before :date routes)
router.post('/today/compute-winner', async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  try {
    const today = todayStr();
    const result = await computeWinner(today, req.app.get('io'));
    res.json({ date: today, ...result });
  } catch (err) {
    console.error('Error in /today/compute-winner:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to compute winner.' });
  }
});

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

// GET /api/questions — Admin: list all questions (must be before /:date)
router.get('/', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const snap = await db.collection('questions').orderBy('__name__', 'desc').limit(30).get();
    const questions = snap.docs.map((d) => ({ date: d.id, ...d.data() }));
    res.json(questions);
  } catch (err) {
    console.error('Error listing questions:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/questions — Admin: create a question for a specific date
router.post('/', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { date, text } = req.body;
    if (!date || !text || !text.trim())
      return res.status(400).json({ error: 'date and text are required.' });
    if (!DATE_RE.test(date))
      return res.status(400).json({ error: 'Invalid date format (YYYY-MM-DD)' });

    const ref = db.collection('questions').doc(date);
    const existing = await ref.get();
    if (existing.exists)
      return res.status(409).json({ error: `Question for ${date} already exists.` });

    await ref.set({
      text: text.trim(),
      isActive: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(201).json({ message: `Question created for ${date}`, date, text: text.trim() });
  } catch (err) {
    console.error('Error creating question:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/questions/:date
router.get('/:date', async (req, res) => {
  try {
    const { date } = req.params;
    assertDate(date);
    const doc = await db.collection('questions').doc(date).get();
    if (!doc.exists) return res.status(404).json({ error: 'No question found for this date.' });
    const data = doc.data();
    if (data.time && data.time.toDate) data.time = data.time.toDate().toISOString();
    res.json(data);
  } catch (err) {
    console.error('Error fetching question by date:', err);
    res.status(err.status || 500).json({ error: err.message || 'Error fetching question.' });
  }
});

// PATCH /api/questions/:date — Admin: update question text or activate/deactivate
router.patch('/:date', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { date } = req.params;
    assertDate(date);
    const { text, isActive } = req.body;

    const ref = db.collection('questions').doc(date);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: 'Question not found.' });

    const updates = {};
    if (text !== undefined) updates.text = text.trim();
    if (isActive !== undefined) updates.isActive = isActive;

    await ref.update(updates);
    res.json({ message: 'Question updated.', date, ...updates });
  } catch (err) {
    console.error('Error updating question:', err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /api/questions/:date/answers (sorted by votes desc)
router.get('/:date/answers', async (req, res) => {
  try {
    const { date } = req.params;
    assertDate(date);
    const snap = await db.collection('questions').doc(date).collection('answers').orderBy('votes', 'desc').get();
    const answers = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ count: answers.length, answers });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Error fetching answers.' });
  }
});

// POST /api/questions/:date/answers
router.post('/:date/answers', verifyAuth, async (req, res) => {
  try {
    const { date } = req.params;
    assertDate(date);
    const { text } = req.body || {};
    const uid = req.user?.uid || null;
    const displayName = req.user?.displayName || 'Anonymous';

    if (!text || !text.trim()) return res.status(400).json({ error: 'Answer text is required.' });

    const qRef = db.collection('questions').doc(date);
    const qDoc = await qRef.get();
    if (!qDoc.exists) return res.status(404).json({ error: 'Question not found for this date.' });

    const answersSnap = await qRef.collection('answers').where('userId', '==', uid).limit(1).get();
    if (!answersSnap.empty) return res.status(403).json({ error: 'You have already submitted an answer for today.' });

    const aRef = qRef.collection('answers').doc();
    const newAnswer = {
      id: aRef.id, text: text.trim(), userId: uid, displayName,
      votes: 0, createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await aRef.set(newAnswer);

    const userRef = db.collection('users').doc(uid);
    await db.runTransaction(async (t) => {
      const userSnap = await t.get(userRef);
      const prev = userSnap.exists ? userSnap.data().totalComments || 0 : 0;
      t.set(userRef, { totalComments: prev + 1 }, { merge: true });
    });

    const io = req.app.get('io');
    if (io) io.to(date).emit('answer:created', newAnswer);
    res.status(201).json(newAnswer);
  } catch (err) {
    console.error('Error creating answer:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to create answer.' });
  }
});

// POST /api/questions/:date/comments
router.post('/:date/comments', verifyAuth, async (req, res) => {
  try {
    const { date } = req.params;
    const { text } = req.body;
    const user = req.user;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Comment text is required.' });

    const qRef = db.collection('questions').doc(date);
    const commentRef = qRef.collection('comments').doc();
    const comment = {
      id: commentRef.id, text: text.trim(), userId: user.uid,
      displayName: user.displayName || 'Anonymous',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await commentRef.set(comment);

    const userRef = db.collection('users').doc(user.uid);
    await db.runTransaction(async (t) => {
      const snap = await t.get(userRef);
      const prev = snap.exists ? snap.data().totalComments || 0 : 0;
      t.set(userRef, { totalComments: prev + 1 }, { merge: true });
    });

    const io = req.app.get('io');
    if (io) io.to(date).emit('question:commented', comment);
    res.status(201).json(comment);
  } catch (err) {
    console.error('Error posting comment:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to post comment.' });
  }
});

// Voting route
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
      if (!qDoc.exists) throw new Error('Question not found');
      if (!isVotingOpen(qDoc)) throw new Error('Voting closed');

      const aRef = qRef.collection('answers').doc(answerId);
      const aDoc = await tx.get(aRef);
      if (!aDoc.exists) throw new Error('Answer not found');
      if (aDoc.get('userId') === uid) throw new Error('Cannot vote your own answer');

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
    res.status(500).json({ error: e.message || 'Vote failed' });
  }
});

// GET /api/questions/:date/vote
router.get('/:date/vote', verifyAuth, async (req, res) => {
  try {
    const { date } = req.params;
    assertDate(date);
    const uid = req.user.uid;
    const doc = await db.collection('userVotes').doc(`${date}_${uid}`).get();
    if (!doc.exists) return res.status(204).send();
    return res.status(200).json({ answerId: doc.data().answerId });
  } catch (err) {
    console.error('Error fetching user vote:', err);
    return res.status(500).json({ error: 'Failed to fetch user vote.' });
  }
});

// POST /api/questions/:date/compute-winner (CRON)
router.post('/:date/compute-winner', async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  try {
    const { date } = req.params;
    assertDate(date);
    const result = await computeWinner(date, req.app.get('io'));
    res.json({ date, ...result });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message || 'Failed to compute winner.' });
  }
});

module.exports = router;
