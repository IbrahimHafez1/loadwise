import type { Repository } from 'typeorm';
import { Model } from 'sequelize';
import { Model as Model7 } from '@sequelize/core';
import { model, Schema } from 'mongoose';
import type { Knex } from 'knex';
// kysely is ESM-only from 0.29, so this CommonJS fixture imports its types in import mode.
import type { Kysely } from 'kysely' with { 'resolution-mode': 'import' };

type Person = { id: number; name: string };
class Person6 extends Model {}
class Person7 extends Model7 {}
const people = model<Person>('Person', new Schema<Person>({ id: Number, name: String }));
declare const repository: Repository<Person>;
declare const knex: Knex;
declare const kysely: Kysely<{ people: Person }>;

export async function lookup(ids: number[]) {
  for (const id of ids) {
    void repository.findOneBy({ id }); // expect loop findOneBy
    await Person6.findByPk(id); // expect loop findByPk
    await Person7.findByPk(id); // expect loop findByPk
    await people.findOne({ id }).lean(); // expect loop lean
    await people.findById(id).exec(); // expect loop exec
    people.findById(id); // clean
    people.find({ id }).lean(); // clean
    await knex('people').where('id', id); // expect loop where
    await knex('people'); // expect loop knex
    knex('people').select('id').then(() => {}); // expect loop then
    knex('people').where('id', id).toSQL(); // clean
    const query = kysely.selectFrom('people').selectAll().where('id', '=', id);
    query.executeTakeFirst(); // expect loop executeTakeFirst
    await query.execute(); // expect loop execute
    query.compile(); // clean
  }
  await Promise.all(ids.map(id => people.findById(id))); // expect loop findById; lean people
  return [
    (await repository.findBy({ name: 'a' })).length, // expect count length
    (await repository.find({ where: { name: 'a' } })).length, // expect count length
    (await Person6.findAll({ where: { name: 'a' } })).length, // expect count length
    (await Person7.findAll()).length, // expect count length
    (await people.find({ name: 'a' }).lean().exec()).length, // expect count length
    (await people.find({ name: 'a' })).length, // expect count length
    (await people.find().limit(1)).length, // clean
    (await Person6.findAll({ limit: 1 })).length, // clean
    (await knex('people').where('id', 1).select('id')).length, // expect count length
    (await kysely.selectFrom('people').selectAll().where('id', '=', 1).execute()).length, // expect count length
    (await kysely.selectFrom('people').selectAll().limit(3).execute()).length, // clean
    (await knex('people').limit(1).select('id')).length, // clean
  ];
}
