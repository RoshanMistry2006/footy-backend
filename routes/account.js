const express = require("express");
const router = express.Router();
const admin = require("firebase-admin");
const { verifyAuth } = require("../verifyAuth");

const { admin, db } = require("../db");

// DELETE /account/delete
router.delete("/delete", verifyAuth, async (req, res) => {
  try {
    const uid = req.user.uid;

    // 1) Delete user profile doc if you have one (common path)
    // If you don't have users/{uid}, this just fails silently.
    await db.collection("users").doc(uid).delete().catch(() => {});

    // 2) Delete Firebase Auth user (this is the key Apple requirement)
    await admin.auth().deleteUser(uid);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Account deletion failed:", err);
    return res.status(500).json({ ok: false, error: "Account deletion failed" });
  }
});

module.exports = router;
