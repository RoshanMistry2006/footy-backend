// routes/premium.js
const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const db = admin.firestore();

// ✅ Activate premium design after payment
router.post("/activate", async (req, res) => {
  try {
    const { commentId, style } = req.body;
    const uid = req.user.uid;

    if (!commentId || !style) {
      return res.status(400).json({ error: "Missing fields." });
    }

    // 🧠 Find comment by ID (you can improve this later by storing path)
    const commentsSnap = await db.collectionGroup("comments")
      .where("id", "==", commentId)
      .limit(1)
      .get();

    if (commentsSnap.empty) {
      return res.status(404).json({ error: "Comment not found." });
    }

    const commentRef = commentsSnap.docs[0].ref;

    await commentRef.update({
      isPremium: true,
      premiumStyle: style,
      premiumActivatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("🔥 Premium activation error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
