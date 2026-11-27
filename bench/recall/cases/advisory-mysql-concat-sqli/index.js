// Classic string-concatenated mysql2 query: the pattern behind a large class of Node SQL injection advisories (CWE-89).
const express = require('express');
const mysql = require('mysql2');
const app = express();
const connection = mysql.createConnection({ host: 'db' });

app.get('/items', (req, res) => {
  connection.query('SELECT * FROM items WHERE owner = ' + req.query.owner, (_error, rows) => res.json(rows));
});
