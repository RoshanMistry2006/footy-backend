/**
 * Migration: Add isActive field to all existing question documents
 *
 * Run once with: node scripts/migrate-questions.js
 *
 * - Today's question gets isActive: true
 * - All other questions get isActive: false
 */

require('dotenv').config();
const { db } = require('../db');

async function migrate() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`Running migration... Today is ${today}`);

  const snap = await db.collection('questions').get();
  if (snap.empty) { console.log('No questions found.'); return; }

  console.log(`Found ${snap.size} questions to migrate.`);

  const batch = db.batch();
  let updated = 0;
  let skipped = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    if (data.isActive !== undefined) { skipped++; continue; }

    const isActive = doc.id === today;
    batch.update(doc.ref, { isActive });
    updated++;
    console.log(`  ${doc.id} → isActive: ${isActive}`);
  }

  await batch.commit();
  console.log(`\nDone! Updated: ${updated}, Skipped: ${skipped}`);
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
