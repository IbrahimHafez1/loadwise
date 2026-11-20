'use strict';

// Output formats shared by `loadwise check`, `loadwise perf` and `loadwise maint`. Text and json are printed by each
// checker; the others are built from the same report objects json prints.
const formatNames = ['text', 'json', 'sarif', 'github'];
const renderers = {
  sarif: () => require('./sarif.cjs').formatSarif,
  github: () => require('./github.cjs').formatGithub,
};

// --json is an alias of --format json.
function resolveFormat({ format, json }) {
  if (format !== undefined && !formatNames.includes(format)) {
    throw new Error(`--format must be ${formatNames.join(', ')}.`);
  }
  if (json && format !== undefined && format !== 'json')
    throw new Error('--json cannot be combined with --format ' + format + '.');
  return format ?? (json ? 'json' : 'text');
}

// entries: [{ pillar: 'performance' | 'maintainability', root, report }]
function renderReports(format, entries) {
  return renderers[format]()(entries);
}

module.exports = { formatNames, resolveFormat, renderReports };
