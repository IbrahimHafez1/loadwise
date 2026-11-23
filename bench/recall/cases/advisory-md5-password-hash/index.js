// Password storage shape (CWE-916): passwords hashed with a fast unsalted digest.
const crypto = require('node:crypto');

module.exports = function hashPassword(password) {
  return crypto.createHash('md5').update(password).digest('hex');
};
