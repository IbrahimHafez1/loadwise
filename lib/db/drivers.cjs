'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { parseEnv } = require('node:util');
const { createRedactor, parseConnectionUrl } = require('./redact.cjs');

const defaultUrlEnv = 'DATABASE_URL';
const connectTimeoutMs = 10_000;
const applicationName = 'backend-perf-check';
const engineBySchemes = new Map([
  ['postgres', 'postgres'],
  ['postgresql', 'postgres'],
  ['mysql', 'mysql'],
  ['mysql2', 'mysql'],
  ['mongodb', 'mongo'],
  ['mongodb+srv', 'mongo'],
]);
const engineByDefaultPort = new Map([
  ['5432', 'postgres'],
  ['3306', 'mysql'],
  ['27017', 'mongo'],
]);
const discreteVariables = {
  host: ['DB_HOST'],
  port: ['DB_PORT'],
  user: ['DB_USER', 'DB_USERNAME'],
  password: ['DB_PASSWORD'],
  database: ['DB_NAME', 'DB_DATABASE'],
};
const driverPackages = { postgres: 'pg', mysql: 'mysql2', mongo: 'mongodb' };

// Usage and setup problems: exit 2 with a message that never contains connection values.
class DbUsageError extends Error {}

function pickVariable(source, names) {
  for (const name of names) {
    if (typeof source[name] === 'string' && source[name] !== '') return { name, value: source[name] };
  }
}

// --env-file is read as data, never loaded into process.env, so the rest of the process cannot see it.
function readVariables({ env, envFile, readFile }) {
  if (!envFile) return env;
  let text;
  try {
    text = readFile(envFile);
  } catch {
    throw new DbUsageError('Could not read the --env-file.');
  }
  return parseEnv(text);
}

function fromUrl(urlEnv, url, requestedEngine) {
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

function fromParts(source, requestedEngine) {
  const picked = Object.fromEntries(
    Object.entries(discreteVariables).map(([field, names]) => [field, pickVariable(source, names)]),
  );
  const parts = Object.fromEntries(Object.entries(picked).map(([field, entry]) => [field, entry?.value]));
  const engine = requestedEngine ?? engineByDefaultPort.get(parts.port);
  if (!engine) throw new DbUsageError('Pass --engine postgres|mysql|mongo: DB_PORT does not identify the database.');
  return {
    engine,
    parts,
    envVarNames: Object.values(picked)
      .filter(Boolean)
      .map((entry) => entry.name),
    databaseName: parts.database ?? '',
    redact: createRedactor({ user: parts.user, password: parts.password, hosts: [parts.host] }),
  };
}

function resolveConnection({
  env = process.env,
  urlEnv,
  envFile,
  engine,
  readFile = (file) => fs.readFileSync(file, 'utf8'),
}) {
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
function findProjectRoot(start) {
  const begin = path.resolve(start);
  for (let directory = begin; ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, 'package.json'))) return directory;
    if (path.dirname(directory) === directory) return begin;
  }
}

function isMissing(error, specifier) {
  return error?.code === 'MODULE_NOT_FOUND' && String(error.message).includes(`'${specifier}'`);
}

function loadDriver(engine, projectRoot) {
  const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
  const attempts =
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
      return select(projectRequire(specifier));
    } catch (error) {
      if (!isMissing(error, specifier)) throw error;
    }
  }
  throw new DbUsageError(
    `\`${driverPackages[engine]}\` is not installed in this project. ` +
      "`db` uses the project's own driver; install it there or run from the project root.",
  );
}

async function connectPostgres(driver, connection) {
  const settings = connection.url
    ? { connectionString: connection.url }
    : {
        host: connection.parts.host,
        port: connection.parts.port ? Number(connection.parts.port) : undefined,
        user: connection.parts.user,
        password: connection.parts.password,
        database: connection.parts.database,
      };
  const client = new driver.Client({ ...settings, connectionTimeoutMillis: connectTimeoutMs });
  // An idle-socket error must not crash the process with an unredacted stack.
  client.on('error', () => {});
  await client.connect();
  return {
    engine: 'postgres',
    query: async (text, params) => (await client.query(params ? { text, values: params } : text)).rows,
    close: () => client.end(),
    // Destroying the socket ends the server session, so an open transaction cannot linger.
    destroy: async () => {
      client.connection?.stream?.destroy();
      await client.end().catch(() => {});
    },
  };
}

async function connectMysql(driver, connection) {
  const settings = connection.url
    ? { uri: connection.url }
    : {
        host: connection.parts.host,
        port: connection.parts.port ? Number(connection.parts.port) : undefined,
        user: connection.parts.user,
        password: connection.parts.password,
        database: connection.parts.database,
      };
  const client = await driver.createConnection({
    ...settings,
    connectTimeout: connectTimeoutMs,
    multipleStatements: false,
  });
  client.on?.('error', () => {});
  return {
    engine: 'mysql',
    query: async (text, params) => (await client.query(text, params))[0],
    close: () => client.end(),
    destroy: async () => client.destroy(),
  };
}

function mongoUrl(connection) {
  if (connection.url) return connection.url;
  const { host, port, user, password, database } = connection.parts;
  const credentials = user ? `${encodeURIComponent(user)}:${encodeURIComponent(password ?? '')}@` : '';
  return `mongodb://${credentials}${host}${port ? ':' + port : ''}/${encodeURIComponent(database ?? '')}`;
}

async function connectMongo(driver, connection) {
  const client = new driver.MongoClient(mongoUrl(connection), {
    readPreference: 'secondaryPreferred',
    serverSelectionTimeoutMS: connectTimeoutMs,
    appName: applicationName,
  });
  await client.connect();
  const databaseName = connection.databaseName || client.db().databaseName;
  return {
    engine: 'mongo',
    databaseName,
    command: (document, databaseOverride) =>
      client.db(databaseOverride ?? databaseName).command(document, { readPreference: 'secondaryPreferred' }),
    close: () => client.close(),
    destroy: () => client.close(true),
  };
}

function connect(driver, connection) {
  if (connection.engine === 'postgres') return connectPostgres(driver, connection);
  if (connection.engine === 'mysql') return connectMysql(driver, connection);
  return connectMongo(driver, connection);
}

module.exports = {
  DbUsageError,
  applicationName,
  defaultUrlEnv,
  resolveConnection,
  findProjectRoot,
  loadDriver,
  connect,
};
