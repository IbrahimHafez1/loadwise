// includes() inside a loop over a second array: quadratic membership test (fixed with a Set in many commits).
const express = require('express');
const app = express();

app.post('/intersect', (req, res) => {
  const shared = [];
  for (const item of req.body.left) {
    if (req.body.right.includes(item)) shared.push(item);
  }
  res.json(shared);
});
