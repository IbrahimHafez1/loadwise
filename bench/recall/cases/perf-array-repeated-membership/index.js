// includes() inside a loop over a second array: quadratic membership test (fixed with a Set in many commits).
const express = require('express');
const app = express();

app.post('/intersect', (req, res) => {
  /** @type {string[]} */
  const left = req.body.left;
  /** @type {string[]} */
  const right = req.body.right;
  const shared = [];
  for (const item of left) {
    if (right.includes(item)) shared.push(item);
  }
  res.json(shared);
});
