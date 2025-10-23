// routes/premium.js
const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const db = admin.firestore();
const { verifyAuth } = require("../verifyAuth"); // ✅ make sure this line exists

// ✅ Activate premium design after payment
router.post("/activate", verifyAuth, async (req, res) => {
  const { answerId, style } = req.body;
  const uid = req.user.uid;

  if (!answerId || !style) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    const answerRef = db.collection("answers").doc(answerId);
    const doc = await answerRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Answer not found" });
    }

    if (doc.data().uid !== uid) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    await answerRef.update({
      isPremium: true,
      premiumStyle: style,
    });

    // ✅ broadcast to all connected clients (real-time update)
    if (req.io) {
      req.io.emit("premiumUpdated", { answerId, style });
      console.log("📡 premiumUpdated event emitted:", answerId);
    } else {
      console.warn("⚠️ req.io not found — Socket.IO event not emitted");
    }

    res.json({ success: true });
  } catch (err) {
    console.error("💥 Premium activation error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

