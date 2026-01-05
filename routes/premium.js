// routes/premium.js
const express = require("express");
const router = express.Router();
const { admin, db } = require('../db');
const { verifyAuth } = require("../verifyAuth");

// ✅ Activate premium design for an answer
router.post("/activate", verifyAuth, async (req, res) => {
  const { answerId, style, date } = req.body; // ✅ include date
  const uid = req.user.uid;

  if (!answerId || !style || !date) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    const answerRef = db
      .collection("questions")
      .doc(date)
      .collection("answers")
      .doc(answerId);

    const doc = await answerRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Answer not found" });
    }

    if (doc.data().userId !== uid) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    await answerRef.update({
      isPremium: true,
      premiumStyle: style,
    });

    // ✅ broadcast real-time update
    if (req.io) req.io.emit("premiumUpdated", { answerId, style, date });

    res.json({ success: true });
  } catch (err) {
    console.error("💥 Premium activation error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;


