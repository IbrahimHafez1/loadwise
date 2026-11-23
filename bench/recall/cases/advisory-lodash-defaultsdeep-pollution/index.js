// Pre-fix lodash mergeWith/defaultsDeep shape (CVE-2019-10744, GHSA-jf85-cpcp-j695): recursive merge copies __proto__ keys from untrusted JSON.
const express = require('express');
const app = express();

function mergeDeep(target, source) {
  for (const key of Object.keys(source)) {
    if (typeof source[key] === 'object' && source[key] !== null) {
      target[key] = target[key] || {};
      mergeDeep(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

app.post('/settings', (req, res) => {
  res.json(mergeDeep({}, req.body));
});
