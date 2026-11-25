// The ORM a project-model receiver is recognised as when the ORM package's own types are missing.

export type ModelFamily = 'typeorm' | 'mongoose' | 'sequelize' | 'drizzle';

export interface ModelFallback {
  orm: ModelFamily;
  packages: readonly string[];
}
