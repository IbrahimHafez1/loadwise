// Fire-and-forget async call whose rejection is never handled (crashes Node >= 15 on unhandled rejection).
const express = require('express');
const app = express();

async function sendAudit(event) {
  await fetch('https://audit.example.com', {
    method: 'POST',
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(5000),
  });
}

app.post('/event', (req, res) => {
  sendAudit(req.body);
  res.json({ ok: true });
});
