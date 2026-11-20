'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { lint } = require('./helpers.cjs');

const typeorm = `export class Repository<T> {
  findOne(options: object): Promise<T | null>;
  find(options?: object): Promise<T[]>;
  existsBy(filter: object): Promise<boolean>;
}`;
const declarations = { 'node_modules/typeorm/index.d.ts': typeorm };

function loopLines(source) {
  return lint(source, declarations)
    .filter((finding) => finding.ruleId === 'orm-query-in-loop')
    .map((finding) => finding.line);
}

function markedLines(source) {
  return source.split('\n').flatMap((line, index) => (line.endsWith('// loop') ? [index + 1] : []));
}

test('bounded retry and probe loops are not per-item queries, but unbounded or collection-driven ones are', () => {
  const source = `import { Repository } from 'typeorm';
    declare const repo: Repository<{ id: number }>, ids: number[], unknownLimit: number;
    const MAX_RETRIES = 5;
    const TOO_MANY = 500;
    async function retry() {
      let attempts = 0;
      const maxAttempts = 3;
      while (attempts < maxAttempts) {
        const taken = await repo.findOne({ where: { id: attempts } });
        if (!taken) break;
        attempts++;
      }
      let retryCount = 0;
      while (retryCount < MAX_RETRIES) {
        if (await repo.findOne({ where: { id: retryCount } })) retryCount += 1;
        else break;
      }
      for (let tries = 0; tries <= 2; tries++) {
        await repo.findOne({ where: { id: tries } });
      }
    }
    async function stillReported(rows: number[]) {
      let index = 0;
      while (index < ids.length) {
        await repo.findOne({ where: { id: ids[index] } }); // loop
        index++;
      }
      let capped = 0;
      while (capped < TOO_MANY) {
        await repo.findOne({ where: { id: capped } }); // loop
        capped++;
      }
      let dynamic = 0;
      while (dynamic < unknownLimit) {
        await repo.findOne({ where: { id: dynamic } }); // loop
        dynamic++;
      }
      let found = 0;
      while (found < 3 && ids.length > found) {
        await repo.findOne({ where: { id: found } });
        found++;
      }
      let neverAdvances = 0;
      while (neverAdvances < 3) {
        await repo.findOne({ where: { id: neverAdvances } }); // loop
      }
      for (const row of rows) {
        let attempt = 0;
        while (attempt < 3) {
          await repo.findOne({ where: { id: row } }); // loop
          attempt++;
        }
      }
    }`;
  assert.deepEqual(loopLines(source), markedLines(source));
});

test('loops over a small literal collection are bounded, but runtime or larger collections are not', () => {
  const source = `import { Repository } from 'typeorm';
    declare const repo: Repository<{ id: number }>, runtime: number[], maybe: (number | undefined)[];
    const REMINDER_DAYS = [3, 7, 14];
    const BIG = [1, 2, 3, 4, 5, 6, 7, 8];
    async function bounded(first: number, second?: number) {
      for (const days of REMINDER_DAYS) await repo.find({ where: { id: days } });
      const participants = [first, second].filter((id): id is number => !!id);
      await Promise.all(participants.map((id) => repo.findOne({ where: { id } })));
      for (const id of [first, 2, 3]) await repo.findOne({ where: { id } });
      const chosen = [[first, 1], [second, 2]].flatMap(([picked, saved]) => (picked && picked !== saved ? picked : []));
      for (const id of chosen) await repo.findOne({ where: { id } });
    }
    async function stillReported() {
      for (const id of BIG) await repo.findOne({ where: { id } }); // loop
      for (const id of runtime) await repo.findOne({ where: { id } }); // loop
      const grown = [...runtime, 1];
      const widened = [[1], [2]].flatMap((pair) => pair);
      for (const id of widened) await repo.findOne({ where: { id } }); // loop
      for (const id of grown) await repo.findOne({ where: { id } }); // loop
      await Promise.all(runtime.map((id) => repo.findOne({ where: { id } }))); // loop
      const accumulator: number[] = [];
      for (const id of runtime) accumulator.push(id);
      for (const id of accumulator) await repo.findOne({ where: { id } }); // loop
      const queue = [1, 2];
      queue.push(...runtime);
      for (const id of queue) await repo.findOne({ where: { id } }); // loop
    }`;
  assert.deepEqual(loopLines(source), markedLines(source));
});

test('a query whose input is the previous iteration result walks a chain and cannot be batched', () => {
  const source = `import { Repository } from 'typeorm';
    type Node = { id: number; parentId: number | null; previousId: number };
    declare const repo: Repository<Node>, roots: Node[];
    async function chain(start: Node) {
      let current = start;
      while (current.parentId) {
        const parent = await repo.findOne({ where: { id: current.parentId } });
        if (!parent) break;
        current = parent;
      }
    }
    async function stillReported(ids: number[]) {
      let latest = 0;
      let index = 0;
      while (index < ids.length) {
        const row = await repo.findOne({ where: { id: ids[index] } }); // loop
        if (row) latest = row.id;
        index++;
      }
    }`;
  assert.deepEqual(loopLines(source), markedLines(source));
});

test('closed value domains, failure paths, memoised loads and first-miss probes are not per-item queries', () => {
  const source = `import { Repository } from 'typeorm';
    declare const repo: Repository<{ id: number }>, ids: number[];
    enum Channel { InApp = 'in_app', Push = 'push', Email = 'email' }
    declare const channels: Channel[];
    async function undo(created: number[]) {
      for (const id of created) await repo.findOne({ where: { id } });
    }
    async function cleanup(created: number[]) {
      for (const id of created) await repo.findOne({ where: { id } }); // loop
    }
    async function run() {
      try { await cleanup(ids); } catch { await undo(ids); }
      for (const channel of channels) await repo.findOne({ where: { channel } });
      for (const channel of channels) if (channel === Channel.Push) await repo.find({ where: { channel } });
      for (const id of ids) if (id === 7) await repo.findOne({ where: { id } });
      for (const id of ids) {
        try { JSON.parse(String(id)); } catch { await repo.findOne({ where: { id } }); }
      }
      let first: object | null | undefined;
      for (const id of ids) first ??= await repo.findOne({ where: { id } });
      const seen = new Map<number, object | null>();
      for (const id of ids) {
        let row = seen.get(id);
        if (!row) {
          row = await repo.findOne({ where: { id } });
          seen.set(id, row);
        }
      }
      const loaded: { id: number }[] = [];
      for (const id of ids) {
        let row = loaded.find((item) => item.id === id);
        if (!row) {
          row = (await repo.findOne({ where: { id } })) ?? { id };
          loaded.push(row);
        }
      }
      for (const id of ids) if (id > 7) await repo.findOne({ where: { id } }); // loop
      for (const id of ids) {
        const row = await repo.findOne({ where: { id } }); // loop
        if (!row) return id;
      }
      for (let sequence = 1; sequence <= 50; sequence++) {
        const taken = await repo.findOne({ where: { id: sequence } });
        if (!taken) return sequence;
      }
      return first;
    }`;
  assert.deepEqual(loopLines(source), markedLines(source));
});
