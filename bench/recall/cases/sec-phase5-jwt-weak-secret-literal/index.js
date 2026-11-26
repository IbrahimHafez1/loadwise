const jwt = require('jsonwebtoken');

function issueToken(payload) {
  return jwt.sign(payload, 'dev-secret-key');
}

module.exports = { issueToken };
