// ===== Env & Admin init =====
require('dotenv').config();
const admin = require('firebase-admin');
const serviceAccount = require('./firebasekey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// ===== Core imports =====
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cron = require('node-cron');

// ===== Routes =====
const questionRoutes = require('./routes/questions');
const answerRoutes = require('./routes/answers');
const commentsRoutes = require('./routes/comments');
const chatRoutes = require('./routes/chat'); // ✅ Debate chats
const { verifyAuth } = require('./verifyAuth');

// ===== App + Server =====
const app = express();
const server = http.createServer(app);

// ===== Socket.IO =====
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',')
      : '*',
    methods: ['GET', 'POST', 'DELETE', 'PATCH'],
  },
});

app.set('io', io);

// ===== SOCKET LOGIC =====
io.on('connection', (socket) => {
  console.log('⚡ Socket connected:', socket.id);

  // 🔐 Store userId if passed via query
  const userId = socket.handshake.query.tokenUid;
  if (userId) {
    socket.join(userId);
    console.log(`👤 User ${userId} joined personal socket room`);
  }

  // --- Question Rooms ---
  socket.on('join-day', (date) => {
    socket.join(date);
    console.log(`📅 ${socket.id} joined room for ${date}`);
  });

  // --- Answer Discussion Threads ---
  socket.on('join-answer', (answerId) => {
    socket.join(`answer:${answerId}`);
    console.log(`💬 ${socket.id} joined thread for answer ${answerId}`);
  });

  socket.on('leave-answer', (answerId) => {
    socket.leave(`answer:${answerId}`);
    console.log(`🚪 ${socket.id} left thread for answer ${answerId}`);
  });

  // --- Private Debate Chats ---
  socket.on('join-chat', (chatId) => {
    socket.join(chatId);
    console.log(`🗨️ ${socket.id} joined chat room ${chatId}`);
  });

  socket.on('leave-chat', (chatId) => {
    socket.leave(chatId);
    console.log(`🚶 ${socket.id} left chat room ${chatId}`);
  });

  socket.on('disconnect', () => {
    console.log('❌ Socket disconnected:', socket.id);
  });
});

// ===== Middleware =====
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'PATCH'],
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== Inject io globally for authenticated routes =====
app.use((req, _res, next) => {
  req.io = io;
  next();
});

// ===== API ROUTES =====
app.use('/api/questions', questionRoutes);
app.use('/api/answers', answerRoutes);
app.use(
  '/api/questions/:date/answers/:answerId/comments',
  commentsRoutes
);

// ✅ Debate Chat Routes (with verifyAuth for security)
app.use('/api/chats', verifyAuth, chatRoutes);

// ===== Simple health check =====
app.get('/health', (_req, res) =>
  res.json({ ok: true, ts: Date.now() })
);

// ===== CRON JOB =====
const db = admin.firestore();
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '59 23 * * *'; // 23:59 daily

cron.schedule(CRON_SCHEDULE, async () => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    console.log(`[CRON] Running daily rotation for ${today}`);

    const qRef = db.collection('questions').doc(today);
    const qDoc = await qRef.get();
    if (!qDoc.exists) {
      console.log(`[CRON] No question for ${today}`);
      return;
    }

    // 1️⃣ Compute winner
    const snap = await qRef
      .collection('answers')
      .orderBy('votes', 'desc')
      .limit(1)
      .get();

    const winner = snap.empty
      ? null
      : { id: snap.docs[0].id, ...snap.docs[0].data() };

    await qRef.set(
      {
        winner: winner
          ? {
              id: winner.id,
              text: winner.text || '',
              userId: winner.userId || null,
              votes: winner.votes || 0,
              computedAt: admin.firestore.FieldValue.serverTimestamp(),
              payoutStatus: 'pending',
            }
          : null,
        closedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log(`[CRON] Winner computed for ${today}`);

    // 2️⃣ Open tomorrow’s question if it exists
    const nextRef = db.collection('questions').doc(tomorrow);
    const nextDoc = await nextRef.get();

    if (nextDoc.exists) {
      await nextRef.set(
        {
          openedAt: admin.firestore.FieldValue.serverTimestamp(),
          isActive: true,
        },
        { merge: true }
      );

      console.log(`[CRON] Tomorrow’s question activated → ${tomorrow}`);

      // 3️⃣ Notify all connected clients
      io.emit('day:rotated', { closed: today, opened: tomorrow });
    } else {
      console.log(`[CRON] No question scheduled for tomorrow (${tomorrow})`);
    }
  } catch (err) {
    console.error('[CRON] Rotation failed:', err.message);
  }
});

// ===== Start server =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

