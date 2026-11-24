export interface RecordedStatement {
  text: string;
  params?: readonly unknown[];
}

export type RecordedResponse = readonly unknown[] | ((params: readonly unknown[] | undefined, text: string) => unknown);

export interface StatementCatalog {
  statements: Readonly<Record<string, string>>;
}

export interface RecordingAdapterOptions {
  engine?: 'postgres' | 'mysql';
  catalog?: StatementCatalog;
  responses?: Readonly<Record<string, RecordedResponse>>;
}
