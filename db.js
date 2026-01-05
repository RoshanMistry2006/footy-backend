const fs = require("fs");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  console.log("🔐 Using GOOGLE_APPLICATION_CREDENTIALS:", keyPath);
  console.log(
    "🔐 Key file exists:",
    fs.existsSync(keyPath || "")
  );

  if (!keyPath) {
    throw new Error("Missing GOOGLE_APPLICATION_CREDENTIALS");
  }

  const serviceAccount = JSON.parse(
    fs.readFileSync(keyPath, "utf8")
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

module.exports = { admin, db };
