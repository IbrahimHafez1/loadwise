import type { Finding } from '../types.js';

/**
 * `--baseline [file]` or `--write-baseline [file]`; without a file the project root's default name
 * is used.
 */
export interface BaselineOption {
  file?: string;
}

export interface BaselineFlagOptions {
  baseline?: BaselineOption;
  writeBaseline?: BaselineOption;
}

/**
 * What a scan covered, so `--write-baseline` keeps the recorded entries it could not have reported.
 */
export interface BaselineScope {
  paths: readonly string[];
  workspaces: readonly string[];
  ignoredRules: readonly string[];
  minImpact?: string;
}

export interface BaselineRunOptions extends BaselineFlagOptions {
  partialScan?: boolean;
  scope?: BaselineScope;
}

/**
 * The fingerprint of one finding: rule, file relative to the baseline's folder, and id without
 * collision suffix.
 */
export interface BaselineEntry {
  ruleId: string;
  file: string;
  fingerprint: string;
}

/** How many findings share one fingerprint; N recorded copies allow N findings. */
export interface BaselineCount extends BaselineEntry {
  count: number;
}

export interface BaselineDocument {
  version: number;
  pillars: Record<string, { findings?: BaselineCount[] } | undefined>;
}

/** A finding's fingerprint and the one older versions wrote, when it differs. */
export interface FindingKey {
  key: BaselineEntry;
  legacyKey: BaselineEntry | undefined;
}

export interface BaselineWritten {
  written: number;
  file: string;
}

/** `stale` is null when a partial scan cannot tell which recorded findings vanished. */
export interface BaselineFiltered {
  findings: Finding[];
  hidden: number;
  stale: number | null;
}
