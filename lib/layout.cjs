'use strict';

const path = require('node:path').posix;

function relativePath(value, label) {
  if (typeof value !== 'string' || !value.trim() || /^[a-z]:|^[/\\]/i.test(value) || value.includes('\0')) {
    throw new Error(label + ' must be a project-relative path.');
  }
  const normalized = path.normalize(value.replaceAll('\\', '/')).replace(/\/$/, '');
  if (normalized === '..' || normalized.startsWith('../')) throw new Error(label + ' points outside the project.');
  return normalized;
}

function checkPlacement(files, rules = []) {
  if (!Array.isArray(rules)) throw new Error('placement must be an array.');
  if (!rules.length) return [];
  const suffixes = new Set();
  const configured = rules
    .map((rule, index) => {
      const label = 'placement[' + index + ']';
      const suffix = rule?.suffix;
      if (typeof suffix !== 'string' || !suffix.trim() || /[/\\\0]/.test(suffix)) {
        throw new Error(label + '.suffix must be a nonempty filename suffix.');
      }
      if (suffixes.has(suffix)) throw new Error(label + ' duplicates placement suffix ' + suffix + '.');
      suffixes.add(suffix);
      if (!Array.isArray(rule.under) || !rule.under.length)
        throw new Error(label + '.under must list one or more project folders.');
      return { suffix, under: rule.under.map((folder) => relativePath(folder, label + '.under')) };
    })
    .sort((left, right) => right.suffix.length - left.suffix.length);

  const findings = [];
  for (const file of files) {
    const relative = relativePath(file, 'Placement source');
    const name = path.basename(relative);
    const match = configured.find((rule) => name.endsWith(rule.suffix));
    if (!match) continue;
    const directory = path.dirname(relative);
    if (match.under.some((folder) => folder === '.' || directory === folder || directory.startsWith(folder + '/')))
      continue;
    findings.push({
      file,
      line: 1,
      column: 1,
      ruleId: 'file-placement',
      message: 'The project places files ending in ' + match.suffix + ' under ' + match.under.join(' or ') + '.',
    });
  }
  return findings;
}

module.exports = { checkPlacement };
