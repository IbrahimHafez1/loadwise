import { MigrationInterface, QueryRunner } from 'typeorm';

export class StudentPhoneIndex1712000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_students_guardian_phone" ON "students" ("school_id", "guardian_phone") WHERE "deleted_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_students_guardian_phone"`);
  }
}
