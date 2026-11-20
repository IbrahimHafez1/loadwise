# TypeScript native API

The `typescript/` directory contains the JavaScript bindings used by the native analyzer. The source is Microsoft’s [typescript 7.1.0-beta npm distribution](https://www.npmjs.com/package/typescript/v/7.1.0-beta). The files retain their original bytes, Apache 2.0 license and third-party notices. See `typescript/LICENSE`, `typescript/NOTICE.txt` and `typescript/vendor/vscode-jsonrpc/License.txt`.

Keeping the bindings here lets npm install the platform binary without registering a second `tsc` command in the consuming project. The top-level optional dependencies mirror the exact version and OS/CPU packages declared in the upstream manifest. npm selects the matching package. Installing with `--omit=optional` leaves the stable checker available. The `--native` command reports the missing binary.

To reproduce the binding snapshot, unpack the official `npm pack typescript@7.1.0-beta` archive into a temporary directory. From this source repository with dependencies installed, run `node scripts/vendor-native.cjs <path-to-unpacked-package>`. The script follows the five public entry points used by the scanner and its test fixtures, then copies their runtime imports and notices.
