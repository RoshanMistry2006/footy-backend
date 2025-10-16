// scripts/setAdmin.js (CommonJS)
const admin = require("firebase-admin");
const serviceAccount = require("../firebasekey.json"); // path is from /scripts up one level

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

async function setAdmin() {
  const UID = "QmGjyyqzzFTDJjTNXTO0C7AQBcn1"; // replace with your permanent account UID
  await admin.auth().setCustomUserClaims(UID, { admin: true });
  const user = await admin.auth().getUser(UID);
  console.log("Admin claim set. Current claims:", user.customClaims);
  process.exit(0);
}

setAdmin().catch((e) => {
  console.error(e);
  process.exit(1);
});
