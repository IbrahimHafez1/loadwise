import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGuardianLinks1700000000040 implements MigrationInterface {
  name = 'AddGuardianLinks1700000000040';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "guardian_links" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "school_id" uuid NOT NULL,
        "guardian_id" uuid NOT NULL,
        "student_id" uuid NOT NULL,
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_guardian_links" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_guardian_links_pair" ON "guardian_links" ("guardian_id", "student_id") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "guardian_links" ADD CONSTRAINT "FK_guardian_links_school" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(`ALTER TABLE "guardian_links" ADD COLUMN "note" text NOT NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "guardian_links"`);
  }
}
