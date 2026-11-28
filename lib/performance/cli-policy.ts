import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../shared/config.js';
import type { SourceCheckValues } from './types/source-check-values.js';
import type { ScanSettings } from './types/source-scan-values.js';
import { resolveConfig } from './source-inputs.js';
import { validateQueryPolicy, loadQueryPolicy } from './query-policy.js';
import {
  configlessSources,
  discoverWorkspaces,
  projectConfig,
  selectWorkspaces,
  uncheckedWorkspaces,
} from '../shared/workspaces.js';
import { errorMessage } from './cli-arguments.js';
import type { PolicySource, WorkspaceTarget } from './cli-types.js';

// The folder holding loadwise.config.json: the project, or the working directory for files.
export function projectDirectory(config: string | undefined, files: readonly string[]): string {
  return files.length ? process.cwd() : path.dirname(resolveConfig(config ?? '.'));
}

// The "performance" section of loadwise.config.json holds the query policy.
function configPolicySource(filename: string): PolicySource {
  return {
    filename,
    read() {
      try {
        return validateQueryPolicy(loadConfig({ directory: process.cwd(), explicit: filename })?.config.performance);
      } catch (error) {
        throw new Error('Cannot load the "performance" section of ' + filename + ': ' + errorMessage(error));
      }
    },
  };
}

// The explicit --policy file wins, then the "performance" section of loadwise.config.json.
export function sourcePolicy(explicit: string | undefined, settings: ScanSettings): PolicySource {
  if (explicit === undefined && settings.performance && settings.filename !== undefined) {
    return configPolicySource(settings.filename);
  }
  const filename = explicit === undefined ? undefined : path.resolve(explicit);
  return {
    filename,
    read() {
      if (filename === undefined) return;
      try {
        return loadQueryPolicy(filename);
      } catch (error) {
        throw new Error('Cannot load query policy ' + filename + ': ' + errorMessage(error));
      }
    },
  };
}

function noteUncheckedWorkspaces(withoutConfig: Parameters<typeof uncheckedWorkspaces>[0]): void {
  for (const { name } of uncheckedWorkspaces(withoutConfig)) {
    console.error(
      `Note: workspace ${name} has no tsconfig.json or jsconfig.json, and a sub-folder's own tsconfig.json or jsconfig.json holds its sources; skipped it. Add a tsconfig.json to the package to check it.`,
    );
  }
}

// A directory without its own config, or an explicit --workspace, means a monorepo: one config per
// package, and the sources of each package without one, checked with the standalone defaults.
export function workspaceTarget(
  values: Pick<SourceCheckValues, 'project' | 'workspace'>,
  positionals: readonly string[],
): WorkspaceTarget | undefined {
  const directory = path.resolve(values.project ?? '.');
  const isDirectory = fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory();
  if (positionals.length || !isDirectory) {
    if (values.workspace.length) throw new Error('--workspace needs a monorepo directory.');
    return undefined;
  }
  if (!values.workspace.length && projectConfig(directory)) return undefined;
  const { packages, withoutConfig } = discoverWorkspaces(directory);
  const configless = withoutConfig.flatMap((workspace) => {
    const sources = configlessSources(workspace.directory);
    return sources ? [{ ...workspace, sources }] : [];
  });
  noteUncheckedWorkspaces(withoutConfig);
  if (!packages.length && !configless.length) {
    if (values.workspace.length)
      throw new Error('--workspace found no workspace package with JavaScript or TypeScript.');
    return undefined;
  }
  const chosen = selectWorkspaces([...packages, ...configless], directory, values.workspace);
  return {
    directory,
    configs: chosen.flatMap((workspace) => ('config' in workspace ? [workspace.config] : [])),
    standaloneFiles: chosen.flatMap((workspace) => ('sources' in workspace ? workspace.sources : [])),
    packages: chosen.map(({ name, directory: packageDirectory }) => ({
      name,
      directory: relativeToCwd(packageDirectory),
    })),
  };
}

export function relativeToCwd(target: string): string {
  return path.relative(process.cwd(), target).split(path.sep).join('/') || '.';
}
