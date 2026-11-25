/** A fixed example shown with a finding: the code, then a note on what to change. */
export type RuleExample = [code: string, note: string];

/** The examples of one rule group, keyed by rule id. */
export type RuleExamples = Record<string, RuleExample>;
