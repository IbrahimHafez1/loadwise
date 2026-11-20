const path = require('node:path');
const ts = require('typescript');

function withProgram(source, files, callback) {
  const root = path.resolve(__dirname, 'virtual-project');
  const mainPath = path.join(root, 'main.ts');
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    allowJs: true,
    skipLibCheck: true,
    types: [],
    lib: ['lib.es2022.d.ts'],
  };
  const entries = Object.entries({ 'main.ts': source, ...files });
  const normalize = (name) => path.normalize(path.resolve(name));
  const overlay = new Map(entries.map(([name, content]) => [normalize(path.join(root, name)), content]));
  const directories = new Set();
  for (const filename of overlay.keys()) {
    let dir = path.dirname(filename);
    while (!directories.has(dir) && dir !== path.dirname(dir)) {
      directories.add(dir);
      dir = path.dirname(dir);
    }
  }
  const host = ts.createCompilerHost(options, true);
  const original = { ...host };
  host.readFile = (name) => overlay.get(normalize(name)) ?? original.readFile(name);
  host.fileExists = (name) => overlay.has(normalize(name)) || original.fileExists(name);
  host.directoryExists = (name) => directories.has(normalize(name)) || original.directoryExists(name);
  host.realpath = (name) => (overlay.has(normalize(name)) ? name : original.realpath(name));
  host.getSourceFile = (name, version, ...args) =>
    overlay.has(normalize(name))
      ? ts.createSourceFile(name, host.readFile(name), version, true)
      : original.getSourceFile(name, version, ...args);
  const roots = [...overlay.keys()].filter(
    (name) => !name.includes(path.sep + 'node_modules' + path.sep) && /\.[cm]?[jt]sx?$/.test(name),
  );
  const program = ts.createProgram(roots, options, host);
  return callback(program, program.getSourceFile(mainPath));
}

function lint(source, files = {}, policy) {
  if (process.env.PERF_CHECK_TEST_NATIVE === '1') return require('./native-fixture.cjs').lint(source, files, policy);
  return withProgram(source, files, (program, sourceFile) =>
    require('../lib/analyze.cjs').analyzeFile(program, sourceFile, policy),
  );
}

module.exports = { lint, withProgram };
