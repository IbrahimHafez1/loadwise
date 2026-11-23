// Deep clone through JSON.parse(JSON.stringify()) inside a request handler (replaced by structuredClone in many fix commits).
const express = require('express');
const app = express();

app.post('/snapshot', (req, res) => {
  const copy = JSON.parse(JSON.stringify(req.body));
  res.json(copy);
});
