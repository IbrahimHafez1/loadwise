// Reads the packages a lockfile pins: [{ name, version, direct, dev, line, manifestDirectories }]
// with one entry per name@version. `dev` is true only when every occurrence is development-only, as
// far as the lockfile says.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noteUnreadable } from '../../shared/coverage-notes.cjs';
import type { Lockfile, LockfilePackage } from '../types/lockfile.cjs';

/** The dependency groups a manifest or a lockfile entry lists by name. */
interface DependencyFields {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
}

type DependencyField = keyof DependencyFields;

/** One `packages` entry of a package-lock.json. */
interface PackageLockEntry extends DependencyFields {
  name?: string;
  version?: string;
  link?: boolean;
  dev?: boolean;
}

interface PackageLockFile {
  packages?: Record<string, PackageLockEntry>;
}

/** A node of the indentation tree `parseYamlMaps` reads; the root has indent -1. */
interface YamlNode {
  children: Map<string, YamlNode>;
  indent: number;
  line: number;
  value: string | undefined;
}

/** The first line of a yarn.lock block: the specifiers it covers. */
interface YarnHeader {
  specifiers: string[];
  line: number;
}

/** A direct dependency one pnpm importer declares. */
interface ImporterDependency {
  name: string;
  version: string;
  field: DependencyField;
}

interface PnpmImporter {
  importer: string;
  node: YamlNode;
}

interface ParseContext {
  root: string;
}

type LockfileParser = (text: string, context: ParseContext) => LockfilePackage[];

/** A lockfile found on disk: where it is, who owns it, and how to read it. */
interface LockfileLocation extends Lockfile {
  file: string;
  root: string;
  parse: LockfileParser;
}

const lockfileKinds: { file: string; manager: string; parse: LockfileParser }[] = [
  { file: 'package-lock.json', manager: 'npm', parse: parsePackageLock },
  { file: 'pnpm-lock.yaml', manager: 'pnpm', parse: parsePnpmLock },
  { file: 'yarn.lock', manager: 'yarn', parse: parseYarnLock },
];
const manifestDependencyFields: readonly DependencyField[] = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const productionFields: readonly DependencyField[] = ['dependencies', 'optionalDependencies', 'peerDependencies'];
// Versions that are not registry releases cannot be looked up in the advisory database.
const nonRegistryVersion = /^(?:link|file|workspace|portal|patch|git|github|https?):/;

// The nearest folder at or above `directory` that holds a lockfile, so a package inside a monorepo
// finds the root one. The search stops below the home folder, where a stray lockfile would belong
// to no project.
function findLockfile(directory: string): LockfileLocation | undefined {
  // Real paths, because Windows may name the same folder with a short 8.3 name.
  let home: string;
  try {
    home = fs.realpathSync.native(os.homedir());
  } catch {
    home = path.resolve(os.homedir());
  }
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    const kind = lockfileKinds.find(({ file }) => fs.existsSync(path.join(current, file)));
    if (kind) return { ...kind, filename: path.join(current, kind.file), root: current };
    const parent = path.dirname(current);
    if (parent === current || fs.realpathSync.native(parent) === home) return undefined;
  }
}

function readManifest(directory: string): DependencyFields | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // A directory without package.json is expected; one that cannot be read or parsed loses its
    // direct-dependency marks.
    noteUnreadable({
      error,
      location: path.join(directory, 'package.json'),
      consequence: 'direct dependencies there were not marked',
    });
    return undefined;
  }
}

function manifestNames(manifest: DependencyFields | undefined, fields: readonly DependencyField[]): Set<string> {
  return new Set(fields.flatMap((field) => Object.keys(manifest?.[field] ?? {})));
}

function addPackage(
  packages: Map<string, LockfilePackage>,
  { name, version, direct, dev, line, manifestDirectories }: LockfilePackage,
) {
  const key = `${name}@${version}`;
  const known = packages.get(key);
  if (!known) {
    packages.set(key, { name, version, direct, dev, line, manifestDirectories: direct ? manifestDirectories : [] });
    return;
  }
  known.dev = known.dev && dev;
  if (direct && !known.direct) known.manifestDirectories = manifestDirectories;
  known.direct = known.direct || direct;
}

function lineIndex(text: string, pattern: RegExp) {
  const lines = new Map<string, number>();
  text.split(/\r?\n/).forEach((lineText, index) => {
    const match = pattern.exec(lineText);
    if (match && !lines.has(match[1])) lines.set(match[1], index + 1);
  });
  return lines;
}

function parsePackageLock(text: string, { root }: ParseContext): LockfilePackage[] {
  const lock: PackageLockFile = JSON.parse(text);
  if (!lock.packages)
    throw new Error('package-lock.json lockfileVersion 1 is not supported; regenerate it with npm 7 or later.');
  const lines = lineIndex(text, /^\s*"(node_modules\/[^"]+)":\s*\{/);
  const rootManifest = lock.packages[''] ?? {};
  const directNames = manifestNames(rootManifest, manifestDependencyFields);
  const packages = new Map<string, LockfilePackage>();
  for (const [location, entry] of Object.entries(lock.packages)) {
    const marker = 'node_modules/';
    if (!location.startsWith(marker) || entry.link || !entry.version) continue;
    const name = entry.name ?? location.slice(location.lastIndexOf(marker) + marker.length);
    const direct = location === marker + name && directNames.has(name);
    addPackage(packages, {
      name,
      version: entry.version,
      direct,
      dev: entry.dev === true,
      line: lines.get(location) ?? 1,
      manifestDirectories: [root],
    });
  }
  return [...packages.values()];
}

// A minimal reader for the block-style YAML of a pnpm lockfile: nested maps with plain or quoted
// keys. Flow values such as { integrity: ... } and list items are kept as raw text or skipped,
// since only the structure is needed.
function parseYamlMaps(text: string): YamlNode {
  const rootNode: YamlNode = { children: new Map(), indent: -1, line: 0, value: undefined };
  const stack = [rootNode];
  const keyPattern = /^(\s*)(?:'((?:[^']|'')*)'|"((?:[^"\\]|\\.)*)"|(.+?))\s*:(?:\s+(.*))?$/;
  text.split(/\r?\n/).forEach((lineText, index) => {
    if (!lineText.trim() || lineText.trimStart().startsWith('#') || lineText.trimStart().startsWith('- ')) return;
    const match = keyPattern.exec(lineText);
    if (!match) return;
    const indent = match[1].length;
    const key = (match[2]?.replaceAll("''", "'") ?? match[3] ?? match[4]).trim();
    const rawValue = match[5]?.replace(/\s+#.*$/, '').trim();
    while ((stack.at(-1)?.indent ?? -1) >= indent) stack.pop();
    const node: YamlNode = {
      children: new Map(),
      indent,
      line: index + 1,
      value: rawValue ? unquote(rawValue) : undefined,
    };
    stack.at(-1)?.children.set(key, node);
    stack.push(node);
  });
  return rootNode;
}

function unquote(value: string) {
  return /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
}

// 'name@1.2.3(peer@4.5.6)', '/name@1.2.3' and the older '/name/1.2.3_peer' all name one package
// version.
function splitPnpmKey(key: string): { name: string; version: string } | undefined {
  const withoutPeers = key.replace(/^\//, '').replace(/\(.*$/, '');
  const at = withoutPeers.lastIndexOf('@');
  if (at > 0) return { name: withoutPeers.slice(0, at), version: withoutPeers.slice(at + 1) };
  const slash = withoutPeers.lastIndexOf('/');
  if (slash <= 0) return undefined;
  return { name: withoutPeers.slice(0, slash), version: withoutPeers.slice(slash + 1).replace(/_.*$/, '') };
}

function pnpmImporters(lock: YamlNode): PnpmImporter[] {
  const importers = lock.children.get('importers');
  if (importers) return [...importers.children].map(([importer, node]) => ({ importer, node }));
  return [{ importer: '.', node: lock }];
}

// name -> { version, dev } for the direct dependencies one importer declares.
function importerDependencies(importerNode: YamlNode): ImporterDependency[] {
  const result: ImporterDependency[] = [];
  for (const field of manifestDependencyFields) {
    for (const [name, node] of importerNode.children.get(field)?.children ?? []) {
      const version = node.children.get('version')?.value ?? node.value;
      if (version && !nonRegistryVersion.test(version)) result.push({ name, version, field });
    }
  }
  return result;
}

function pnpmProductionKeys(lock: YamlNode, importers: readonly PnpmImporter[]): Set<string> | undefined {
  const snapshots = lock.children.get('snapshots');
  if (!snapshots) return undefined;
  const reached = new Set<string>();
  const pending: string[] = [];
  for (const { node } of importers) {
    for (const { name, version, field } of importerDependencies(node)) {
      if (field !== 'devDependencies') pending.push(`${name}@${version}`);
    }
  }
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    if (reached.has(key)) continue;
    reached.add(key);
    const snapshot = snapshots.children.get(key);
    for (const field of ['dependencies', 'optionalDependencies']) {
      queuePnpmDependencies(snapshot, field, pending);
    }
  }
  return reached;
}

function queuePnpmDependencies(snapshot: YamlNode | undefined, field: string, pending: string[]) {
  for (const [name, node] of snapshot?.children.get(field)?.children ?? []) {
    if (node.value) pending.push(`${name}@${node.value}`);
  }
}

function parsePnpmLock(text: string, { root }: ParseContext): LockfilePackage[] {
  const lock = parseYamlMaps(text);
  const importers = pnpmImporters(lock);
  const manifestDirectoriesByName = new Map<string, string[]>();
  for (const { importer, node } of importers) {
    for (const { name } of importerDependencies(node)) {
      const directories = manifestDirectoriesByName.get(name) ?? [];
      directories.push(path.join(root, importer));
      manifestDirectoriesByName.set(name, directories);
    }
  }
  const productionKeys = pnpmProductionKeys(lock, importers);
  const productionVersions = new Set(
    [...(productionKeys ?? [])].map(splitPnpmKey).map((parsed) => parsed && `${parsed.name}@${parsed.version}`),
  );
  const packages = new Map<string, LockfilePackage>();
  for (const [key, node] of lock.children.get('packages')?.children ?? []) {
    const parsed = splitPnpmKey(key);
    if (!parsed || nonRegistryVersion.test(parsed.version)) continue;
    const dev = productionKeys
      ? !productionVersions.has(`${parsed.name}@${parsed.version}`)
      : node.children.get('dev')?.value === 'true';
    addPackage(packages, {
      ...parsed,
      direct: manifestDirectoriesByName.has(parsed.name),
      dev,
      line: node.line,
      manifestDirectories: manifestDirectoriesByName.get(parsed.name) ?? [],
    });
  }
  return [...packages.values()];
}

// yarn v1 headers read `name@^1.0.0", name@^1.2.0:`; berry's read `"name@npm:^1.0.0":`. Both give
// the resolved version on a `version` line inside the block.
function parseYarnLock(text: string, { root }: ParseContext): LockfilePackage[] {
  const manifest = readManifest(root);
  const directNames = manifestNames(manifest, manifestDependencyFields);
  const productionNames = manifestNames(manifest, productionFields);
  const packages = new Map<string, LockfilePackage>();
  let header: YarnHeader | undefined;
  text.split(/\r?\n/).forEach((lineText, index) => {
    if (/^\S.*:$/.test(lineText) && !lineText.startsWith('#')) {
      header = {
        specifiers: lineText
          .slice(0, -1)
          .split(',')
          .map((part) => unquote(part.trim())),
        line: index + 1,
      };
      return;
    }
    if (!header) return;
    const versionMatch = /^ {2}version:? "?([^"\s]+)"?$/.exec(lineText);
    if (!versionMatch) return;
    const [firstSpecifier] = header.specifiers;
    const { line: headerLine } = header;
    const nameEnd = firstSpecifier.indexOf('@', 1);
    if (nameEnd < 0) return;
    const name = firstSpecifier.slice(0, nameEnd);
    const specifierRange = firstSpecifier.slice(name.length + 1);
    header = undefined;
    if (nonRegistryVersion.test(specifierRange.replace(/^npm:/, ''))) return;
    addPackage(packages, {
      name,
      version: versionMatch[1],
      direct: directNames.has(name),
      dev: directNames.has(name) && !productionNames.has(name),
      line: headerLine,
      manifestDirectories: [root],
    });
  });
  return [...packages.values()];
}

function readLockfilePackages(lockfile: LockfileLocation): LockfilePackage[] {
  const text = fs.readFileSync(lockfile.filename, 'utf8');
  return lockfile.parse(text, { root: lockfile.root });
}

// The 1-based line of `"name":` in the package.json files that declare the dependency, or
// undefined.
function manifestLocation(directories: readonly string[], name: string): { file: string; line: number } | undefined {
  const needle = `"${name}"`;
  for (const directory of directories) {
    const filename = path.join(directory, 'package.json');
    let lines: string[];
    try {
      lines = fs.readFileSync(filename, 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    const index = lines.findIndex((lineText) => lineText.trimStart().startsWith(needle + ':'));
    if (index >= 0) return { file: filename, line: index + 1 };
  }
  return undefined;
}

export { findLockfile, readLockfilePackages, manifestLocation, splitPnpmKey };
