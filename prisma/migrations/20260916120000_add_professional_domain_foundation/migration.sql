-- CreateEnum
CREATE TYPE "ProfessionalVerificationStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ProfessionalAvailabilityStatus" AS ENUM ('OFFLINE', 'ONLINE', 'BUSY');

-- CreateEnum
CREATE TYPE "ProfessionalDocumentType" AS ENUM ('ID_PROOF', 'ADDRESS_PROOF', 'CERTIFICATION', 'POLICE_VERIFICATION', 'PROFILE_PHOTO', 'OTHER');

-- CreateEnum
CREATE TYPE "ProfessionalDocumentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "BookingProfessionalOfferStatus" AS ENUM ('PENDING', 'SENT', 'VIEWED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProfessionalEarningStatus" AS ENUM ('PENDING', 'ACCRUED', 'PAYABLE', 'PAID', 'REVERSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "Role" ADD VALUE 'PROFESSIONAL';

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assignedProfessionalId" TEXT;

-- AlterTable
ALTER TABLE "ServiceReview" ADD COLUMN     "professionalId" TEXT;

-- CreateTable
CREATE TABLE "ProfessionalProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "bio" TEXT,
    "profileImageUrl" TEXT,
    "experienceYears" INTEGER,
    "verificationStatus" "ProfessionalVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verificationNote" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "availabilityStatus" "ProfessionalAvailabilityStatus" NOT NULL DEFAULT 'OFFLINE',
    "availabilityUpdatedAt" TIMESTAMP(3),
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "locationUpdatedAt" TIMESTAMP(3),
    "serviceRadiusKm" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "branchId" TEXT,
    "totalJobsCompleted" INTEGER NOT NULL DEFAULT 0,
    "totalJobsCancelled" INTEGER NOT NULL DEFAULT 0,
    "averageRating" DOUBLE PRECISION,
    "ratingCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "scheduledPurgeAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfessionalProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfessionalService" (
    "id" TEXT NOT NULL,
    "professionalId" TEXT NOT NULL,
    "serviceNodeId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfessionalService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfessionalDocument" (
    "id" TEXT NOT NULL,
    "professionalId" TEXT NOT NULL,
    "type" "ProfessionalDocumentType" NOT NULL,
    "status" "ProfessionalDocumentStatus" NOT NULL DEFAULT 'PENDING',
    "mediaId" TEXT,
    "documentNumber" TEXT,
    "note" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfessionalDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingProfessionalOffer" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "professionalId" TEXT NOT NULL,
    "status" "BookingProfessionalOfferStatus" NOT NULL DEFAULT 'PENDING',
    "distanceKm" DOUBLE PRECISION,
    "sentAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "responseNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingProfessionalOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfessionalEarning" (
    "id" TEXT NOT NULL,
    "professionalId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "grossAmount" DOUBLE PRECISION NOT NULL,
    "platformFeeAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "netAmount" DOUBLE PRECISION NOT NULL,
    "status" "ProfessionalEarningStatus" NOT NULL DEFAULT 'PENDING',
    "payoutId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfessionalEarning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfessionalBankAccount" (
    "id" TEXT NOT NULL,
    "professionalId" TEXT NOT NULL,
    "accountHolderName" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "ifscCode" TEXT NOT NULL,
    "bankName" TEXT,
    "upiId" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfessionalBankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payout" (
    "id" TEXT NOT NULL,
    "professionalId" TEXT NOT NULL,
    "bankAccountId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "reference" TEXT,
    "failureReason" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProfessionalProfile_userId_key" ON "ProfessionalProfile"("userId");

-- CreateIndex
CREATE INDEX "ProfessionalProfile_verificationStatus_idx" ON "ProfessionalProfile"("verificationStatus");

-- CreateIndex
CREATE INDEX "ProfessionalProfile_availabilityStatus_idx" ON "ProfessionalProfile"("availabilityStatus");

-- CreateIndex
CREATE INDEX "ProfessionalProfile_verificationStatus_availabilityStatus_idx" ON "ProfessionalProfile"("verificationStatus", "availabilityStatus");

-- CreateIndex
CREATE INDEX "ProfessionalProfile_latitude_longitude_idx" ON "ProfessionalProfile"("latitude", "longitude");

-- CreateIndex
CREATE INDEX "ProfessionalProfile_branchId_idx" ON "ProfessionalProfile"("branchId");

-- CreateIndex
CREATE INDEX "ProfessionalProfile_isActive_idx" ON "ProfessionalProfile"("isActive");

-- CreateIndex
CREATE INDEX "ProfessionalProfile_deletedAt_idx" ON "ProfessionalProfile"("deletedAt");

-- CreateIndex
CREATE INDEX "ProfessionalProfile_scheduledPurgeAt_idx" ON "ProfessionalProfile"("scheduledPurgeAt");

-- CreateIndex
CREATE INDEX "ProfessionalService_professionalId_idx" ON "ProfessionalService"("professionalId");

-- CreateIndex
CREATE INDEX "ProfessionalService_serviceNodeId_idx" ON "ProfessionalService"("serviceNodeId");

-- CreateIndex
CREATE UNIQUE INDEX "ProfessionalService_professionalId_serviceNodeId_key" ON "ProfessionalService"("professionalId", "serviceNodeId");

-- CreateIndex
CREATE INDEX "ProfessionalDocument_professionalId_idx" ON "ProfessionalDocument"("professionalId");

-- CreateIndex
CREATE INDEX "ProfessionalDocument_type_idx" ON "ProfessionalDocument"("type");

-- CreateIndex
CREATE INDEX "ProfessionalDocument_status_idx" ON "ProfessionalDocument"("status");

-- CreateIndex
CREATE INDEX "BookingProfessionalOffer_bookingId_idx" ON "BookingProfessionalOffer"("bookingId");

-- CreateIndex
CREATE INDEX "BookingProfessionalOffer_professionalId_idx" ON "BookingProfessionalOffer"("professionalId");

-- CreateIndex
CREATE INDEX "BookingProfessionalOffer_status_idx" ON "BookingProfessionalOffer"("status");

-- CreateIndex
CREATE INDEX "BookingProfessionalOffer_bookingId_status_idx" ON "BookingProfessionalOffer"("bookingId", "status");

-- CreateIndex
CREATE INDEX "BookingProfessionalOffer_professionalId_status_idx" ON "BookingProfessionalOffer"("professionalId", "status");

-- CreateIndex
CREATE INDEX "BookingProfessionalOffer_expiresAt_idx" ON "BookingProfessionalOffer"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingProfessionalOffer_bookingId_professionalId_key" ON "BookingProfessionalOffer"("bookingId", "professionalId");

-- CreateIndex
CREATE INDEX "ProfessionalEarning_professionalId_idx" ON "ProfessionalEarning"("professionalId");

-- CreateIndex
CREATE INDEX "ProfessionalEarning_bookingId_idx" ON "ProfessionalEarning"("bookingId");

-- CreateIndex
CREATE INDEX "ProfessionalEarning_status_idx" ON "ProfessionalEarning"("status");

-- CreateIndex
CREATE INDEX "ProfessionalEarning_professionalId_status_idx" ON "ProfessionalEarning"("professionalId", "status");

-- CreateIndex
CREATE INDEX "ProfessionalEarning_payoutId_idx" ON "ProfessionalEarning"("payoutId");

-- CreateIndex
CREATE UNIQUE INDEX "ProfessionalEarning_professionalId_bookingId_key" ON "ProfessionalEarning"("professionalId", "bookingId");

-- CreateIndex
CREATE INDEX "ProfessionalBankAccount_professionalId_idx" ON "ProfessionalBankAccount"("professionalId");

-- CreateIndex
CREATE INDEX "ProfessionalBankAccount_professionalId_isPrimary_idx" ON "ProfessionalBankAccount"("professionalId", "isPrimary");

-- CreateIndex
CREATE INDEX "Payout_professionalId_idx" ON "Payout"("professionalId");

-- CreateIndex
CREATE INDEX "Payout_status_idx" ON "Payout"("status");

-- CreateIndex
CREATE INDEX "Payout_bankAccountId_idx" ON "Payout"("bankAccountId");

-- CreateIndex
CREATE INDEX "Booking_assignedProfessionalId_idx" ON "Booking"("assignedProfessionalId");

-- CreateIndex
CREATE INDEX "ServiceReview_professionalId_createdAt_idx" ON "ServiceReview"("professionalId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_assignedProfessionalId_fkey" FOREIGN KEY ("assignedProfessionalId") REFERENCES "ProfessionalProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceReview" ADD CONSTRAINT "ServiceReview_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "ProfessionalProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfessionalProfile" ADD CONSTRAINT "ProfessionalProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfessionalProfile" ADD CONSTRAINT "ProfessionalProfile_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfessionalProfile" ADD CONSTRAINT "ProfessionalProfile_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfessionalService" ADD CONSTRAINT "ProfessionalService_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "ProfessionalProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfessionalService" ADD CONSTRAINT "ProfessionalService_serviceNodeId_fkey" FOREIGN KEY ("serviceNodeId") REFERENCES "ServiceNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfessionalDocument" ADD CONSTRAINT "ProfessionalDocument_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "ProfessionalProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfessionalDocument" ADD CONSTRAINT "ProfessionalDocument_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfessionalDocument" ADD CONSTRAINT "ProfessionalDocument_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingProfessionalOffer" ADD CONSTRAINT "BookingProfessionalOffer_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingProfessionalOffer" ADD CONSTRAINT "BookingProfessionalOffer_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "ProfessionalProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfessionalEarning" ADD CONSTRAINT "ProfessionalEarning_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "ProfessionalProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfessionalEarning" ADD CONSTRAINT "ProfessionalEarning_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfessionalEarning" ADD CONSTRAINT "ProfessionalEarning_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfessionalBankAccount" ADD CONSTRAINT "ProfessionalBankAccount_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "ProfessionalProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "ProfessionalProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "ProfessionalBankAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
