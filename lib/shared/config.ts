// loadwise.config.json: one file for the checker selection, ignored paths, per-rule levels and each pillar's policy.
// Every checker calls loadSettings once and filters its findings through the result, so a new pillar gets the
// whole configuration by making that one call.
import fs from 'node:fs';
import path from 'node:path';
import { pillarNames, registeredRuleIds } from './pillar-rules.js';
import { createGlobMatcher } from './glob.js';
import { errorCode } from './error-code.js';
import { isRecord } from './is-record.js';
import type { Finding } from './types.js';
import type {
  ConfigOverride,
  LoadedConfig,
  LoadwiseConfig,
  LoadwiseSettings,
  RuleOptions,
  RuleSetting,
} from './types/settings.js';
import { rejectDuplicateKeys } from '../performance/query-policy.js';

const configFileName = 'loadwise.config.json';
const topLevelKeys = ['$schema', 'checkers', 'ignore', 'rules', 'overrides', 'performance', 'maintainability'];
const overrideKeys = ['files', 'rules'];
const levels = ['off', 'warn', 'error'];

type RuleOptionType = 'integer' | 'number' | 'boolean' | 'string';

interface RuleOptionSpec {
  type: RuleOptionType;
  min?: number;
  max?: number;
}

type RuleOptionsSchema = Record<string, RuleOptionSpec>;

const ruleOptionSchemas: Record<string, RuleOptionsSchema> = {
  'deep-control-flow': { maxDepth: { type: 'integer', min: 1 } },
  'high-branch-complexity': { maxComplexity: { type: 'integer', min: 1 } },
  'long-parameter-list': { maxParams: { type: 'integer', min: 1 } },
  'large-module': { maxLines: { type: 'integer', min: 1 } },
  'large-class': { maxMethods: { type: 'integer', min: 1 }, maxLines: { type: 'integer', min: 1 } },
  'bcrypt-low-cost': { minCost: { type: 'integer', min: 1 } },
  'graphql-query-depth-unbounded': { maxDepth: { type: 'integer', min: 1 } },
  'graphql-batching-unbounded': { maxBatchSize: { type: 'integer', min: 1 } },
  'orm-deep-offset': { maxOffset: { type: 'integer', min: 1 } },
  'upload-without-size-limit': { maxBytes: { type: 'integer', min: 1 } },
};

function readConfigFile(filename: string): unknown {
  try {
    const contents = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
    const config: unknown = JSON.parse(contents);
    // A repeated key silently drops its first value, which would hide a policy scope or a rule
    // level.
    rejectDuplicateKeys(contents, 'config key');
    return config;
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`Invalid ${filename}: ${error.message}`);
    if (error instanceof SyntaxError) throw new Error('Invalid JSON in ' + filename);
    if (errorCode(error) === 'ENOENT') throw new Error('Cannot find config file ' + filename);
    throw error;
  }
}

function stringList(value: unknown, label: string, problems: string[]): value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    problems.push(`${label} must be an array of non-empty strings.`);
    return false;
  }
  return true;
}

function isLevel(value: unknown): boolean {
  return levels.some((level) => level === value);
}

function matchesOptionType(value: unknown, type: RuleOptionType): boolean {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function checkRuleOptions(ruleId: string, options: unknown, label: string, problems: string[]): void {
  if (!isRecord(options)) {
    problems.push(`${label}.${ruleId}.options must be an object.`);
    return;
  }
  const schema = Object.hasOwn(ruleOptionSchemas, ruleId) ? ruleOptionSchemas[ruleId] : undefined;
  if (!schema) {
    const keys = Object.keys(options);
    if (!keys.length) {
      problems.push(`rule "${ruleId}" in ${label} does not accept options.`);
      return;
    }
    for (const option of keys) {
      problems.push(`unknown option "${option}" for rule "${ruleId}" in ${label}.`);
    }
    return;
  }
  for (const [option, value] of Object.entries(options)) {
    const spec = Object.hasOwn(schema, option) ? schema[option] : undefined;
    if (!spec) {
      problems.push(`unknown option "${option}" for rule "${ruleId}" in ${label}.`);
      continue;
    }
    if (!matchesOptionType(value, spec.type)) {
      problems.push(`option "${option}" for rule "${ruleId}" in ${label} must be a ${spec.type}.`);
      continue;
    }
    if (typeof value === 'number') {
      if (spec.min !== undefined && value < spec.min) {
        problems.push(`option "${option}" for rule "${ruleId}" in ${label} must be >= ${spec.min}.`);
      }
      if (spec.max !== undefined && value > spec.max) {
        problems.push(`option "${option}" for rule "${ruleId}" in ${label} must be <= ${spec.max}.`);
      }
    }
  }
}

function checkRuleLevels(rules: unknown, label: string, knownRules: ReadonlySet<string>, problems: string[]): void {
  if (!isRecord(rules)) {
    problems.push(`${label} must be an object of rule ids.`);
    return;
  }
  for (const [ruleId, setting] of Object.entries(rules)) {
    if (!knownRules.has(ruleId)) problems.push(`unknown rule id "${ruleId}" in ${label}.`);
    const level = isRecord(setting) ? setting.level : setting;
    if (!isLevel(level)) problems.push(`${label}.${ruleId} needs a level of ${levels.join(', ')}.`);
    if (!isRecord(setting)) continue;
    for (const option of Object.keys(setting).filter((key) => key !== 'level' && key !== 'options')) {
      problems.push(`unknown option "${option}" for rule "${ruleId}" in ${label}.`);
    }
    if (Object.hasOwn(setting, 'options')) {
      checkRuleOptions(ruleId, setting.options, label, problems);
    }
  }
}

function checkOverrides(overrides: unknown, knownRules: ReadonlySet<string>, problems: string[]): void {
  if (!Array.isArray(overrides)) {
    problems.push('overrides must be an array.');
    return;
  }
  overrides.forEach((override: unknown, index: number) => {
    const label = `overrides[${index}]`;
    if (!isRecord(override)) {
      problems.push(`${label} must be an object.`);
      return;
    }
    for (const key of Object.keys(override).filter((name) => !overrideKeys.includes(name))) {
      problems.push(`unknown key "${key}" in ${label}. Allowed keys: ${overrideKeys.join(', ')}.`);
    }
    if (!Array.isArray(override.files) || !override.files.length)
      problems.push(`${label}.files must be a non-empty array.`);
    else stringList(override.files, `${label}.files`, problems);
    checkRuleLevels(override.rules, `${label}.rules`, knownRules, problems);
  });
}

function validateConfig(config: unknown, filename: string): asserts config is LoadwiseConfig {
  const problems: string[] = [];
  if (!isRecord(config)) throw new Error(`Invalid ${filename}: expected a JSON object.`);
  const knownRules = registeredRuleIds();
  for (const key of Object.keys(config).filter((name) => !topLevelKeys.includes(name))) {
    problems.push(`unknown key "${key}". Allowed keys: ${topLevelKeys.join(', ')}.`);
  }
  if (Object.hasOwn(config, '$schema') && typeof config.$schema !== 'string')
    problems.push('$schema must be a string.');
  validateConfiguredCheckers(config, problems);
  if (Object.hasOwn(config, 'ignore')) stringList(config.ignore, 'ignore', problems);
  if (Object.hasOwn(config, 'rules')) checkRuleLevels(config.rules, 'rules', knownRules, problems);
  if (Object.hasOwn(config, 'overrides')) checkOverrides(config.overrides, knownRules, problems);
  for (const section of ['performance', 'maintainability']) {
    if (Object.hasOwn(config, section) && !isRecord(config[section])) problems.push(`${section} must be an object.`);
  }
  if (problems.length)
    throw new Error(`Invalid ${filename}:\n${problems.map((problem) => '  - ' + problem).join('\n')}`);
}

function validateConfiguredCheckers(config: Record<string, unknown>, problems: string[]): void {
  if (Object.hasOwn(config, 'checkers')) {
    const { checkers } = config;
    if (stringList(checkers, 'checkers', problems) && !checkers.length) {
      problems.push('checkers needs at least one name.');
    }
    const names: unknown[] = Array.isArray(checkers) ? checkers : [];
    for (const name of names) {
      if (!pillarNames.some((known) => known === name))
        problems.push(`unknown checker "${name}"; use ${pillarNames.join(', ')}.`);
    }
  }
}

// The explicit file wins; otherwise the config sits in the project folder. Returns undefined when
// there is none.
function loadConfig({ directory, explicit }: { directory: string; explicit?: string }): LoadedConfig | undefined {
  const filename = explicit === undefined ? path.join(directory, configFileName) : path.resolve(explicit);
  if (explicit === undefined && !fs.statSync(filename, { throwIfNoEntry: false })?.isFile()) return undefined;
  const config = readConfigFile(filename);
  validateConfig(config, filename);
  return { filename, directory: path.dirname(filename), config };
}

function levelOf(setting: RuleSetting | undefined): string | undefined {
  return typeof setting === 'object' ? setting.level : setting;
}

function optionsOf(setting: RuleSetting | undefined): RuleOptions | undefined {
  return typeof setting === 'object' ? setting.options : undefined;
}

// What a checker needs from the config: its policy section, plus the filters that apply to its
// findings.
function createSettings(loaded: LoadedConfig | undefined, cliIgnore: readonly string[]): LoadwiseSettings {
  const config: LoadwiseConfig = loaded?.config ?? {};
  const isIgnored = createGlobMatcher(config.ignore ?? []);
  const cliOff = new Set(cliIgnore);
  const overrides = (config.overrides ?? []).map(({ files, rules }: ConfigOverride) => ({
    matches: createGlobMatcher(files),
    rules,
  }));

  function levelFor(ruleId: string, relativeFile: string): string | undefined {
    if (cliOff.has(ruleId)) return 'off';
    let level = levelOf(config.rules?.[ruleId]);
    for (const override of overrides) {
      if (override.matches(relativeFile) && Object.hasOwn(override.rules, ruleId))
        level = levelOf(override.rules[ruleId]);
    }
    return level;
  }

  function ruleOptions(ruleId: string, relativeFile = ''): RuleOptions | undefined {
    let merged: RuleOptions | undefined;
    const baseOptions = optionsOf(config.rules?.[ruleId]);
    if (baseOptions) merged = { ...baseOptions };
    if (!relativeFile) return merged;
    for (const override of overrides) {
      if (!override.matches(relativeFile) || !Object.hasOwn(override.rules, ruleId)) continue;
      const overrideOptions = optionsOf(override.rules[ruleId]);
      if (overrideOptions) merged = { ...merged, ...overrideOptions };
    }
    return merged;
  }

  function isIgnoredIn(fileBase: string, file: string): boolean {
    const relativeFile = path
      .relative(loaded?.directory ?? fileBase, path.resolve(fileBase, file))
      .split(path.sep)
      .join('/');
    return isIgnored(relativeFile);
  }

  return {
    filename: loaded?.filename,
    // Lets a checker leave ignored files out of its scan; undefined when the config ignores
    // nothing.
    isIgnored: config.ignore?.length ? isIgnoredIn : undefined,
    performance: config.performance,
    maintainability: config.maintainability,
    checkers: config.checkers,
    ruleOptions,
    // Drops ignored paths and "off" rules and tags the rest with their "warn" or "error" level.
    // fileBase is the folder the findings' file paths are relative to.
    apply(findings: Finding[], fileBase: string): Finding[] {
      const base = loaded?.directory ?? fileBase;
      return findings.filter((finding: Finding) => {
        const relativeFile = path
          .relative(base, path.resolve(fileBase, finding.file ?? ''))
          .split(path.sep)
          .join('/');
        if (isIgnored(relativeFile)) return false;
        const level = levelFor(finding.ruleId, relativeFile);
        if (level === 'off') return false;
        if (level) finding.level = level;
        return true;
      });
    },
    // "warn" never counts, "error" always counts, and the rest count when isContract allows them.
    exitCount(findings: Finding[], isContract: (finding: Finding) => boolean = () => true): number {
      return findings.filter(
        (finding: Finding) => finding.level !== 'warn' && (finding.level === 'error' || isContract(finding)),
      ).length;
    },
    warningNote(findings: Finding[]): string {
      const count = findings.filter((finding: Finding) => finding.level === 'warn').length;
      return count ? `${count} finding(s) are warnings and do not affect the exit code.` : '';
    },
  };
}

// The one hook every checker calls. ignore holds rule ids from the command line, which beat the
// config.
function loadSettings({
  directory,
  explicit,
  ignore = [],
}: {
  directory: string;
  explicit?: string;
  ignore?: readonly string[];
}): LoadwiseSettings {
  const loaded = loadConfig({ directory, explicit });
  const unknown = ignore.filter((ruleId) => !registeredRuleIds().has(ruleId));
  if (unknown.length) throw new Error('Unknown rule id: ' + unknown.join(', '));
  return createSettings(loaded, ignore);
}

export { loadConfig, loadSettings };
