// Tokens and statements the MySQL tokenizer produces.

export type MysqlTokenType = 'ident' | 'string' | 'word' | 'punct';

export interface MysqlToken {
  type: MysqlTokenType;
  value: string;
  upper: string;
  start: number;
  end: number;
}

export interface TableName {
  table: string;
  schema: string | null;
}

export type AlterAction = { start?: number } & (
  | { type: 'add-column'; column: string | null; notNull: boolean; hasDefault: boolean }
  | { type: 'add-index'; unique: boolean }
  | { type: 'add-constraint'; primaryKey: boolean }
  | { type: 'drop-primary-key' }
  | { type: 'drop-index'; index: string | null }
  | { type: 'drop-constraint' }
  | { type: 'drop-column'; column: string | null }
  | { type: 'rename-column'; column: string | null; newName: string | null }
  | { type: 'rename-index' }
  | { type: 'rename-table'; newName: string | null }
  | { type: 'modify-column'; column: string | null }
  | { type: 'change-column'; column: string | null; newName: string | null }
  | { type: 'convert-charset' }
  | { type: 'other' }
);

export interface AlterTableStatement {
  kind: 'alter-table';
  table: string;
  schema: string | null;
  actions: AlterAction[];
  algorithm: string | null;
  lock: string | null;
}

export interface CreateIndexStatement {
  kind: 'create-index';
  index: string | null;
  table: string;
  schema: string | null;
  unique: boolean;
  algorithm: string | null;
  lock: string | null;
}

export interface DropTableStatement {
  kind: 'drop-table';
  tables: TableName[];
}

export interface DropIndexStatement {
  kind: 'drop-index';
  index: string | null;
  table: string;
  schema: string | null;
  algorithm: string | null;
  lock: string | null;
}

export interface RenameTableStatement {
  kind: 'rename-table';
  renames: { from: TableName; to: TableName }[];
}

export interface OtherStatement {
  kind: 'other';
}

export type RecognizedStatement =
  | AlterTableStatement
  | CreateIndexStatement
  | DropTableStatement
  | DropIndexStatement
  | RenameTableStatement
  | OtherStatement;

export type MysqlStatement = RecognizedStatement & {
  start: number;
  end: number;
  line: number;
  column: number;
  text: string;
};
