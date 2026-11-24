import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../shared/config.cjs';
import type { SourceCheckValues } from './types/source-check-values.cjs';
import type { ScanSettings } from './types/source-scan-values.cjs';
import { resolveConfig } from './source-inputs.cjs';
import { validateQueryPolicy, loadQueryPolicy } from './query-policy.cjs';
import { discoverWorkspaces, projectConfig, selectWorkspaces } from '../shared/workspaces.cjs';
import { errorCode, errorMessage } from './cli-arguments.cjs';
import type { PolicySource, WorkspaceTarget } from './cli-types.cjs';

// The folder holding backend-perf.policy.json and loadwise.config.json: the project, or the working
// directory for files.
export function projectDirectory(config: string | undefined, files: readonly string[]): string {
  return files.length ? process.cwd() : path.dirname(resolveConfig(config ?? '.'));
}

// The "performance" section of loadwise.config.json holds the same policy as
// backend-perf.policy.json.
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

export function sourcePolicy(explicit: string | undefined, directory: string, settings: ScanSettings): PolicySource {
  const filename = explicit !== undefined ? path.resolve(explicit) : path.join(directory, 'backend-perf.policy.json');
  if (explicit === undefined && settings.performance && settings.filename !== undefined) {
    if (fs.existsSync(filename)) {
      console.error(`Note: ${settings.filename} has a "performance" section; ignoring ${filename}.`);
    }
    return configPolicySource(settings.filename);
  }
  let required = explicit !== undefined;
  return {
    filename,
    read() {
      try {
        const policy = loadQueryPolicy(filename);
        required = true;
        return policy;
      } catch (error) {
        if (errorCode(error) === 'ENOENT' && !required) return;
        // Once discovered, a broken or removed policy must not silently disable enforcement in
        // watch mode.
        required = true;
        throw new Error('Cannot load query policy ' + filename + ': ' + errorMessage(error));
      }
    },
  };
}

// A directory without its own config, or an explicit --workspace, means a monorepo: one config per
// package.
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
  if (!packages.length) {
    if (values.workspace.length)
      throw new Error('--workspace found no workspace package with a tsconfig.json or jsconfig.json.');
    return undefined;
  }
  for (const { name } of withoutConfig) {
    console.error(`Note: workspace ${name} has no tsconfig.json or jsconfig.json; skipped it.`);
  }
  const chosen = selectWorkspaces(packages, directory, values.workspace);
  return {
    directory,
    configs: chosen.map(({ config }) => config),
    packages: chosen.map(({ name, directory: packageDirectory }) => ({
      name,
      directory: relativeToCwd(packageDirectory),
    })),
  };
}

export function relativeToCwd(target: string): string {
  return path.relative(process.cwd(), target).split(path.sep).join('/') || '.';
}
