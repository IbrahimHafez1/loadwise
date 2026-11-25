import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { isWithin } from '../shared/workspaces.js';
import type { CompilerOptions } from 'typescript';

const configNames = ['tsconfig.json', 'jsconfig.json'];
const aliasOptionNames = ['paths', 'pathsBasePath', 'baseUrl'] as const;

function aliasOptionsOf(config: string, directory: string): CompilerOptions | undefined {
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} };
  const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, host);
  if (!parsed?.options.paths) return;
  const coversDirectory = parsed.fileNames.some((file) => isWithin(directory, file));
  if (!coversDirectory) return;
  return Object.fromEntries(aliasOptionNames.map((name) => [name, parsed.options[name]]));
}

// The path aliases of the nearest ancestor config above the scanned folder that covers files under
// it, such as a repository tsconfig whose `paths` the scanned subfolder's own config does not
// repeat. The search ends at the repository root, where `.git` lives.
function ancestorAliasOptions(directory: string): CompilerOptions | undefined {
  let current = path.resolve(directory);
  while (!fs.existsSync(path.join(current, '.git'))) {
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
    const config = configNames
      .map((name) => path.join(current, name))
      .find((candidate) => ts.sys.fileExists(candidate));
    const aliases = config && aliasOptionsOf(config, directory);
    if (aliases) return aliases;
  }
}

export { ancestorAliasOptions };
