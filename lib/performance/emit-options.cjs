'use strict';

// Loadwise never emits, so these options only add emit-time checks (a file outside `rootDir`, declaration
// output without `declaration`, ...) that would stop a scan. None of them changes the types the rules read.
const emitOnlyOptions = [
  'rootDir',
  'outDir',
  'outFile',
  'declaration',
  'declarationDir',
  'declarationMap',
  'emitDeclarationOnly',
  'isolatedDeclarations',
  'composite',
  'incremental',
  'tsBuildInfoFile',
  'sourceMap',
  'inlineSourceMap',
  'inlineSources',
  'sourceRoot',
  'mapRoot',
  'noEmitOnError',
];

function withoutEmitOptions(options) {
  const result = { ...options };
  for (const name of emitOnlyOptions) delete result[name];
  return result;
}

module.exports = { withoutEmitOptions };
