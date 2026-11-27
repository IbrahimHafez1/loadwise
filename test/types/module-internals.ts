/** The private `Module._load` hook some tests patch to stand in for a required module. */
export interface ModuleLoadHook {
  _load(this: unknown, request: string, ...rest: unknown[]): unknown;
}
