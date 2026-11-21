'use strict';

const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');

const spaceByte = 0x20;
const maxAssignmentLookaheadBytes = 64;
const csharpCandidateId = 'csharp-conditional-access-in-error';
const csharpCandidate = {
  id: csharpCandidateId,
  language: 'CSharp',
  severity: 'hint',
  message: 'Candidate for conditional assignment compatibility.',
  rule: { kind: 'conditional_access_expression', inside: { kind: 'ERROR', stopBy: 'end' } },
};
const csharpMissingAssignmentValue = {
  id: 'polyglot-parse-error-csharp-missing-rhs',
  language: 'CSharp',
  severity: 'warning',
  message: 'The assignment is missing its right-hand expression.',
  rule: { kind: 'assignment_expression', not: { has: { field: 'right', regex: '\\S' } } },
};
const javaAnnotatedVarargs =
  /^([\w$.]+(?:<[^()<>{};]+>)?(?:\[\])?\s+)@([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)(?=\s+\.\.\.\s+[A-Za-z_$][\w$]*$)/;
const javaReservedWords = new Set(
  (
    'abstract assert boolean break byte case catch char class const continue default do double else enum extends final ' +
    'finally float for goto if implements import instanceof int interface long native new package private protected ' +
    'public return short static strictfp super switch synchronized this throw throws transient try void volatile while ' +
    'true false null _'
  ).split(' '),
);
const csharpConditionalMember = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*\?\.[A-Za-z_]\w*$/;

function syntaxError(match) {
  return match.ruleId === 'syntax-error' || match.ruleId.startsWith('polyglot-parse-error-');
}

function compatibilityMatch(match) {
  return syntaxError(match) || match.ruleId === csharpCandidateId;
}

async function readMatches(stream, matches) {
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    matches.push(JSON.parse(line));
  }
}

async function retryCompatibility(binary, config, rules, filename, evidence) {
  const language = evidence.find(syntaxError)?.language;
  if (language !== 'Java' && language !== 'CSharp') return;
  const original = await fs.readFile(filename);
  const input = Buffer.from(original);
  let changed = false;
  for (const match of evidence) {
    const { start, end } = match.range.byteOffset;
    if (original.toString('utf8', start, end) !== match.text) return;
    if (language === 'Java' && syntaxError(match)) {
      const annotation = javaAnnotatedVarargs.exec(match.text);
      if (!annotation || annotation[2].split('.').some((name) => javaReservedWords.has(name))) continue;
      const offset = start + Buffer.byteLength(annotation[1]);
      input.fill(spaceByte, offset, offset + annotation[2].length + 1);
      changed = true;
    }
    if (match.ruleId === csharpCandidateId && csharpConditionalMember.test(match.text)) {
      if (!/^\s*=(?!=|>)/.test(original.toString('latin1', end, end + maxAssignmentLookaheadBytes))) continue;
      input[start + match.text.indexOf('?')] = spaceByte;
      changed = true;
    }
  }
  if (!changed) return;

  // Retry only the affected file and keep each line and byte offset. The original
  // text is still used for rules that compare source verbatim.
  let inlineRules = await rules(language);
  if (language === 'CSharp') inlineRules += '\n---\n' + JSON.stringify(csharpMissingAssignmentValue);
  const child = spawn(
    binary,
    [
      'scan',
      '--config',
      config,
      '--inline-rules',
      inlineRules,
      '--custom-languages',
      'ignore',
      '--json=stream',
      '--stdin',
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  child.stdin.on('error', () => {});
  child.stderr.resume();
  child.stdin.end(input);
  const matches = [];
  const [[code]] = await Promise.all([once(child, 'close'), readMatches(child.stdout, matches)]);
  if (code !== 0 || matches.some(syntaxError)) return;
  for (const match of matches) {
    const { start, end } = match.range.byteOffset;
    match.text = original.toString('utf8', start, end);
  }
  return matches.filter((match) => !compatibilityMatch(match));
}

module.exports = { csharpCandidate, syntaxError, compatibilityMatch, retryCompatibility };
