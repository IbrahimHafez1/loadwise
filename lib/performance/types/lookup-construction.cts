// The text around a lookup constructor: `new Set(` + array + calls + `)`.
export interface LookupConstruction {
  open: string;
  array: string;
  calls: string[];
  close: string;
}
