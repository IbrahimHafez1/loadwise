// Shapes shared by the `db` modules: how a connection is described, the driver surface `db` relies
// on, and the adapters and gateways built on top of it.
import type { PlanDocument } from './db-plan.cjs';

export type DbEngine = 'postgres' | 'mysql' | 'mongo';

/**
 * Removes connection values from any text; the argument may be a driver message or code of any
 * type.
 */
export type Redactor = (text: unknown) => string;

/** A row as a driver returns it, before a statement-specific shape is applied. */
export type DbRow = Record<string, unknown>;

/**
 * A MongoDB command document, validated against the read-only allowlist before it reaches the
 * driver.
 */
export type MongoCommand = Record<string, unknown>;

/** Where `db` listens for Ctrl+C: the process, or a stand-in in tests. */
export interface SignalSource {
  on(event: 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGINT', listener: () => void): unknown;
}

export interface ConnectionParts {
  host?: string;
  port?: string;
  user?: string;
  password?: string;
  database?: string;
}

interface ConnectionBase {
  engine: DbEngine;
  envVarNames: string[];
  databaseName: string;
  redact: Redactor;
}

export interface UrlConnection extends ConnectionBase {
  url: string;
  parts?: undefined;
}

export interface PartsConnection extends ConnectionBase {
  url?: undefined;
  parts: ConnectionParts;
}

export type DbConnection = UrlConnection | PartsConnection;

export interface PgClient {
  on(event: string, listener: () => void): unknown;
  connect(): Promise<unknown>;
  query<Row>(statement: string | { text: string; values: readonly unknown[] }): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
  connection?: { stream?: { destroy(): void } };
}

export interface PgDriver {
  Client: new (settings: {
    connectionString?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    connectionTimeoutMillis: number;
  }) => PgClient;
}

export interface MysqlConnectionLike {
  on?(event: string, listener: () => void): unknown;
  query<Row>(text: string, params?: readonly unknown[]): Promise<[Row[], unknown]>;
  end(): Promise<void>;
  destroy(): void;
}

export interface MysqlDriver {
  createConnection(settings: {
    uri?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    connectTimeout: number;
    multipleStatements: boolean;
  }): Promise<MysqlConnectionLike>;
}

export interface MongoDatabaseLike {
  databaseName: string;
  command<Result>(document: MongoCommand, options: { readPreference: string }): Promise<Result>;
}

export interface MongoClientLike {
  connect(): Promise<unknown>;
  db(name?: string): MongoDatabaseLike;
  close(force?: boolean): Promise<void>;
}

export interface MongoDriver {
  MongoClient: new (
    url: string,
    options: { readPreference: string; serverSelectionTimeoutMS: number; appName: string },
  ) => MongoClientLike;
}

export type DbDriver = PgDriver | MysqlDriver | MongoDriver;

export interface RelationalAdapter {
  engine: 'postgres' | 'mysql';
  query<Row>(text: string, params?: readonly unknown[]): Promise<Row[]>;
  close(): Promise<void>;
  destroy(): Promise<void>;
}

export interface MongoAdapter {
  engine: 'mongo';
  databaseName: string;
  command<Result>(document: MongoCommand, databaseOverride?: string): Promise<Result>;
  close(): Promise<void>;
  destroy(): Promise<void>;
}

export type DbAdapter = RelationalAdapter | MongoAdapter;

export interface IndexDefinitionParts {
  schema: string;
  table: string;
  columns: readonly string[];
  name?: string;
}

/** What `--measure` may do inside its one rolled-back read-write transaction. */
export interface MeasureTransaction {
  createIndex(definition: IndexDefinitionParts): Promise<unknown>;
  readOnly(): Promise<unknown>;
  explainAnalyze(sql: string): Promise<PlanDocument>;
}

export interface ExplainOptions {
  generic?: boolean;
  analyze?: boolean;
}

/**
 * The only way `db` talks to PostgreSQL or MySQL: named catalog statements and validated EXPLAIN.
 */
export interface RelationalGateway {
  engine: 'postgres' | 'mysql';
  open(): Promise<void>;
  unit<Result>(body: () => Promise<Result> | Result): Promise<Result>;
  catalog<Row = DbRow>(id: string, params?: readonly unknown[]): Promise<Row[]>;
  explain(sql: string, options?: ExplainOptions): Promise<PlanDocument>;
  measureTransaction<Result>(body: (transaction: MeasureTransaction) => Promise<Result>): Promise<Result>;
  close(): Promise<void> | undefined;
  destroy(): Promise<void>;
}
