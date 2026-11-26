import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseEnv } from 'node:util';
import { isTempRoot, safeExists } from '../../shared/project-root.js';
import { createRedactor, parseConnectionUrl } from './redact.js';
import type {
  ConnectionParts,
  DbAdapter,
  DbConnection,
  DbDriver,
  DbEngine,
  MongoAdapter,
  MongoCommand,
  MongoDriver,
  MysqlDriver,
  PartsConnection,
  PgDriver,
  RelationalAdapter,
  UrlConnection,
} from '../types/db-connection.js';

type EnvSource = Record<string, string | undefined>;

interface PickedVariable {
  name: string;
  value: string;
}

interface ResolveConnectionInput {
  env?: EnvSource;
  urlEnv?: string;
  envFile?: string;
  engine?: DbEngine;
  readFile?: (file: string) => string;
}

interface ReadVariablesInput {
  env: EnvSource;
  envFile?: string;
  readFile: (file: string) => string;
}

// What a project's driver package may expose; each engine's attempt picks the part it needs.
interface DriverModule extends PgDriver, MysqlDriver, MongoDriver {
  mongo: MongoDriver;
}

type DriverAttempt = readonly [specifier: string, select: (module: DriverModule) => DbDriver];

const defaultUrlEnv = 'DATABASE_URL';
const connectTimeoutMs = 10_000;
const applicationName = 'loadwise';
const engineBySchemes = new Map<string, DbEngine>([
  ['postgres', 'postgres'],
  ['postgresql', 'postgres'],
  ['mysql', 'mysql'],
  ['mysql2', 'mysql'],
  ['mongodb', 'mongo'],
  ['mongodb+srv', 'mongo'],
]);
const engineByDefaultPort = new Map<string, DbEngine>([
  ['5432', 'postgres'],
  ['3306', 'mysql'],
  ['27017', 'mongo'],
]);
const discreteVariables: Record<keyof ConnectionParts, readonly string[]> = {
  host: ['DB_HOST'],
  port: ['DB_PORT'],
  user: ['DB_USER', 'DB_USERNAME'],
  password: ['DB_PASSWORD'],
  database: ['DB_NAME', 'DB_DATABASE'],
};
const driverPackages: Record<DbEngine, string> = { postgres: 'pg', mysql: 'mysql2', mongo: 'mongodb' };

// Usage and setup problems: exit 2 with a message that never contains connection values.
class DbUsageError extends Error {}

function pickVariable(source: EnvSource, names: readonly string[]): PickedVariable | undefined {
  for (const name of names) {
    const value = source[name];
    if (typeof value === 'string' && value !== '') return { name, value };
  }
}

// --env-file is read as data, never loaded into process.env, so the rest of the process cannot see
// it.
function readVariables({ env, envFile, readFile }: ReadVariablesInput): EnvSource {
  if (!envFile) return env;
  let text: string;
  try {
    text = readFile(envFile);
  } catch {
    throw new DbUsageError('Could not read the --env-file.');
  }
  return parseEnv(text);
}

function fromUrl(urlEnv: string, url: string, requestedEngine: DbEngine | undefined): UrlConnection {
  const parsed = parseConnectionUrl(url);
  if (!parsed || parsed.hosts.length === 0) {
    throw new DbUsageError(`\`${urlEnv}\` does not hold a connection URL of the form scheme://user:password@host/db.`);
  }
  const engine = engineBySchemes.get(parsed.scheme);
  if (!engine) throw new DbUsageError(`\`${urlEnv}\` uses an unsupported scheme; expected postgres, mysql or mongodb.`);
  if (requestedEngine && requestedEngine !== engine) {
    throw new DbUsageError(`--engine ${requestedEngine} does not match the ${engine} URL in \`${urlEnv}\`.`);
  }
  return {
    engine,
    url,
    envVarNames: [urlEnv],
    databaseName: parsed.database,
    redact: createRedactor({
      url,
      user: parsed.user,
      password: parsed.password,
      hosts: parsed.hosts,
      extra: [parsed.rawUserInfo],
    }),
  };
}

function fromParts(source: EnvSource, requestedEngine: DbEngine | undefined): PartsConnection {
  const picked = Object.fromEntries(
    Object.entries(discreteVariables).map(([field, names]) => [field, pickVariable(source, names)]),
  );
  const parts: ConnectionParts = Object.fromEntries(
    Object.entries(picked).map(([field, entry]) => [field, entry?.value]),
  );
  const engine = requestedEngine ?? (parts.port === undefined ? undefined : engineByDefaultPort.get(parts.port));
  if (!engine) throw new DbUsageError('Pass --engine postgres|mysql|mongo: DB_PORT does not identify the database.');
  return {
    engine,
    parts,
    envVarNames: Object.values(picked).flatMap((entry) => (entry ? [entry.name] : [])),
    databaseName: parts.database ?? '',
    redact: createRedactor({
      user: parts.user,
      password: parts.password,
      hosts: parts.host === undefined ? [] : [parts.host],
    }),
  };
}

function resolveConnection({
  env = process.env,
  urlEnv,
  envFile,
  engine,
  readFile = (file) => fs.readFileSync(file, 'utf8'),
}: ResolveConnectionInput): DbConnection {
  const source = readVariables({ env, envFile, readFile });
  const urlVariable = urlEnv ?? defaultUrlEnv;
  const url = source[urlVariable];
  if (typeof url === 'string' && url !== '') return fromUrl(urlVariable, url, engine);
  if (urlEnv) throw new DbUsageError(`\`${urlEnv}\` is not set${envFile ? ' in the --env-file' : ''}.`);
  if (pickVariable(source, discreteVariables.host)) return fromParts(source, engine);
  throw new DbUsageError(
    `No connection: set ${defaultUrlEnv} (or name another variable with --url-env), ` +
      'or DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME.',
  );
}

// The nearest package.json marks the project whose own driver is used.
function findProjectRoot(start: string) {
  const begin = path.resolve(start);
  for (let directory = begin; ; directory = path.dirname(directory)) {
    if (isTempRoot(directory)) return begin;
    if (safeExists(path.join(directory, 'package.json'))) return directory;
    if (path.dirname(directory) === directory) return begin;
  }
}

function isMissing(error: unknown, specifier: string) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'MODULE_NOT_FOUND' &&
    'message' in error &&
    String(error.message).includes(`'${specifier}'`)
  );
}

function loadDriver(engine: DbEngine, projectRoot: string): DbDriver {
  const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
  const attempts: readonly DriverAttempt[] =
    engine === 'postgres'
      ? [['pg', (module) => module]]
      : engine === 'mysql'
        ? [['mysql2/promise', (module) => module]]
        : [
            ['mongodb', (module) => module],
            ['mongoose', (module) => module.mongo],
          ];
  for (const [specifier, select] of attempts) {
    try {
      const loaded: DriverModule = projectRequire(specifier);
      return select(loaded);
    } catch (error) {
      if (!isMissing(error, specifier)) throw error;
    }
  }
  throw new DbUsageError(
    `\`${driverPackages[engine]}\` is not installed in this project. ` +
      "`db` uses the project's own driver; install it there or run from the project root.",
  );
}

async function connectPostgres(driver: PgDriver, connection: DbConnection): Promise<RelationalAdapter> {
  const settings =
    connection.url === undefined
      ? {
          host: connection.parts.host,
          port: connection.parts.port ? Number(connection.parts.port) : undefined,
          user: connection.parts.user,
          password: connection.parts.password,
          database: connection.parts.database,
        }
      : { connectionString: connection.url };
  const client = new driver.Client({ ...settings, connectionTimeoutMillis: connectTimeoutMs });
  // An idle-socket error must not crash the process with an unredacted stack.
  client.on('error', () => {});
  await client.connect();
  return {
    engine: 'postgres',
    query: async <Row>(text: string, params?: readonly unknown[]) =>
      (await client.query<Row>(params ? { text, values: params } : text)).rows,
    close: () => client.end(),
    // Destroying the socket ends the server session, so an open transaction cannot linger.
    destroy: async () => {
      client.connection?.stream?.destroy();
      await client.end().catch(() => {});
    },
  };
}

async function connectMysql(driver: MysqlDriver, connection: DbConnection): Promise<RelationalAdapter> {
  const settings =
    connection.url === undefined
      ? {
          host: connection.parts.host,
          port: connection.parts.port ? Number(connection.parts.port) : undefined,
          user: connection.parts.user,
          password: connection.parts.password,
          database: connection.parts.database,
        }
      : { uri: connection.url };
  const client = await driver.createConnection({
    ...settings,
    connectTimeout: connectTimeoutMs,
    multipleStatements: false,
  });
  client.on?.('error', () => {});
  return {
    engine: 'mysql',
    query: async <Row>(text: string, params?: readonly unknown[]) => (await client.query<Row>(text, params))[0],
    close: () => client.end(),
    destroy: async () => client.destroy(),
  };
}

function mongoUrl(connection: DbConnection) {
  if (connection.url !== undefined) return connection.url;
  const { host, port, user, password, database } = connection.parts;
  const credentials = user ? `${encodeURIComponent(user)}:${encodeURIComponent(password ?? '')}@` : '';
  return `mongodb://${credentials}${host}${port ? ':' + port : ''}/${encodeURIComponent(database ?? '')}`;
}

async function connectMongo(driver: MongoDriver, connection: DbConnection): Promise<MongoAdapter> {
  const client = new driver.MongoClient(mongoUrl(connection), {
    readPreference: 'secondaryPreferred',
    serverSelectionTimeoutMS: connectTimeoutMs,
    appName: applicationName,
  });
  await client.connect();
  let databaseName: string;
  try {
    databaseName = connection.databaseName || client.db().databaseName;
  } catch (error) {
    await client.close(true).catch(() => {});
    throw error;
  }
  return {
    engine: 'mongo',
    databaseName,
    command: <Result>(document: MongoCommand, databaseOverride?: string) =>
      client.db(databaseOverride ?? databaseName).command<Result>(document, { readPreference: 'secondaryPreferred' }),
    close: () => client.close(),
    destroy: () => client.close(true),
  };
}

function connect(driver: DbDriver, connection: DbConnection): Promise<DbAdapter> {
  if (connection.engine === 'postgres' && 'Client' in driver) return connectPostgres(driver, connection);
  if (connection.engine === 'mysql' && 'createConnection' in driver) return connectMysql(driver, connection);
  if (connection.engine === 'mongo' && 'MongoClient' in driver) return connectMongo(driver, connection);
  throw new TypeError(`The loaded driver does not match the ${connection.engine} connection.`);
}

export { DbUsageError, applicationName, defaultUrlEnv, resolveConnection, findProjectRoot, loadDriver, connect };
