// Blocking readFileSync inside an async request handler (event-loop stall; frequent fix in Express apps).
const express = require('express');
const fs = require('node:fs');
const app = express();

app.get('/report', async (_req, res) => {
  const report = fs.readFileSync('/var/reports/latest.json', 'utf8');
  res.type('json').send(report);
});
