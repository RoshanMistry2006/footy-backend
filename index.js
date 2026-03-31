// ===== Env & Admin init =====
const { admin, db } = require("./db");

// ===== Core imports =====
const express = require("express");
const rateLimit = require("express-rate-limit");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const cron = require("node-cron");
const axios = require("axios");

// ===== Routes =====
const questionRoutes = require("./routes/questions");
const answerRoutes = require("./routes/answers");
const commentsRoutes = require("./routes/comments");
const chatRoutes = require("./routes/chat");
const premiumRoutes = require("./routes/premium");
const { verifyAuth } = require("./verifyAuth");
const accountRoutes = require("./routes/account");

// ===== App + Server =====
const app = express();
const server = http.createServer(app);

// Trust Render's proxy (required for express-rate-limit to work correctly)
app.set("trust proxy", 1);

// ===== Socket.IO =====
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(",")
      : "*",
    methods: ["GET", "POST", "DELETE", "PATCH"],
  },
});

app.set("io", io);

// ===== SOCKET LOGIC =====
io.on("connection", (socket) => {
  console.log("⚡ Socket connected:", socket.id);

  const userId = socket.handshake.query.tokenUid;
  if (userId) {
    socket.join(userId);
    console.log(`👤 User ${userId} joined personal socket room`);
  }

  socket.on("join-day", (date) => {
    socket.join(date);
    console.log(`📅 ${socket.id} joined room for ${date}`);
  });

  socket.on("join-answer", (answerId) => {
    socket.join(`answer:${answerId}`);
    console.log(`💬 ${socket.id} joined thread for answer ${answerId}`);
  });

  socket.on("leave-answer", (answerId) => {
    socket.leave(`answer:${answerId}`);
    console.log(`🚪 ${socket.id} left thread for answer ${answerId}`);
  });

  socket.on("join-chat", (chatId) => {
    socket.join(chatId);
    console.log(`🗨️ ${socket.id} joined chat room ${chatId}`);
  });

  socket.on("leave-chat", (chatId) => {
    socket.leave(chatId);
    console.log(`🚶 ${socket.id} left chat room ${chatId}`);
  });

  socket.on("disconnect", () => {
    console.log("❌ Socket disconnected:", socket.id);
  });
});

// ===== Middleware =====
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "DELETE", "PATCH"],
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Inject io globally before any routes
app.use((req, _res, next) => {
  req.io = io;
  next();
});

// ===== RATE LIMITING =====
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

// Apply general limiter to all routes
app.use(generalLimiter);

// ===== API ROUTES =====
app.use("/api/questions", questionRoutes);
app.use("/api/answers", answerRoutes);
app.use("/api/questions/:date/answers/:answerId/comments", commentsRoutes);
app.use("/api/account", accountRoutes);

// Debate Chat Routes (secured)
app.use("/api/chats", verifyAuth, chatRoutes);

// Premium Routes
app.use("/api/premium", premiumRoutes);

// ===== Simple health check =====
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ===== CRON CONFIG =====
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "59 23 * * *";
const BACKEND_URL = process.env.BACKEND_URL || "https://footy-backend-yka8.onrender.com";
const CRON_SECRET = process.env.CRON_SECRET;
if (!CRON_SECRET) throw new Error("❌ CRON_SECRET env var is required");

// ===== Keep-alive ping (prevents Render cold starts) =====
cron.schedule("*/10 * * * *", async () => {
  try {
    await axios.get(`${BACKEND_URL}/health`);
    console.log("[Keep-alive] Ping sent");
  } catch (err) {
    console.warn("[Keep-alive] Ping failed:", err.message);
  }
});

// ===== CRON JOB =====
cron.schedule(CRON_SCHEDULE, async () => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    console.log(`[CRON] Running daily rotation for ${today}`);

    const res = await axios.post(
      `${BACKEND_URL}/api/questions/${today}/compute-winner`,
      {},
      { headers: { Authorization: `Bearer ${CRON_SECRET}` } }
    );

    console.log(`[CRON] Winner computed via API →`, res.data?.winner?.displayName || "No winner");

    const qRef = db.collection("questions").doc(today);
    await qRef.set(
      { closedAt: admin.firestore.FieldValue.serverTimestamp(), isActive: false },
      { merge: true }
    );

    const nextRef = db.collection("questions").doc(tomorrow);
    const nextDoc = await nextRef.get();

    if (nextDoc.exists) {
      await nextRef.set(
        { openedAt: admin.firestore.FieldValue.serverTimestamp(), isActive: true },
        { merge: true }
      );
      console.log(`[CRON] Tomorrow's question activated → ${tomorrow}`);
      io.emit("day:rotated", { closed: today, opened: tomorrow });
    } else {
      console.log(`[CRON] No question scheduled for tomorrow (${tomorrow})`);
    }
  } catch (err) {
    console.error("[CRON] Rotation failed:", err.response?.data || err.message);
  }
});

// ===== Start server =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
