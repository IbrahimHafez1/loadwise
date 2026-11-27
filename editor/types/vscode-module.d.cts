// The `vscode` module exists only inside the editor host, so its shape is the subset of the API
// this package uses. tsconfig.json maps the module name to this file for type checking.
import type { EditorApi } from './vscode-api.cjs';

declare const vscode: EditorApi;
export = vscode;
