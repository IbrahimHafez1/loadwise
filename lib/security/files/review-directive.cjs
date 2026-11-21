'use strict';

// `# loadwise-reviewed <rule-id> -- reason` on the line above a finding, or at the end of its line, for the files
// whose comments start with # (env files, Dockerfiles, compose files).
const directive = /#[\t ]+loadwise-reviewed[\t ]+([a-z][a-z0-9-]*)[\t ]+--[\t ]+(\S[^\r\n]*?)[\t ]*$/;
const standaloneComment = /^[\t ]*#/;

function directiveFor(line, ruleId) {
  const match = line === undefined ? null : directive.exec(line);
  return match?.[1] === ruleId ? match[2] : undefined;
}

// `lines` are the file's lines; `lineNumber` is 1-based. Returns the contextual reason or undefined.
function reviewedReason(lines, lineNumber, ruleId) {
  const previous = lines[lineNumber - 2];
  const reason =
    (previous !== undefined && standaloneComment.test(previous) ? directiveFor(previous, ruleId) : undefined) ??
    directiveFor(lines[lineNumber - 1], ruleId);
  return reason && 'Reviewed in source: ' + reason;
}

module.exports = { reviewedReason };
