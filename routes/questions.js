const express = require('express');
const router = express.Router();

// Simulate a daily question (normally this would come from a database)
router.get('/today', (req, res) => {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  res.json({
    date: today,
    question: "Who was the best player in last night’s Champions League match?"
  });
});

module.exports = router;
