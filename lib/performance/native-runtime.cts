// @ts-check
import path from 'node:path';
import { createRequire } from 'node:module';

import type { NativeModules, PackageManifest } from './types/native-modules.cjs';

// Resolve the upstream package's own exports from its vendored location. Its
// executable stays in the official optional package for this OS and CPU.
const nativeRequire = createRequire(path.join(__dirname, 'vendor/typescript/package.json'));

// Known ids return their module type; other ids take the shape the caller declares.
function requireNative<Id extends keyof NativeModules>(id: Id): NativeModules[Id];
function requireNative<Module>(id: string): Module;
function requireNative(id: string): unknown {
  return nativeRequire(id);
}

function executable(): string {
  try {
    const filename = requireNative('./lib/getExePath.js').default();
    const binaryPackage: PackageManifest = require(path.resolve(path.dirname(filename), '../package.json'));
    const expected = requireNative('./package.json').version;
    if (binaryPackage.version !== expected)
      throw new Error(`Expected version ${expected}, found ${binaryPackage.version}.`);
    return filename;
  } catch (error) {
    throw new Error(
      '--native requires the official TypeScript binary for this platform. Run npm install --include=optional. ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

export { requireNative, executable };
