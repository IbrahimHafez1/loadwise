const vm = require('node:vm');

function evaluateSnippet(userCode, sandbox) {
  return vm.runInNewContext(userCode, sandbox);
}

module.exports = { evaluateSnippet };
