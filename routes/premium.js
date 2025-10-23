// routes/premium.js
const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const db = admin.firestore();
const { io } = require("../socket"); // adjust path if needed


// ✅ Activate premium design after payment
router.post("/activate", verifyAuth, async (req, res) => {
  const { answerId, style } = req.body;
  const uid = req.user.uid;

  if (!answerId || !style)
    return res.status(400).json({ error: "Missing fields" });

  try {
    const answerRef = db.collection("answers").doc(answerId);
    const doc = await answerRef.get();

    if (!doc.exists)
      return res.status(404).json({ error: "Answer not found" });

    if (doc.data().uid !== uid)
      return res.status(403).json({ error: "Unauthorized" });

    await answerRef.update({
      isPremium: true,
      premiumStyle: style,
    });

    // ✅ emit live update via Socket.IO
    req.io.emit("premiumUpdated", { answerId, style });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;
