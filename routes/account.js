const express = require("express");
const router = express.Router();

const { admin, db } = require("../db");
const { verifyAuth } = require("../verifyAuth");

// DELETE /api/account/delete
router.delete("/delete", verifyAuth, async (req, res) => {
  try {
    const uid = req.user.uid;

    // Optional: delete user profile doc (safe even if not present)
    await db.collection("users").doc(uid).delete().catch(() => {});

    // Required: delete Firebase Auth user
    await admin.auth().deleteUser(uid);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Account deletion failed:", err);
    return res.status(500).json({ ok: false, error: "Account deletion failed" });
  }
});

module.exports = router;
