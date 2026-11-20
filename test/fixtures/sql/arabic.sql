-- ترحيل: إضافة عمود الاسم
INSERT INTO "العملاء" ("الاسم") VALUES ('أحمد'), ('مريم');
ALTER TABLE "العملاء" ADD COLUMN "المدينة" text DEFAULT 'القاهرة', ADD COLUMN bad bad bad;
CREATE INDEX "فهرس" ON "العملاء" ("الاسم");
