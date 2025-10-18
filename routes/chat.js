const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const db = admin.firestore();

/**
 * POST /api/chats/request
 * Create a new debate request
 */
router.post("/request", async (req, res) => {
  try {
    const { toUid, topic } = req.body;
    const fromUid = req.user.uid;

    if (!toUid || !topic) {
      return res.status(400).json({ error: "Missing fields." });
    }

    // Prevent duplicate pending requests between same users
    const existing = await db
      .collection("chatRequests")
      .where("fromUid", "==", fromUid)
      .where("toUid", "==", toUid)
      .where("status", "==", "pending")
      .get();

    if (!existing.empty) {
      return res.status(400).json({ error: "Request already sent." });
    }

    const ref = db.collection("chatRequests").doc();
    await ref.set({
      id: ref.id,
      fromUid,
      toUid,
      topic,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 🔥 Notify target via socket
    req.io.to(toUid).emit("chat:request", {
      id: ref.id,
      fromUid,
      toUid,
      topic,
      status: "pending",
    });

    res.status(201).json({ id: ref.id, message: "Request sent." });
  } catch (err) {
    console.error("🔥 Error in POST /request:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/chats/respond
 * Accept or decline a debate request
 */
router.post("/respond", async (req, res) => {
  try {
    const { requestId, action } = req.body; // "accept" or "decline"
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

    if (action === "decline") {
      await ref.update({ status: "declined" });
      req.io.to(data.fromUid).emit("chat:declined", { requestId });
      return res.json({ message: "Request declined." });
    }

    if (action === "accept") {
      await ref.update({ status: "accepted" });

      // ✅ Create chat room
      const chatRef = db.collection("chats").doc();
      await chatRef.set({
        id: chatRef.id,
        userA: data.fromUid,
        userB: data.toUid,
        topic: data.topic,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Notify both users
      req.io.to(data.fromUid).emit("chat:accepted", {
        chatId: chatRef.id,
        topic: data.topic,
        opponent: uid,
      });
      req.io.to(data.toUid).emit("chat:accepted", {
        chatId: chatRef.id,
        topic: data.topic,
        opponent: data.fromUid,
      });

      return res.json({ message: "Request accepted.", chatId: chatRef.id });
    }

    res.status(400).json({ error: "Invalid action." });
  } catch (err) {
    console.error("🔥 Error in POST /respond:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/chats/requests
 * Fetch all debate requests for the logged-in user
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

    // ✅ Always return an array
    return res.json(Array.isArray(requests) ? requests : []);
  } catch (err) {
    console.error("🔥 Error in GET /requests:", err);
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

    // notify both users
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

module.exports = router;

