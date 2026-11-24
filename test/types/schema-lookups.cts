import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';
import type { Expression, SourceFile, Statement } from 'typescript';
import type { ProgramAdapter } from '../../lib/shared/types.cjs';
import type { SchemaColumn, SchemaIndex, SchemaTable } from '../../lib/performance/types/schema-model.cjs';

// The index of a table the test expects to find; fails with the predicate's table name otherwise.
export function requireIndex(table: SchemaTable, matches: (index: SchemaIndex) => boolean): SchemaIndex {
  const found = table.indexes.find(matches);
  assert.ok(found, `expected ${table.name} to have a matching index`);
  return found;
}

export function requireColumn(table: SchemaTable, name: string): SchemaColumn {
  const found = table.columns.get(name);
  assert.ok(found, `expected ${table.name} to have the column ${name}`);
  return found;
}

export function requireTable(tables: ReadonlyMap<string, SchemaTable>, name: string): SchemaTable {
  const found = tables.get(name);
  assert.ok(found, `expected the table ${name}`);
  return found;
}

// The initializer of `const x = <expression>;` the fixture's main file declares.
export function initializerOf(statement: Statement | undefined): Expression {
  assert.ok(statement && ts.isVariableStatement(statement), 'expected a variable statement');
  const initializer = statement.declarationList.declarations[0]?.initializer;
  assert.ok(initializer, 'expected the declaration to have an initializer');
  return initializer;
}

// The program's file at an absolute path, whatever separators the program uses.
export function sourceFileAt(program: ProgramAdapter, absolutePath: string): SourceFile {
  assert.ok(program.getSourceFiles, 'the program should list its source files');
  const found = program.getSourceFiles().find((file) => path.resolve(file.fileName) === path.resolve(absolutePath));
  assert.ok(found, `expected the program to contain ${absolutePath}`);
  return found;
}

// The value a map holds for a key the test expects to be present.
export function requireEntry<Value>(entries: ReadonlyMap<string, Value>, key: string): Value {
  const found = entries.get(key);
  assert.ok(found, `expected an entry for ${key}`);
  return found;
}
