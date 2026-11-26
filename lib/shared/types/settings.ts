import type { Finding, RulePolicy } from '../types.js';

export type RuleOptionValue = number | boolean | string;
export type RuleOptions = Record<string, RuleOptionValue>;

/**
 * A rule's level in loadwise.config.json: the level alone or an object holding it and optional
 * per-rule options.
 */
export type RuleSetting = string | { level: string; options?: RuleOptions };

export interface ConfigOverride {
  files: string[];
  rules: Record<string, RuleSetting>;
}

/** The contents of loadwise.config.json once validated. */
export interface LoadwiseConfig {
  $schema?: string;
  checkers?: string[];
  ignore?: string[];
  rules?: Record<string, RuleSetting>;
  overrides?: ConfigOverride[];
  performance?: RulePolicy;
  maintainability?: RulePolicy;
}

export interface LoadedConfig {
  filename: string;
  directory: string;
  config: LoadwiseConfig;
}

/**
 * What a checker needs from the config: its policy section, plus the filters that apply to its
 * findings.
 */
export interface LoadwiseSettings {
  filename: string | undefined;
  /**
   * Lets a checker leave ignored files out of its scan; undefined when the config ignores nothing.
   */
  isIgnored: ((fileBase: string, file: string) => boolean) | undefined;
  performance: RulePolicy | undefined;
  maintainability: RulePolicy | undefined;
  checkers: string[] | undefined;
  /** Returns the effective per-rule options for a rule and optional relative file path, if any. */
  ruleOptions(ruleId: string, relativeFile?: string): RuleOptions | undefined;
  /** Drops ignored paths and "off" rules and tags the rest with their "warn" or "error" level. */
  apply(findings: Finding[], fileBase: string): Finding[];
  /** "warn" never counts, "error" always counts, and the rest count when isContract allows them. */
  exitCount(findings: Finding[], isContract?: (finding: Finding) => boolean): number;
  warningNote(findings: Finding[]): string;
}
