// The flags of a source check once parsed; `default`s in sourceCheckOptions make the lists and
// `fail-on` always present.
export interface SourceCheckValues {
  project?: string;
  workspace: string[];
  policy?: string;
  'loadwise-config'?: string;
  'fail-on': string;
  'include-contextual': boolean;
  json?: boolean;
  format?: string;
  watch?: boolean;
  native?: boolean;
  engine?: string;
  ignore: string[];
  'min-impact'?: string;
  schema?: string;
  fix?: boolean;
  yes?: boolean;
  only: string[];
  comments?: boolean;
  'no-comments'?: boolean;
  'no-format'?: boolean;
  staged?: boolean;
  'changed-since'?: string;
  with?: string;
  online?: boolean;
  /** Set after parsing: the command that applies fixes, shown in reports. */
  fixCommand?: string;
  /** Set after parsing: the pillar the report belongs to, `performance` unless `loadwise rel` runs. */
  sourcePillar?: 'performance' | 'reliability' | 'accessibility';
}
