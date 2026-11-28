/** A zero-based line and column in a document, as the editor reports them. */
export interface SourcePosition {
  line: number;
  character: number;
}

/** The part of an editor document the source-comparison modules read. */
export interface SourceDocument {
  languageId: string;
  isDirty: boolean;
  lineCount: number;
  lineAt(line: number): { text: string };
}
