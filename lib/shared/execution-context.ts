import fs from 'node:fs';
import path from 'node:path';
import { ts } from '../performance/compiler.js';
import { isTempRoot, safeExists } from './project-root.js';
import type { SourceFile } from 'typescript';
import type { ProgramAdapter } from './types.js';

export type ExecutionRuntime = 'node-server' | 'browser' | 'cli-tooling' | 'test-fixture' | 'unknown';

export interface ExecutionContext {
  runtime: ExecutionRuntime;
  reasons: string[];
}

const TEST_FILE_PATTERN =
  /(?:[.-]i?(?:spec|test|e2e(?:-ee|-spec)?)\.[cm]?[jt]sx?$|^(?:vitest\.[^/]+\.setup|jest\.setup)\.[cm]?[jt]sx?$|playwright[^/]*\.[cm]?[jt]sx?$)/i;
const TEST_PATH_PATTERN = /(?:^|\/)(?:e2e|tests?|__tests__|test-utils|sandbox|fixtures|__fixtures__|__mocks__)\//i;

const CLI_TOOLING_PATH_PATTERN =
  /(?:^|\/)(?:tools?|scripts?|cli|codemods?|evaluations?|release-notes[^/]*|bundler|startup|create-[\w-]+)\/|(?:^|(?:src|cli)\/)commands?\//i;

const BROWSER_PATH_PATTERN =
  /(?:^|\/)(?:client-only|frontend|components|hooks|views|apps\/(?:admin|dashboard)[^/]*)\//i;

const UI_FRAMEWORK_IMPORTS = new Set([
  'react',
  'react-dom',
  'preact',
  'vue',
  'svelte',
  'solid-js',
  '@angular/core',
  'next/navigation',
  'next/router',
  'client-only',
]);

const SERVER_IMPORTS = new Set([
  'express',
  'fastify',
  'koa',
  'hono',
  'pg',
  'prisma',
  '@prisma/client',
  'typeorm',
  'drizzle-orm',
  'mongoose',
  'ioredis',
  'redis',
  'bullmq',
]);

const PROJECT_MARKERS = ['package.json', 'tsconfig.json', 'jsconfig.json', '.git'];

const cache = new WeakMap<SourceFile, ExecutionContext>();
const packageBinCache = new Map<string, Set<string>>();
const packageRootCache = new Map<string, string | undefined>();

function relativePathInProject(fileName: string): string {
  const resolved = path.resolve(fileName);
  const root = findPackageRoot(path.dirname(resolved));
  const rel = root ? path.relative(root, resolved) : path.basename(resolved);
  return normalizeSlashes(rel);
}

function findPackageRoot(directory: string): string | undefined {
  if (packageRootCache.has(directory)) return packageRootCache.get(directory);
  let root: string | undefined;
  if (PROJECT_MARKERS.some((marker) => safeExists(path.join(directory, marker)))) {
    root = directory;
  } else if (!isTempRoot(directory)) {
    const parent = path.dirname(directory);
    if (parent !== directory) root = findPackageRoot(parent);
  }
  packageRootCache.set(directory, root);
  return root;
}

function binTargetsForRoot(root: string): Set<string> {
  const cached = packageBinCache.get(root);
  if (cached) return cached;
  const targets = new Set<string>();
  const manifestPath = path.join(root, 'package.json');
  try {
    if (fs.existsSync(manifestPath)) {
      const parsed: { bin?: string | Record<string, string> } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const raw = typeof parsed.bin === 'string' ? [parsed.bin] : parsed.bin ? Object.values(parsed.bin) : [];
      for (const entry of raw) {
        if (typeof entry === 'string') targets.add(path.resolve(root, entry));
      }
    }
  } catch {
    // Ignore unreadable or malformed package.json files.
  }
  packageBinCache.set(root, targets);
  return targets;
}

function isPackageBinEntry(fileName: string): boolean {
  const resolved = path.resolve(fileName);
  const root = findPackageRoot(path.dirname(resolved));
  if (!root) return false;
  const bins = binTargetsForRoot(root);
  if (bins.has(resolved)) return true;
  // Compiled .js bin entries correspond to .ts sources in the same location.
  const asJs = resolved.replace(/\.ts$/i, '.js');
  return asJs !== resolved && bins.has(asJs);
}

function importSpecifiers(sourceFile: SourceFile): string[] {
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      !statement.importClause?.isTypeOnly &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  return specifiers;
}

function normalizeSlashes(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function hasUseClientDirective(sourceFile: SourceFile): boolean {
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
    if (statement.expression.text === 'use client') return true;
  }
  return false;
}

function hasDomOnlyTsconfig(program?: Pick<ProgramAdapter, 'getCompilerOptions'>): boolean {
  if (!program) return false;
  const options = program.getCompilerOptions();
  const libs = Array.isArray(options.lib) ? options.lib.map((entry) => String(entry).toLowerCase()) : [];
  const hasDomLib = libs.some((entry) => entry === 'dom' || entry.startsWith('dom.') || entry.includes('lib.dom'));
  if (!hasDomLib) return false;
  const types = Array.isArray(options.types) ? options.types.map((entry) => String(entry).toLowerCase()) : [];
  return !types.includes('node');
}

/**
 * Classifies a TypeScript/JavaScript source file into its primary execution runtime so rules across
 * all pillars can demote or skip findings that do not apply to that environment.
 */
export function classifyExecutionContext(
  sourceFile: SourceFile,
  program?: Pick<ProgramAdapter, 'getCompilerOptions'>,
): ExecutionContext {
  const existing = cache.get(sourceFile);
  if (existing) return existing;

  const normalized = normalizeSlashes(sourceFile.fileName);
  const relative = relativePathInProject(sourceFile.fileName);
  const baseName = path.posix.basename(normalized);
  const reasons: string[] = [];

  if (TEST_FILE_PATTERN.test(baseName) || TEST_PATH_PATTERN.test(relative)) {
    reasons.push('test-fixture path or filename');
    const result: ExecutionContext = { runtime: 'test-fixture', reasons };
    cache.set(sourceFile, result);
    return result;
  }

  if (sourceFile.text.startsWith('#!') && /\bnode\b/.test(sourceFile.text.split(/\r?\n/, 1)[0])) {
    reasons.push('node shebang');
  }
  if (isPackageBinEntry(sourceFile.fileName)) {
    reasons.push('package.json bin entry');
  }
  if (CLI_TOOLING_PATH_PATTERN.test(relative)) {
    reasons.push('cli/tooling path');
  }
  if (reasons.length > 0) {
    const result: ExecutionContext = { runtime: 'cli-tooling', reasons };
    cache.set(sourceFile, result);
    return result;
  }

  const imports = importSpecifiers(sourceFile);

  if (/\.[jt]sx$/i.test(normalized)) reasons.push('.tsx/.jsx extension');
  if (hasUseClientDirective(sourceFile)) reasons.push("'use client' directive");
  if (imports.some((spec) => UI_FRAMEWORK_IMPORTS.has(spec))) reasons.push('UI framework import');
  if (BROWSER_PATH_PATTERN.test(relative)) reasons.push('browser path');
  if (hasDomOnlyTsconfig(program)) reasons.push('DOM-only tsconfig lib');

  if (reasons.length > 0) {
    const result: ExecutionContext = { runtime: 'browser', reasons };
    cache.set(sourceFile, result);
    return result;
  }

  if (imports.some((spec) => spec.startsWith('node:') || SERVER_IMPORTS.has(spec) || spec.startsWith('@nestjs/'))) {
    reasons.push('node/server import');
    const result: ExecutionContext = { runtime: 'node-server', reasons };
    cache.set(sourceFile, result);
    return result;
  }

  const result: ExecutionContext = { runtime: 'unknown', reasons: [] };
  cache.set(sourceFile, result);
  return result;
}

export { hasUseClientDirective };
