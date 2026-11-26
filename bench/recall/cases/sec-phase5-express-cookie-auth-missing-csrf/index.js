const express = require('express');
const cookieParser = require('cookie-parser');

const app = express();
app.use(cookieParser());
app.post('/transfer', (_req, res) => res.send('ok'));

module.exports = { app };
