// A 1-based line and 1-based UTF-16 column in a source text.

export interface SourcePosition {
  line: number;
  column: number;
}

/** A position in a named file. */
export interface FileLocation extends SourcePosition {
  file: string;
}
