// Builds the declaration lines of an eager or lazy Set/Map lookup for the membership and find fixes.
import { freshName } from './helpers.cjs';
import type { SourceFile } from 'typescript';
import type { Placement } from '../types/lookup-placement.cjs';
import type { LookupConstruction } from '../types/lookup-construction.cjs';
import { typeScriptFile, arrayCopyIndent, mentionsName, capitalize } from './collection-helpers.cjs';

const maxLineLength = 100;

// `head` followed by `open array.calls() close;`, such as `const idsSet = new Set(ids);`. It stays
// on one line when that fits, otherwise the argument moves to its own line, and its chained calls
// one per line when still too long.
function constructionLines(
  indentation: string,
  head: string,
  { open, array, calls, close }: LookupConstruction,
): string[] {
  const width = (line: string): number => indentation.replaceAll('	', '    ').length + line.length;
  const oneLine = `${head}${open}${array}${calls.join('')}${close};`;
  if (width(oneLine) <= maxLineLength) return [oneLine];
  const unit = indentation.includes('\t') ? '\t' : arrayCopyIndent;
  const argument = `${unit}${array}${calls.join('')},`;
  const body =
    width(argument) <= maxLineLength || calls.length === 0
      ? [argument]
      : [
          `${unit}${array}`,
          ...calls.map((call, index) => unit + unit + call + (index === calls.length - 1 ? ',' : '')),
        ];
  return [`${head}${open}`, ...body, `${close};`];
}

// An eager lookup is a plain `const` built right before the iteration. A lazy one is declared there
// but built on the first lookup, for when building early could throw, run a getter, or see the
// array before code in the iteration changes it.
export function lookupDeclarations(
  sourceFile: SourceFile,
  name: string,
  placement: Placement,
  construction: LookupConstruction,
  eager: boolean,
): LookupDeclarations | undefined {
  if (eager) {
    return { declarations: constructionLines(placement.indentation, `const ${name} = `, construction), access: name };
  }
  const factory = freshName(sourceFile, 'build' + capitalize(name));
  if (!factory) return;
  let returnType = 'ReturnType';
  if (mentionsName(sourceFile, returnType)) {
    if (mentionsName(sourceFile, 'globalThis')) return;
    returnType = 'globalThis.ReturnType';
  }
  const type = `${returnType}<typeof ${factory}>`;
  const declaration = typeScriptFile.test(sourceFile.fileName)
    ? `let ${name}: ${type};`
    : `/** @type {${type}} */ let ${name};`;
  return {
    declarations: [...constructionLines(placement.indentation, `const ${factory} = () => `, construction), declaration],
    access: `(${name} ??= ${factory}())`,
  };
}

interface LookupDeclarations {
  declarations: string[];
  access: string;
}
