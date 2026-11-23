// Pre-fix EJS usage shape (CVE-2022-29078, GHSA-phwq-j96m-2c2q): request body flows into template source and render data.
const ejs = require('ejs');
const express = require('express');
const app = express();

app.post('/preview', (req, res) => {
  res.send(ejs.render(req.body.template, req.body.data));
});
