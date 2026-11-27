// Pre-fix jsonwebtoken usage (CVE-2015-9235, GHSA-c7hr-j4mj-j2w6): verify() without an algorithms allow-list lets the token pick its algorithm.
const jwt = require('jsonwebtoken');

module.exports = function authenticate(token, publicKey) {
  return jwt.verify(token, publicKey);
};
