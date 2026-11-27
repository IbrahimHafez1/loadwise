import path from 'node:path';
import * as ts from 'typescript';
import { isTempRoot, safeExists } from './project-root.js';

// Semantic error codes that indicate a fix broke identifier resolution, types, or async context.
const GATED_ERROR_CODES = new Set([2304, 2322, 2339, 2345, 2554, 1308]);
const TS_FILE_PATTERN = /\.[cm]?tsx?$/i;

function findTsConfig(directory: string): string | undefined {
  let current = path.resolve(directory);
  for (;;) {
    if (isTempRoot(current)) return undefined;
    const candidate = path.join(current, 'tsconfig.json');
    if (safeExists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function diagnosticCounts(program: ts.Program, file: string): Map<string, number> {
  const counts = new Map<string, number>();
  const sourceFile = program.getSourceFile(file);
  if (!sourceFile) return counts;
  for (const diagnostic of program.getSemanticDiagnostics(sourceFile)) {
    if (!GATED_ERROR_CODES.has(diagnostic.code)) continue;
    const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    const key = `TS${diagnostic.code}: ${text}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

interface CachedProjectConfig {
  parsed: ts.ParsedCommandLine;
  baseHost: ts.CompilerHost;
  rootNames: string[];
  rootKeys: Set<string>;
  getCanonicalFileName: (fileName: string) => string;
  cachedFileExists: (key: string, fileName: string) => boolean;
  cachedDirectoryExists?: (directoryName: string) => boolean;
  cachedReadFile: (key: string, fileName: string) => string | undefined;
  cachedGetSourceFile: (
    key: string,
    fileName: string,
    languageVersion: ts.ScriptTarget | ts.CreateSourceFileOptions,
    onError?: (message: string) => void,
    shouldCreateNewSourceFile?: boolean,
  ) => ts.SourceFile | undefined;
}

function loadProjectConfig(tsconfigPath: string): CachedProjectConfig | undefined {
  const readFile = (filePath: string): string | undefined => ts.sys.readFile(filePath);
  const configFile = ts.readConfigFile(tsconfigPath, readFile);
  if (configFile.error) return undefined;
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfigPath));
  const baseHost = ts.createCompilerHost(parsed.options);
  const getCanonicalFileName = baseHost.getCanonicalFileName.bind(baseHost);
  const canonicalKey = (fileName: string) => getCanonicalFileName(path.resolve(fileName));

  const originalGetSourceFile = baseHost.getSourceFile.bind(baseHost);
  const originalFileExists = baseHost.fileExists.bind(baseHost);
  const originalDirectoryExists = baseHost.directoryExists?.bind(baseHost);
  const originalReadFile = baseHost.readFile.bind(baseHost);

  const fileExistsCache = new Map<string, boolean>();
  const directoryExistsCache = new Map<string, boolean>();
  const readFileCache = new Map<string, string | undefined>();
  const sourceFileCache = new Map<string, ts.SourceFile | undefined>();

  const rootNames = [...new Set(parsed.fileNames.map((name) => path.resolve(name)))];
  const rootKeys = new Set(rootNames.map((name) => getCanonicalFileName(name)));

  return {
    parsed,
    baseHost,
    rootNames,
    rootKeys,
    getCanonicalFileName,
    cachedFileExists(key: string, fileName: string) {
      const cached = fileExistsCache.get(key);
      if (cached !== undefined) return cached;
      const exists = originalFileExists(fileName);
      fileExistsCache.set(key, exists);
      return exists;
    },
    cachedDirectoryExists: originalDirectoryExists
      ? (directoryName: string) => {
          const key = canonicalKey(directoryName);
          const cached = directoryExistsCache.get(key);
          if (cached !== undefined) return cached;
          const exists = originalDirectoryExists(directoryName);
          directoryExistsCache.set(key, exists);
          return exists;
        }
      : undefined,
    cachedReadFile(key: string, fileName: string) {
      if (readFileCache.has(key)) return readFileCache.get(key);
      const content = originalReadFile(fileName);
      readFileCache.set(key, content);
      return content;
    },
    cachedGetSourceFile(key, fileName, languageVersion, onError, shouldCreateNew) {
      if (!shouldCreateNew && sourceFileCache.has(key)) return sourceFileCache.get(key);
      const loaded = originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNew);
      sourceFileCache.set(key, loaded);
      return loaded;
    },
  };
}

function createVirtualProgram(
  project: CachedProjectConfig,
  overrides: ReadonlyMap<string, string | undefined>,
  oldProgram?: ts.Program,
): ts.Program | undefined {
  const canonicalKey = (fileName: string) => project.getCanonicalFileName(path.resolve(fileName));
  const normalizedOverrides = new Map<string, string | undefined>();
  const resolvedOverridePaths = new Map<string, string>();
  for (const [file, text] of overrides) {
    const resolved = path.resolve(file);
    const key = project.getCanonicalFileName(resolved);
    normalizedOverrides.set(key, text);
    resolvedOverridePaths.set(key, resolved);
  }

  const host: ts.CompilerHost = {
    ...project.baseHost,
    fileExists: (fileName: string) => {
      const key = canonicalKey(fileName);
      if (normalizedOverrides.has(key)) return normalizedOverrides.get(key) !== undefined;
      return project.cachedFileExists(key, fileName);
    },
    readFile: (fileName: string) => {
      const key = canonicalKey(fileName);
      if (normalizedOverrides.has(key)) return normalizedOverrides.get(key);
      return project.cachedReadFile(key, fileName);
    },
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNew) => {
      const key = canonicalKey(fileName);
      if (normalizedOverrides.has(key)) {
        const content = normalizedOverrides.get(key);
        return content === undefined ? undefined : ts.createSourceFile(fileName, content, languageVersion, true);
      }
      return project.cachedGetSourceFile(key, fileName, languageVersion, onError, shouldCreateNew);
    },
  };
  if (project.cachedDirectoryExists) {
    host.directoryExists = project.cachedDirectoryExists;
  }

  const rootNames = new Set(project.rootNames);
  const rootKeys = new Set(project.rootKeys);
  for (const [key, text] of normalizedOverrides) {
    const file = resolvedOverridePaths.get(key);
    if (text !== undefined && file && TS_FILE_PATTERN.test(file) && !rootKeys.has(key)) {
      rootNames.add(file);
      rootKeys.add(key);
    }
  }
  return ts.createProgram([...rootNames], project.parsed.options, host, oldProgram);
}

function firstNewError(beforeProgram: ts.Program, afterProgram: ts.Program, file: string): string | undefined {
  const beforeCounts = diagnosticCounts(beforeProgram, file);
  const afterCounts = diagnosticCounts(afterProgram, file);
  for (const [key, count] of afterCounts) {
    if (count > (beforeCounts.get(key) ?? 0)) {
      return `${file}: the fix would introduce a type error (${key}), so the file was not changed`;
    }
  }
  return undefined;
}

/**
 * Layer-2 semantic type-check gate for TypeScript projects. Compares gated semantic diagnostics
 * (`TS2304`, `TS2322`, `TS2339`, `TS2345`, `TS2554`, `TS1308`) on modified files before vs. after
 * candidate fixes and returns refusal messages for any file with newly introduced errors.
 */
export function introducedTypeErrors(
  directory: string,
  originals: ReadonlyMap<string, string | undefined>,
  updates: ReadonlyMap<string, string>,
): Map<string, string> {
  const refusals = new Map<string, string>();
  const tsFiles = [...updates.keys()].filter((file) => TS_FILE_PATTERN.test(file));
  if (!tsFiles.length) return refusals;

  const byTsConfig = new Map<string, string[]>();
  for (const file of tsFiles) {
    const tsconfigPath = findTsConfig(path.dirname(file)) ?? findTsConfig(directory);
    if (!tsconfigPath) continue;
    const list = byTsConfig.get(tsconfigPath) ?? [];
    list.push(file);
    byTsConfig.set(tsconfigPath, list);
  }

  for (const [tsconfigPath, groupFiles] of byTsConfig) {
    const project = loadProjectConfig(tsconfigPath);
    if (!project) continue;
    const beforeProgram = createVirtualProgram(project, originals);
    if (!beforeProgram) continue;
    const afterProgram = createVirtualProgram(project, updates, beforeProgram);
    if (!afterProgram) continue;
    for (const file of groupFiles) {
      const refusal = firstNewError(beforeProgram, afterProgram, file);
      if (refusal) refusals.set(file, refusal);
    }
  }
  return refusals;
}
