import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

// Semantic error codes that indicate a fix broke identifier resolution, types, or async context.
const GATED_ERROR_CODES = new Set([2304, 2322, 2339, 2345, 2554, 1308]);
const TS_FILE_PATTERN = /\.[cm]?tsx?$/i;

function findTsConfig(directory: string): string | undefined {
  let current = path.resolve(directory);
  for (;;) {
    const candidate = path.join(current, 'tsconfig.json');
    if (fs.existsSync(candidate)) return candidate;
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

function createVirtualProgram(
  tsconfigPath: string,
  overrides: ReadonlyMap<string, string | undefined>,
  oldProgram?: ts.Program,
): ts.Program | undefined {
  const readFile = (filePath: string): string | undefined => ts.sys.readFile(filePath);
  const configFile = ts.readConfigFile(tsconfigPath, readFile);
  if (configFile.error) return undefined;
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(tsconfigPath));
  const host = ts.createCompilerHost(parsed.options);
  const normalizedOverrides = new Map<string, string | undefined>();
  for (const [file, text] of overrides) normalizedOverrides.set(path.resolve(file), text);

  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);

  host.fileExists = (fileName: string) => {
    const resolved = path.resolve(fileName);
    if (normalizedOverrides.has(resolved)) return normalizedOverrides.get(resolved) !== undefined;
    return originalFileExists(fileName);
  };
  host.readFile = (fileName: string) => {
    const resolved = path.resolve(fileName);
    if (normalizedOverrides.has(resolved)) return normalizedOverrides.get(resolved);
    return originalReadFile(fileName);
  };
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNew) => {
    const resolved = path.resolve(fileName);
    if (normalizedOverrides.has(resolved)) {
      const content = normalizedOverrides.get(resolved);
      return content === undefined ? undefined : ts.createSourceFile(fileName, content, languageVersion, true);
    }
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNew);
  };

  const rootNames = new Set(parsed.fileNames.map((name) => path.resolve(name)));
  for (const [file, text] of normalizedOverrides) {
    if (text !== undefined && TS_FILE_PATTERN.test(file)) rootNames.add(file);
  }
  return ts.createProgram([...rootNames], parsed.options, host, oldProgram);
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
    const beforeProgram = createVirtualProgram(tsconfigPath, originals);
    if (!beforeProgram) continue;
    const afterProgram = createVirtualProgram(tsconfigPath, updates, beforeProgram);
    if (!afterProgram) continue;
    for (const file of groupFiles) {
      const refusal = firstNewError(beforeProgram, afterProgram, file);
      if (refusal) refusals.set(file, refusal);
    }
  }
  return refusals;
}
