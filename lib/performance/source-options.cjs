'use strict';

const { knownRules } = require('./rule-ids.cjs');
const { parseMinImpact } = require('../shared/impact-levels.cjs');
const { resolveFormat } = require('../shared/formats/index.cjs');

const sourceCheckOptions = {
  project: { type: 'string', short: 'p' },
  workspace: { type: 'string', multiple: true, default: [] },
  policy: { type: 'string' },
  'loadwise-config': { type: 'string' },
  'fail-on': { type: 'string', default: 'all' },
  'include-contextual': { type: 'boolean', default: false },
  json: { type: 'boolean' },
  format: { type: 'string' },
  watch: { type: 'boolean' },
  native: { type: 'boolean' },
  engine: { type: 'string' },
  ignore: { type: 'string', multiple: true, default: [] },
  'min-impact': { type: 'string' },
  schema: { type: 'string' },
  fix: { type: 'boolean' },
  yes: { type: 'boolean' },
  only: { type: 'string', multiple: true, default: [] },
  'no-comments': { type: 'boolean' },
  'no-format': { type: 'boolean' },
  staged: { type: 'boolean' },
  'changed-since': { type: 'string' },
  // Internal: `loadwise check` passes `--with sec` to run both checkers over one Program.
  with: { type: 'string' },
  online: { type: 'boolean' },
};

function sourceEngine(values, positionals) {
  if (values.native && (values.engine ?? 'native') !== 'native')
    throw new Error('--native is an alias for --engine native.');
  const engine = values.native ? 'native' : (values.engine ?? 'auto');
  if (!['auto', 'native', 'js'].includes(engine)) throw new Error('--engine must be auto, native or js.');
  if (values.watch && engine === 'native')
    throw new Error('--native supports one-shot checks. Use --watch with the incremental JS compiler.');
  if (values.watch && positionals.length) throw new Error('--watch requires a project config.');
  return engine;
}

function selectedFixIds(values, baselineOptions) {
  const onlyIds = values.only
    .flatMap((list) => list.split(','))
    .map((id) => id.trim())
    .filter(Boolean);
  if (values.only.length && !values.fix) throw new Error('--only is only valid with --fix.');
  if (values.only.length && !onlyIds.length) throw new Error('--only needs at least one finding id.');
  if (values.fix && values.watch) throw new Error('--fix cannot be combined with --watch.');
  if ((baselineOptions.baseline || baselineOptions.writeBaseline) && (values.fix || values.watch)) {
    throw new Error('--baseline and --write-baseline cannot be combined with --fix or --watch.');
  }
  if (baselineOptions.writeBaseline && (values.staged || values['changed-since'] !== undefined)) {
    throw new Error('--write-baseline records every finding; it cannot be combined with --staged or --changed-since.');
  }
  if (values.fix && resolveFormat(values) === 'json' && !onlyIds.length)
    throw new Error('--fix prints a report with --json only with --only.');
  if (values.yes && !values.fix) throw new Error('--yes is only valid with --fix.');
  if ((values['no-comments'] || values['no-format']) && !values.fix)
    throw new Error('--no-comments and --no-format are only valid with --fix.');
  if (['sarif', 'github'].includes(resolveFormat(values)) && (values.fix || values.watch)) {
    throw new Error('--format sarif and github cannot be combined with --watch or --fix.');
  }
  return onlyIds;
}

function validateSourceOptions(values, positionals, baselineOptions) {
  if (values.project && positionals.length) throw new Error('Choose either a project or explicit source files.');
  if (!['all', 'contract'].includes(values['fail-on'])) throw new Error('--fail-on must be all or contract.');
  const engine = sourceEngine(values, positionals);
  const onlyIds = selectedFixIds(values, baselineOptions);
  if (values.with !== undefined && values.with !== 'sec') throw new Error('--with accepts only sec.');
  if (values.online && values.with !== 'sec') throw new Error('--online needs the security checker.');
  if (values.with !== undefined && (values.watch || values.fix || engine === 'native'))
    throw new Error('--with sec cannot be combined with --watch, --fix or the native engine.');
  const { securityRules } = require('../security/rule-ids.cjs');
  for (const ruleId of values.ignore) {
    if (!knownRules.has(ruleId) && !securityRules.includes(ruleId)) throw new Error('Unknown source rule: ' + ruleId);
  }
  parseMinImpact(values['min-impact']);
  return { engine, onlyIds };
}

module.exports = { sourceCheckOptions, validateSourceOptions };
