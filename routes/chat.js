const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const db = admin.firestore();
const bannedWords = require("../utils/bannedWords");

// ===== Helper function to detect banned words =====
function containsBannedWord(text) {
  return bannedWords.some((word) =>
    text.toLowerCase().includes(word.toLowerCase())
  );
}

/**
 * POST /api/chats/request
 * Create a new debate request
 */
router.post("/request", async (req, res) => {
  try {
    const { toUid, topic, commentText } = req.body;
    const fromUid = req.user.uid;

    if (!toUid || !topic) {
      return res.status(400).json({ error: "Missing fields." });
    }

    // Fetch sender’s display name
    const fromUserSnap = await db.collection("users").doc(fromUid).get();
    const fromDisplayName = fromUserSnap.exists
      ? fromUserSnap.data().displayName || "Unknown"
      : "Unknown";

    // Fetch recipient’s display name
    const toUserSnap = await db.collection("users").doc(toUid).get();
    const toDisplayName = toUserSnap.exists
      ? toUserSnap.data().displayName || "Unknown"
      : "Unknown";

    // Prevent duplicate pending requests
    const existing = await db
      .collection("chatRequests")
      .where("fromUid", "==", fromUid)
      .where("toUid", "==", toUid)
      .where("status", "==", "pending")
      .get();

    if (!existing.empty) {
      return res.status(400).json({ error: "Request already sent." });
    }

    // ✅ Save to chatRequests (main request collection)
    const ref = db.collection("chatRequests").doc();
    const data = {
      id: ref.id,
      fromUid,
      fromDisplayName,
      toUid,
      toDisplayName,
      topic,
      commentText: commentText || "",
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await ref.set(data);

    // ✅ ALSO save to debateRequests (for badge tracking)
    await db.collection("debateRequests").add({
      toUid,
      fromUid,
      topic,
      seen: false,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 🔥 Notify target via socket (for both pages + red badge)
    const io = req.app.get("io");
    if (io) {
      io.to(toUid).emit("chat:request", data);
      io.to(toUid).emit("challenge:received", {
        type: "newChallenge",
        fromUid,
        fromDisplayName,
        topic,
        commentText: commentText || "",
      });
    }

    res.status(201).json({ id: ref.id, message: "Request sent." });
  } catch (err) {
    console.error("🔥 Error in POST /request:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/chats/requests
 * Fetch all debate requests RECEIVED by the logged-in user
 */
router.get("/requests", async (req, res) => {
  try {
    const uid = req.user.uid;
    if (!uid) return res.status(400).json({ error: "Missing user UID" });

    const snap = await db
      .collection("chatRequests")
      .where("toUid", "==", uid)
      .orderBy("createdAt", "desc")
      .get();

    const requests = snap.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    }));

    res.json(requests);
  } catch (err) {
    console.error("🔥 Error in GET /requests:", err);
    res.status(500).json({ error: err.message });
  }
});



/**
 * ✅ POST /api/chats/mark-seen
 * Mark all debate requests for the current user as "seen"
 */
router.post("/mark-seen", async (req, res) => {
  try {
    const uid = req.user.uid;
    const batch = db.batch();

    const snap = await db
      .collection("debateRequests")
      .where("toUid", "==", uid)
      .where("seen", "==", false)
      .get();

    snap.docs.forEach((doc) => {
      batch.update(doc.ref, { seen: true });
    });

    await batch.commit();
    res.json({ message: "All requests marked as seen." });
  } catch (err) {
    console.error("🔥 Error in POST /mark-seen:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/chats/respond
 * Accept or decline a debate request
 */
router.post("/respond", async (req, res) => {
  try {
    const { requestId, action } = req.body;
    const uid = req.user.uid;

    const ref = db.collection("chatRequests").doc(requestId);
    const snap = await ref.get();
    if (!snap.exists)
      return res.status(404).json({ error: "Request not found." });

    const data = snap.data();
    if (data.toUid !== uid)
      return res.status(403).json({ error: "Not your request." });
    if (data.status !== "pending")
      return res.status(400).json({ error: "Already handled." });

    const io = req.app.get("io");

    if (action === "decline") {
      await ref.delete(); // ✅ delete declined requests
      if (io) io.to(data.fromUid).emit("chat:declined", { requestId });
      return res.json({ message: "Request declined and deleted." });
    }

    if (action === "accept") {
      // ✅ Update request with accepted + expiry
      const expiresAt = Date.now() + 48 * 60 * 60 * 1000; // 48h from now
      await ref.update({ status: "accepted", expiresAt });

      // ✅ Create chat room
      const chatRef = db.collection("chats").doc();
      await chatRef.set({
        id: chatRef.id,
        userA: data.fromUid,
        userB: data.toUid,
        topic: data.topic,
        commentText: data.commentText || "",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt,
      });

      // ✅ Notify both users
      if (io) {
        io.to(data.fromUid).emit("chat:accepted", {
          chatId: chatRef.id,
          topic: data.topic,
          opponent: data.toUid,
          expiresAt,
        });
        io.to(data.toUid).emit("chat:accepted", {
          chatId: chatRef.id,
          topic: data.topic,
          opponent: data.fromUid,
          expiresAt,
        });
      }

      return res.json({
        message: "Request accepted.",
        chatId: chatRef.id,
        expiresAt,
      });
    }

    res.status(400).json({ error: "Invalid action." });
  } catch (err) {
    console.error("🔥 Error in POST /respond:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/chats/:chatId/messages
 * Send a message
 */
router.post("/:chatId/messages", async (req, res) => {
  try {
    const { text } = req.body;
    const senderUid = req.user.uid;
    const chatId = req.params.chatId;

    if (!text?.trim())
      return res.status(400).json({ error: "Empty message." });

    if (containsBannedWord(text)) {
      return res.status(400).json({
        error: "Your message contains banned words and cannot be sent.",
      });
    }

    const msgRef = db
      .collection("chats")
      .doc(chatId)
      .collection("messages")
      .doc();
    const msgData = {
      id: msgRef.id,
      text: text.trim(),
      senderUid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await msgRef.set(msgData);
    req.io.to(chatId).emit("chat:message", msgData);
    res.status(201).json(msgData);
  } catch (err) {
    console.error("🔥 Error in POST /:chatId/messages:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/chats/:chatId/messages
 * Fetch chat messages
 */
router.get("/:chatId/messages", async (req, res) => {
  try {
    const chatId = req.params.chatId;
    const snap = await db
      .collection("chats")
      .doc(chatId)
      .collection("messages")
      .orderBy("createdAt", "asc")
      .get();

    const messages = snap.docs.map((d) => d.data());
    res.json(messages);
  } catch (err) {
    console.error("🔥 Error in GET /:chatId/messages:", err);
    res.status(500).json({ error: err.message });
  }
});

// 🧹 Auto-clean expired chats every 12h
setInterval(async () => {
  try {
    const now = Date.now();
    const snap = await db.collection("chats").where("expiresAt", "<", now).get();
    for (const doc of snap.docs) {
      await doc.ref.delete();
    }
    console.log(`🧹 Deleted ${snap.size} expired chats`);
  } catch (err) {
    console.error("🔥 Error cleaning expired chats:", err);
  }
}, 12 * 60 * 60 * 1000);
/**
 * GET /api/chats/sent
 * Fetch all debate requests SENT by the logged-in user
 */
router.get("/sent", async (req, res) => {
  try {
    const uid = req.user.uid;
    if (!uid) return res.status(400).json({ error: "Missing user UID" });

    // ✅ Query for requests SENT by this user
    const snap = await db
      .collection("chatRequests")
      .where("fromUid", "==", uid)
      .orderBy("createdAt", "desc")
      .get();

    const requests = snap.docs.map((d) => ({
      id: d.id,
      ...d.data(),
    }));

    res.json(requests);
  } catch (err) {
    console.error("🔥 Error in GET /sent:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
