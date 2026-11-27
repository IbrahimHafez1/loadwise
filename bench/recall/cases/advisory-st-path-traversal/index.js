// Pre-fix st static file handler shape (CVE-2014-3744, GHSA-69rr-wvh9-6c4q): request path is joined onto the mount root and read.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const mountRoot = path.resolve('public');

http
  .createServer((req, res) => {
    const filePath = path.join(mountRoot, decodeURIComponent(req.url));
    fs.readFile(filePath, (error, content) => {
      if (error) return res.end('not found');
      res.end(content);
    });
  })
  .listen(8080);
