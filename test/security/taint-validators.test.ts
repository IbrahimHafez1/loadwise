// Runtime validation as a sanitizer: Nest parsing pipes, class-validator DTOs behind
// ValidationPipe, and zod, joi, yup and valibot schemas. Every case is checked with and without the
// installed types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withContext, sinkArgument, localFiles, stubs } from './helpers.js';
import type { SourceFile } from 'typescript';
import type { SecurityRuleContext, SinkKind } from '../../lib/shared/types.js';

// The trace label at sink(), or null when clean; asserts that the run without types traces nothing
// extra.
function tracedLabel(source: string, files: Record<string, string>, sinkKind: SinkKind = 'sql') {
  const labelWith = (programFiles: Record<string, string>) =>
    withContext(
      source,
      programFiles,
      (context: SecurityRuleContext, sourceFile: SourceFile) =>
        context.taint.trace(sinkArgument(sourceFile), sinkKind)?.label ?? null,
    );
  const typed = labelWith(files);
  const untyped = labelWith(localFiles(files));
  assert.ok(untyped === null || untyped === typed, 'traced only without types');
  return typed;
}

const nestFiles = { ...stubs.nest, ...stubs.classValidator };

test('Nest parsing pipes on @Param and @Query sanitize the value', () => {
  const controller = (parameter: string) =>
    [
      "import { Controller, Get, Param, Query, ParseIntPipe, ParseFloatPipe, ParseBoolPipe, ParseUUIDPipe, ParseEnumPipe } from '@nestjs/common';",
      'declare function sink(value: unknown): void;',
      'enum Sort { Asc = "asc" }',
      `@Controller() class Items { @Get() find(${parameter}) { sink(\`\${value}\`); } }`,
    ].join('\n');
  for (const pipe of [
    'ParseIntPipe',
    'ParseFloatPipe',
    'ParseBoolPipe',
    'new ParseUUIDPipe()',
    'new ParseEnumPipe(Sort)',
  ]) {
    assert.equal(tracedLabel(controller(`@Param('id', ${pipe}) value: string`), stubs.nest), null, pipe);
    assert.equal(tracedLabel(controller(`@Query('id', ${pipe}) value: string`), stubs.nest), null, pipe);
  }
  assert.equal(tracedLabel(controller("@Query('id') value: string"), stubs.nest), "@Query('id') value");
});

interface DtoControllerOptions {
  globalPipe?: boolean;
  methodPipe?: boolean;
  dtoName?: string;
  field: string;
  extra?: string;
}

function dtoController({
  globalPipe = true,
  methodPipe = false,
  dtoName = 'CreateDto',
  field,
  extra = '',
}: DtoControllerOptions) {
  return [
    "import { Body, Controller, Post, UsePipes, ValidationPipe } from '@nestjs/common';",
    "import { PartialType } from '@nestjs/mapped-types';",
    "import { IsEmail, IsInt, IsString, IsUUID, Matches, ValidateIf } from 'class-validator';",
    'declare function sink(value: unknown): void;',
    'declare const app: { useGlobalPipes(...pipes: unknown[]): void };',
    globalPipe ? 'app.useGlobalPipes(new ValidationPipe({ whitelist: true }));' : '',
    'class CreateDto {',
    '  @IsInt() count!: string;',
    '  @IsUUID() id!: string;',
    '  @IsString() name!: string;',
    '  @IsEmail() email!: string;',
    '  @Matches(/^[a-z]+$/) slug!: string;',
    '  @ValidateIf((dto: CreateDto) => !!dto.name) @IsUUID() parentId!: string;',
    '}',
    'class UpdateDto extends PartialType(CreateDto) {}',
    extra,
    `@Controller() class Items { ${methodPipe ? '@UsePipes(new ValidationPipe())' : ''} @Post() save(@Body() dto: ${dtoName}) { sink(dto.${field}); } }`,
  ].join('\n');
}

test('class-validator fields are clean only for the sinks their validator closes', () => {
  assert.equal(tracedLabel(dtoController({ field: 'id' }), nestFiles), null);
  assert.equal(tracedLabel(dtoController({ field: 'count' }), nestFiles), null);
  assert.equal(tracedLabel(dtoController({ field: 'slug' }), nestFiles), null);
  assert.equal(tracedLabel(dtoController({ field: 'name' }), nestFiles), '@Body() dto.name');
  assert.equal(tracedLabel(dtoController({ field: 'email' }), nestFiles), '@Body() dto.email');
  assert.equal(tracedLabel(dtoController({ field: 'email' }), nestFiles, 'html'), null);
  assert.equal(tracedLabel(dtoController({ field: 'parentId' }), nestFiles), '@Body() dto.parentId');
  assert.equal(tracedLabel(dtoController({ field: 'id', dtoName: 'UpdateDto' }), nestFiles), null);
});

test('class-validator only sanitizes when ValidationPipe runs', () => {
  assert.equal(tracedLabel(dtoController({ field: 'id', globalPipe: false }), nestFiles), '@Body() dto.id');
  assert.equal(tracedLabel(dtoController({ field: 'id', globalPipe: false, methodPipe: true }), nestFiles), null);
  const provider =
    'const providers = [{ provide: APP_PIPE, useClass: ValidationPipe }]; declare const APP_PIPE: symbol;';
  assert.equal(tracedLabel(dtoController({ field: 'id', globalPipe: false, extra: provider }), nestFiles), null);
});

function expressRoute(preamble: string, body: string) {
  return [
    "import express from 'express';",
    "import { z } from 'zod';",
    "import Joi from 'joi';",
    "import * as yup from 'yup';",
    "import * as v from 'valibot';",
    'declare function sink(value: unknown): void;',
    preamble,
    'const app = express();',
    `app.post('/items', async (req, res) => { ${body} });`,
  ].join('\n');
}

const schemaFiles = { ...stubs.express, ...stubs.schemas };
const zodQuery = [
  'const Query = z.object({',
  '  id: z.string().uuid(), page: z.coerce.number(), sort: z.enum(["asc", "desc"]),',
  '  slug: z.string().regex(/^[a-z-]+$/), q: z.string().trim().min(1), any: z.string().regex(/^a/),',
  '});',
].join('\n');

test('zod output is clean for numeric, enum, uuid and closed-regex fields and tainted for plain strings', () => {
  for (const field of ['id', 'page', 'sort', 'slug']) {
    assert.equal(
      tracedLabel(expressRoute(zodQuery, `sink(Query.parse(req.query).${field});`), schemaFiles),
      null,
      field,
    );
  }
  assert.equal(tracedLabel(expressRoute(zodQuery, 'sink(Query.parse(req.query).q);'), schemaFiles), 'req.query');
  assert.equal(tracedLabel(expressRoute(zodQuery, 'sink(Query.parse(req.query).any);'), schemaFiles), 'req.query');
  assert.equal(tracedLabel(expressRoute('', 'sink(z.string().parse(req.query.q));'), schemaFiles), 'req.query.q');
  assert.equal(tracedLabel(expressRoute('', 'sink(z.string().uuid().parse(req.query.q));'), schemaFiles), null);
  const safe = (field: string) =>
    `const result = Query.safeParse(req.query); if (result.success) sink(result.data.${field});`;
  assert.equal(tracedLabel(expressRoute(zodQuery, safe('q')), schemaFiles), 'req.query');
  assert.equal(tracedLabel(expressRoute(zodQuery, safe('id')), schemaFiles), null);
});

test('a schema imported from a project file is read the same way', () => {
  const source = expressRoute(
    "import { Query } from './schemas';",
    'const { q, id } = Query.parse(req.query); sink(q);',
  );
  const files = { ...schemaFiles, 'schemas.ts': `import { z } from 'zod';\nexport ${zodQuery}` };
  assert.equal(tracedLabel(source, files), 'req.query');
  assert.equal(tracedLabel(source.replace('sink(q)', 'sink(id)'), files), null);
});

test('joi, yup and valibot schemas narrow the same way', () => {
  const joi =
    'const schema = Joi.object({ id: Joi.string().guid(), q: Joi.string(), kind: Joi.string().valid("a", "b") });';
  const joiBody = (field: string) => `const { value } = schema.validate(req.body); sink(value.${field});`;
  assert.equal(tracedLabel(expressRoute(joi, joiBody('q')), schemaFiles), 'req.body');
  assert.equal(tracedLabel(expressRoute(joi, joiBody('id')), schemaFiles), null);
  assert.equal(tracedLabel(expressRoute(joi, joiBody('kind')), schemaFiles), null);
  const yupSchema = 'const schema = yup.object({ n: yup.number(), q: yup.string() });';
  const yupBody = (field: string) => `const value = await schema.validate(req.body); sink(value.${field});`;
  assert.equal(tracedLabel(expressRoute(yupSchema, yupBody('q')), schemaFiles), 'req.body');
  assert.equal(tracedLabel(expressRoute(yupSchema, yupBody('n')), schemaFiles), null);
  const valibot = 'const Schema = v.object({ id: v.pipe(v.string(), v.uuid()), q: v.string() });';
  const valibotBody = (field: string) => `const output = v.parse(Schema, req.body); sink(output.${field});`;
  assert.equal(tracedLabel(expressRoute(valibot, valibotBody('q')), schemaFiles), 'req.body');
  assert.equal(tracedLabel(expressRoute(valibot, valibotBody('id')), schemaFiles), null);
});
