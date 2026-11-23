// Widespread request-wrapper shape (CWE-295): rejectUnauthorized:false turns off certificate validation.
const https = require('node:https');

module.exports = function fetchPartner(url, callback) {
  const agent = new https.Agent({ rejectUnauthorized: false });
  https.get(url, { agent }, callback);
};
