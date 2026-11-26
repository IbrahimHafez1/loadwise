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
const TEST_PATH_PATTERN =
  /(?:^|\/)(?:e2e|tests?|__tests__|integration-tests?|[\w-]*test-utils|sandbox|fixtures?|__fixtures__|__mocks__|__stories__|stories|[\w-]*evals?|evaluations?|playwright|quality\/(?:testing|environments))\//i;

const CLI_TOOLING_PATH_PATTERN =
  /(?:^|\/)(?:tools?|scripts?|codemods?|release-notes[^/]*|bundler|startup)\/|(?:^|\/)(?:src|cli)\/commands?\//i;
const CREATE_PACKAGE_PATTERN = /^(?:packages\/(?:@[^/]+\/)?)?create-[\w-]+\//i;

const BROWSER_PATH_PATTERN =
  /(?:^|\/)(?:client-only|frontend|components|hooks|composables|views|apps\/(?:admin|dashboard)[^/]*)\//i;
const SERVER_ROUTE_PATTERN = /(?:^|\/)(?:app\/.*\/route|pages\/api\/.*)\.[cm]?[jt]s$/i;
const VENDORED_MINIFIED_PATTERN = /(?:^|\/)vendor\/|[.-]min\.[cm]?js$/i;

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

const SERVER_PACKAGE_DEPS =
  /^(?:express|fastify|koa|hono|@nestjs\/|next|pg|prisma|@prisma\/|typeorm|drizzle-orm|mongoose|sequelize|@mikro-orm\/|@trpc\/server)$/;
const UI_PACKAGE_DEPS = /^(?:react|react-dom|vue|svelte|preact|solid-js|@angular\/core)$/;

const PROJECT_MARKERS = ['package.json', 'tsconfig.json', 'jsconfig.json', '.git'];

interface PackageProfile {
  bins: Set<string>;
  hasBin: boolean;
  hasServerDeps: boolean;
  hasUiDeps: boolean;
}

const cache = new WeakMap<SourceFile, ExecutionContext>();
const packageProfileCache = new Map<string, PackageProfile>();
const packageRootCache = new Map<string, string | undefined>();
const workspaceSubpackageCache = new Map<string, boolean>();

function hasAncestorPackageJson(directory: string): boolean {
  if (workspaceSubpackageCache.has(directory)) return workspaceSubpackageCache.get(directory) === true;
  let found = false;
  let current = path.dirname(directory);
  while (current !== directory && !isTempRoot(current)) {
    if (safeExists(path.join(current, 'package.json'))) {
      found = true;
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  workspaceSubpackageCache.set(directory, found);
  return found;
}

function relativePathInProject(fileName: string): string {
  const resolved = path.resolve(fileName);
  const root = findPackageRoot(path.dirname(resolved));
  const rel = root ? path.relative(root, resolved) : path.basename(resolved);
  return normalizeSlashes(rel);
}

// Inside a monorepo workspace subpackage (a package with a workspace package.json above it),
// prepend the package directory name (and `quality/` if directly under `quality/`) so workspace
// package roles like `medusa-test-utils`, `agent-evals`, `tests`, `sandbox`, `playwright`,
// `quality/environments`, and `release-notes-generator` stay visible without leaking an unrelated
// ancestor directory onto standalone projects.
function workspaceScopedPath(fileName: string): string {
  const resolved = path.resolve(fileName);
  const root = findPackageRoot(path.dirname(resolved));
  if (!root) return normalizeSlashes(path.basename(resolved));
  const rel = normalizeSlashes(path.relative(root, resolved));
  if (!hasAncestorPackageJson(root)) return rel;
  const pkgName = path.basename(root);
  const parentName = path.basename(path.dirname(root));
  if (parentName.toLowerCase() === 'quality') return `${parentName}/${pkgName}/${rel}`;
  return `${pkgName}/${rel}`;
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

function packageProfileForRoot(root: string): PackageProfile {
  const cached = packageProfileCache.get(root);
  if (cached) return cached;
  const bins = new Set<string>();
  let hasServerDeps = false;
  let hasUiDeps = false;
  const manifestPath = path.join(root, 'package.json');
  try {
    if (safeExists(manifestPath)) {
      const parsed: {
        bin?: string | Record<string, string>;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const raw = typeof parsed.bin === 'string' ? [parsed.bin] : parsed.bin ? Object.values(parsed.bin) : [];
      for (const entry of raw) {
        if (typeof entry === 'string') bins.add(path.resolve(root, entry));
      }
      const depNames = [...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.peerDependencies ?? {})];
      hasServerDeps = depNames.some((dep) => SERVER_PACKAGE_DEPS.test(dep));
      hasUiDeps = depNames.some((dep) => UI_PACKAGE_DEPS.test(dep));
    }
  } catch {
    // Ignore unreadable or malformed package.json files.
  }
  const profile: PackageProfile = { bins, hasBin: bins.size > 0, hasServerDeps, hasUiDeps };
  packageProfileCache.set(root, profile);
  return profile;
}

function isPackageBinEntry(fileName: string, profile: PackageProfile | undefined): boolean {
  if (!profile || !profile.hasBin) return false;
  const resolved = path.resolve(fileName);
  if (profile.bins.has(resolved)) return true;
  // Compiled .js bin entries correspond to .ts sources in the same location.
  const asJs = resolved.replace(/\.ts$/i, '.js');
  return asJs !== resolved && profile.bins.has(asJs);
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

function hasDomOnlyTsconfig(
  program: Pick<ProgramAdapter, 'getCompilerOptions'> | undefined,
  profile: PackageProfile | undefined,
): boolean {
  if (!program || profile?.hasServerDeps) return false;
  const options = program.getCompilerOptions();
  const libs = Array.isArray(options.lib) ? options.lib.map((entry) => String(entry).toLowerCase()) : [];
  const hasDomLib = libs.some((entry) => entry === 'dom' || entry.startsWith('dom.') || entry.includes('lib.dom'));
  if (!hasDomLib) return false;
  // Node module/resolution targets run on Node even when `dom` is included for global fetch/URL.
  const moduleKind = options.module;
  const moduleResolution = options.moduleResolution;
  if (
    moduleKind === (ts.ModuleKind?.CommonJS ?? 1) ||
    moduleKind === (ts.ModuleKind?.Node16 ?? 100) ||
    moduleKind === (ts.ModuleKind?.NodeNext ?? 199) ||
    moduleResolution === (ts.ModuleResolutionKind?.Node10 ?? 2) ||
    moduleResolution === (ts.ModuleResolutionKind?.Node16 ?? 3) ||
    moduleResolution === (ts.ModuleResolutionKind?.NodeNext ?? 99)
  ) {
    return false;
  }
  // Omitted `types` lets TypeScript auto-include @types/node; only an explicit types list excluding
  // `node` (and not merely a test-runner global like vitest/globals) indicates a DOM-only project.
  if (!Array.isArray(options.types) || options.types.length === 0) return false;
  const types = options.types.map((entry) => String(entry).toLowerCase());
  return !types.includes('node') && !types.some((entry) => entry.includes('vitest') || entry.includes('jest'));
}

function isVendoredMinified(fileName: string): boolean {
  const normalized = normalizeSlashes(fileName);
  return VENDORED_MINIFIED_PATTERN.test(normalized);
}

function classifyTestOrCli(
  sourceFile: SourceFile,
  relative: string,
  scoped: string,
  profile: PackageProfile | undefined,
): ExecutionContext | undefined {
  const normalized = normalizeSlashes(sourceFile.fileName);
  const baseName = path.posix.basename(normalized);
  if (
    TEST_FILE_PATTERN.test(baseName) ||
    TEST_PATH_PATTERN.test(relative) ||
    TEST_PATH_PATTERN.test(scoped) ||
    /(?:^|\/)quality\/(?:testing|environments)\//i.test(normalized)
  ) {
    return { runtime: 'test-fixture', reasons: ['test-fixture path or filename'] };
  }
  const reasons: string[] = [];
  if (sourceFile.text.startsWith('#!') && /\bnode\b/.test(sourceFile.text.split(/\r?\n/, 1)[0])) {
    reasons.push('node shebang');
  }
  if (isPackageBinEntry(sourceFile.fileName, profile)) reasons.push('package.json bin entry');
  if (profile?.hasBin && !profile.hasServerDeps) reasons.push('CLI-only package manifest');
  if (
    CLI_TOOLING_PATH_PATTERN.test(relative) ||
    CLI_TOOLING_PATH_PATTERN.test(scoped) ||
    CREATE_PACKAGE_PATTERN.test(scoped)
  ) {
    reasons.push('cli/tooling path');
  }
  return reasons.length > 0 ? { runtime: 'cli-tooling', reasons } : undefined;
}

function classifyBrowserOrServer(
  sourceFile: SourceFile,
  relative: string,
  scoped: string,
  profile: PackageProfile | undefined,
  program: Pick<ProgramAdapter, 'getCompilerOptions'> | undefined,
): ExecutionContext {
  const normalized = normalizeSlashes(sourceFile.fileName);
  const imports = importSpecifiers(sourceFile);
  if (SERVER_ROUTE_PATTERN.test(relative) || SERVER_ROUTE_PATTERN.test(scoped)) {
    return { runtime: 'node-server', reasons: ['server route handler file'] };
  }
  const reasons: string[] = [];
  if (/\.[jt]sx$/i.test(normalized)) reasons.push('.tsx/.jsx extension');
  if (hasUseClientDirective(sourceFile)) reasons.push("'use client' directive");
  if (imports.some((spec) => UI_FRAMEWORK_IMPORTS.has(spec))) reasons.push('UI framework import');
  if (BROWSER_PATH_PATTERN.test(relative) || BROWSER_PATH_PATTERN.test(scoped)) reasons.push('browser path');
  if (profile?.hasUiDeps && !profile.hasServerDeps && !profile.hasBin) reasons.push('browser-only package manifest');
  if (reasons.length > 0) return { runtime: 'browser', reasons };
  if (imports.some((spec) => spec.startsWith('node:') || SERVER_IMPORTS.has(spec) || spec.startsWith('@nestjs/'))) {
    return { runtime: 'node-server', reasons: ['node/server import'] };
  }
  if (hasDomOnlyTsconfig(program, profile)) return { runtime: 'browser', reasons: ['DOM-only tsconfig lib'] };
  return { runtime: 'unknown', reasons: [] };
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
  const relative = relativePathInProject(sourceFile.fileName);
  const scoped = workspaceScopedPath(sourceFile.fileName);
  const pkgRoot = findPackageRoot(path.dirname(path.resolve(sourceFile.fileName)));
  const profile = pkgRoot ? packageProfileForRoot(pkgRoot) : undefined;
  const result =
    classifyTestOrCli(sourceFile, relative, scoped, profile) ??
    classifyBrowserOrServer(sourceFile, relative, scoped, profile, program);
  cache.set(sourceFile, result);
  return result;
}

export { hasUseClientDirective, isVendoredMinified, workspaceScopedPath };
