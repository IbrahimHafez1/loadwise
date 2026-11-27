// Spread-copy accumulator inside reduce: quadratic allocation (well-known perf fix).
const express = require('express');
const app = express();

app.post('/index', (req, res) => {
  /** @type {{ id: string }[]} */
  const rows = req.body.rows;
  const byId = rows.reduce((index, row) => ({ ...index, [row.id]: row }), {});
  res.json(byId);
});
