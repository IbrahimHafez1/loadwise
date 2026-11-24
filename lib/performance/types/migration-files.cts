// Migration files as discovery finds them and as the enforcement policies judge them.
import type { MigrationDialect } from './migration-operations.cjs';

/**
 * `code` is a JavaScript or TypeScript migration; the others are SQL files named after their tool.
 */
export type MigrationFileFramework = 'prisma' | 'drizzle' | 'sql' | 'code';

export interface MigrationFile {
  path: string;
  framework: MigrationFileFramework;
  dialect: MigrationDialect;
}

/** A migration whose text has been read. */
export interface MigrationSource {
  path: string;
  text: string;
}

export interface LoadedMigration extends MigrationFile, MigrationSource {
  displayPath: string;
}

/** Migration files found together: one tool's folder, or one directory named `migrations`. */
export interface MigrationGroup {
  framework: 'prisma' | 'drizzle' | 'directory';
  directory: string;
  provider?: string | null;
  dialect: MigrationDialect | null;
  files: string[];
}

export interface MigrationDiscovery {
  files: MigrationFile[];
  skipped: string[];
}

/** Which migrations count ("only new migrations fail") and why the others are contextual. */
export interface MigrationPolicy {
  reason: string | null;
  isEnforced(migration: MigrationSource): boolean;
}

/** `{ version, files: { path: sha256 } }` as written by `--write-baseline`. */
export interface BaselineDocument {
  version: number;
  files: Record<string, string>;
}
