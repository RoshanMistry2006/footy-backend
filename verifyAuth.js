// verifyAuth.js
const admin = require("firebase-admin");

async function verifyAuth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing Bearer token" });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token, true);
    req.user = decoded; // contains uid + custom claims (e.g. admin: true)
    next();
  } catch (e) {
    console.error("Auth error:", e.message);
    return res.status(401).json({ error: "Invalid token" });
  }
}

module.exports = { verifyAuth };
