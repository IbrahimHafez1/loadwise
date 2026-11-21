'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const { checkSizeLimits } = require('../../lib/maintainability/size-limits.cjs');
const { buildFix, createFileCache } = require('../../lib/maintainability/site-fix.cjs');
const { applyFix } = require('../../lib/maintainability/apply-fix.cjs');

const signature = 'const draw = (a: number, b: number, c: number, d: number, e: number, scale = 1) =>';
const source = [
  'export function render() {',
  '  const log: number[] = [];',
  '  const step = (n: number) => (log.push(n), n);',
  '  ' + signature,
  '    [a, b, c, d, e].map(value => value * scale);',
  '  return [draw(step(1), step(2), step(3), step(4), step(5)), draw(1, 2, 3, 4, 5, step(6)), log];',
  '}',
].join('\n');

function fixes(text, filename = 'render.ts') {
  const sourceFile = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const entry = {
    text,
    sourceFile,
    absolute: filename,
    filename,
    lineStarts: sourceFile.getLineStarts(),
    scriptKind: sourceFile.scriptKind,
  };
  return checkSizeLimits(sourceFile, filename)
    .filter((finding) => finding.ruleId === 'long-parameter-list')
    .map((finding) => buildFix(finding, () => entry));
}

function evaluate(text) {
  const exports = {};
  const compiled = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  new Function('exports', compiled.outputText)(exports);
  return exports.render();
}

test('private methods require direct, resolved calls and preserve optional arguments and defaults', (context) => {
  const base = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'AI-Work') : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'loadwise-parameter-scope-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"private":true}');
  const filename = 'render.ts';
  const source = [
    'export class Drawing {',
    '  private line(a: number, b: number, c: number, d?: number, e?: number, scale = 2) {',
    '    return [a, b, c, d, e, scale];',
    '  }',
    '  render() { return [this.line(1, 2, 3, undefined), this.line(2, 3, 4, 5, 6, 7)]; }',
    '}',
    'export const render = () => new Drawing().render();',
  ].join('\n');
  function methodFix(text) {
    fs.writeFileSync(path.join(root, filename), text);
    const load = createFileCache(root);
    const [finding] = checkSizeLimits(load(filename).sourceFile, filename);
    return buildFix(finding, load);
  }
  for (const text of [source, source.replace('private line', '#line').replaceAll('this.line', 'this.#line')]) {
    const fix = methodFix(text);
    assert.ok(fix);
    assert.equal(Boolean(fix.requiresReview), text === source);
    let after;
    applyFix(fix, {
      readFile: () => text,
      writeFile: (_, value) => {
        after = value;
      },
    });
    assert.deepEqual(evaluate(after), evaluate(text));
    assert.deepEqual(fixes(after), []);
  }
  for (const changed of [
    source.replace('private line', 'public line'),
    source.replace('return [a, b', 'return [arguments.length, a, b'),
    source.replace('return [this.line', 'observe(this.line); return [this.line'),
    source.replace('return [this.line', 'this[key](); return [this.line'),
    source.replace('return [this.line', "return [this['line']"),
  ])
    assert.equal(methodFix(changed), undefined);
  fs.writeFileSync(path.join(root, 'consumer.ts'), "import {Drawing} from './render'; new Drawing()['line'](1,2,3,4);");
  assert.equal(methodFix(source), undefined);
});

test('names required arguments at every local call, preserves defaults, evaluation order and returned values', () => {
  const [fix] = fixes(source);
  assert.ok(fix);
  let after;
  const result = applyFix(fix, {
    readFile: () => source,
    writeFile: (_file, text) => {
      after = text;
    },
  });
  assert.equal(result.error, undefined);
  assert.match(after, /draw\(\{ a: step\(1\)/);
  assert.deepEqual(evaluate(after), evaluate(source));
  assert.deepEqual(fixes(after), []);
});

test('leaves a public or escaped helper, dynamic calls and ambiguous arguments alone', () => {
  for (const changed of [
    source.replace('return [draw', 'observe(draw); return [draw'),
    source.replace('return [draw', 'eval("draw"); return [draw'),
    source.replace('return [draw', 'const arity = draw.length; return [draw'),
    source.replace('draw(step(1)', 'draw(...values'),
    source.replace('draw(step(1)', 'draw(() => 1'),
    source.replace('draw(step(1)', 'draw(/* preserve */step(1)').replace('step(2)', 'step(2) /* note */'),
    source.replace('a: number', '__proto__: number'),
    source.replace('b: number', 'b: typeof a'),
    source.replace(signature, signature.replace('const draw =', 'const draw: Callable =')),
    'export ' + signature + ' a;',
  ])
    assert.deepEqual(fixes(changed), [undefined]);
});

const drawingModule = [
  "'use strict';",
  'const log = [];',
  'const step = (n) => (log.push(n), n);',
  'function draw(callback, { width }, height, depth, opacity, scale = 2) {',
  '  if (width === 0) return [callback.name, height, depth, opacity, scale];',
  '  return draw(callback, { width: 0 }, height, depth, opacity, scale);',
  '}',
  'exports.render = () => [draw(() => 1, { width: step(1) }, step(2), step(3), step(4)), log];',
].join('\n');

test('groups private CommonJS arguments at direct and recursive calls while preserving defaults and evaluation order', () => {
  const [fix] = fixes(drawingModule, 'drawing.cjs');
  assert.ok(fix);
  assert.ok(!fix.requiresReview);
  let rewritten;
  applyFix(fix, {
    readFile: () => drawingModule,
    writeFile: (_file, text) => {
      rewritten = text;
    },
  });
  assert.match(rewritten, /draw\(callback, \{ width \}, \{ height, depth, opacity \}, scale = 2\)/);
  assert.deepEqual(evaluate(rewritten), evaluate(drawingModule));
  assert.deepEqual(fixes(rewritten, 'drawing.cjs'), []);
});

test('preserves JavaScript signatures exposed to outside callers, reflection, JSDoc or dynamic lookup', () => {
  for (const changed of [
    drawingModule + '\nexports.draw = draw;',
    drawingModule + '\nconst alias = draw;',
    drawingModule + '\nvoid draw.length;',
    drawingModule + '\nvoid eval("draw");',
    drawingModule.replace('if (width', 'void arguments.length; if (width'),
    drawingModule.replace('function draw', '/** @param {Function} callback */\nfunction draw'),
    drawingModule.replace(
      '}, height, depth, opacity, scale = 2)',
      '}, /** @type {number} */ height, depth, opacity, scale = 2)',
    ),
    drawingModule.replace("'use strict';", ''),
    drawingModule.replace('draw(() => 1, { width: step(1) }', 'draw(...values, { width: step(1) }'),
  ])
    assert.deepEqual(fixes(changed, 'drawing.cjs'), [undefined]);
  assert.deepEqual(fixes(drawingModule, 'browser-script.js'), [undefined]);
  const simple = 'function draw(a, b, c, d, e, f) { "use strict"; return a; }\ndraw(1, 2, 3, 4, 5, 6);';
  assert.deepEqual(fixes("'use strict';\n" + simple, 'drawing.cjs'), [undefined]);
});
