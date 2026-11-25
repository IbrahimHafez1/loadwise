// A link from an index finding to the model, entity or table declaration it concerns. Types only.

export interface DeclarationLink {
  file: string;
  line: number;
  column: number;
  message: string;
}
