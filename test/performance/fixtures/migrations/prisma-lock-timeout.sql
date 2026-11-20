-- A statement waits for its table lock, and every request queues behind that wait, so none waits long.
SET lock_timeout = '5s';

-- AlterTable
ALTER TABLE "UploadedObject" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "UploadedObject_deletedAt_idx" ON "UploadedObject"("deletedAt");
