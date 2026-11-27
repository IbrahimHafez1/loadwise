import type {
  NativeAst,
  NativeAstUtils,
  NativeBinding,
  NativeFileSystemModule,
  NativeFlags,
  NativeGuards,
  NativeProtocol,
} from './native-typescript.js';

export interface PackageManifest {
  version: string;
}

export interface ExecutablePathModule {
  default(): string;
}

/** The vendored native compiler modules `requireNative` loads, by the id they are required with. */
export interface NativeModules {
  'typescript/ast': NativeAst;
  'typescript/ast/is': NativeGuards;
  'typescript/ast/utils': NativeAstUtils;
  'typescript/fs': NativeFileSystemModule;
  'typescript/sync': NativeBinding & NativeFlags;
  './dist/api/node/protocol.js': NativeProtocol;
  './lib/getExePath.js': ExecutablePathModule;
  './package.json': PackageManifest;
}
