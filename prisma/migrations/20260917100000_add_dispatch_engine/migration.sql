-- CreateEnum
CREATE TYPE "DispatchStatus" AS ENUM ('NOT_DISPATCHED', 'IN_PROGRESS', 'OFFERS_SENT', 'NO_ELIGIBLE_PROFESSIONALS', 'EXPIRED_UNFILLED', 'ASSIGNED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'JOB_OFFER_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE 'DISPATCH_NO_PROFESSIONALS';

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "dispatchAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dispatchStatus" "DispatchStatus" NOT NULL DEFAULT 'NOT_DISPATCHED',
ADD COLUMN     "dispatchedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BookingProfessionalOffer" ADD COLUMN     "batchNumber" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "Booking_dispatchStatus_idx" ON "Booking"("dispatchStatus");

-- CreateIndex
CREATE INDEX "BookingProfessionalOffer_status_expiresAt_idx" ON "BookingProfessionalOffer"("status", "expiresAt");
