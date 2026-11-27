// One JSON line of `ast-grep scan --json=stream`, as the polyglot checks read it.

export interface AstGrepPosition {
  line: number;
  column: number;
}

export interface AstGrepMatch {
  ruleId: string;
  message: string;
  file: string;
  text: string;
  language?: string;
  range: {
    start: AstGrepPosition;
    byteOffset: { start: number; end: number };
  };
}
