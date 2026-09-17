DO $$ BEGIN
  CREATE TYPE "AccountDeletionStatus" AS ENUM ('NONE', 'REQUESTED', 'CANCELLED', 'COMPLETED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "AccountDeletionReason" AS ENUM (
    'NO_LONGER_NEED_APP',
    'USING_ANOTHER_SERVICE',
    'BAD_EXPERIENCE',
    'TOO_MANY_NOTIFICATIONS',
    'PRIVACY_CONCERNS',
    'DIFFICULT_TO_USE',
    'SERVICE_NOT_AVAILABLE',
    'OTHER'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "deletionRequestedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "deletionScheduledFor" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "deletionCancelledAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "deletionCompletedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "deletionStatus" "AccountDeletionStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN IF NOT EXISTS "deletionReason" "AccountDeletionReason",
ADD COLUMN IF NOT EXISTS "deletionFeedback" TEXT,
ADD COLUMN IF NOT EXISTS "deletionRequestIp" TEXT,
ADD COLUMN IF NOT EXISTS "deletionRequestedDevice" TEXT,
ADD COLUMN IF NOT EXISTS "cancelledByLogin" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "finalDeletionJobStatus" TEXT,
ADD COLUMN IF NOT EXISTS "finalDeletionJobMetadata" JSONB,
ADD COLUMN IF NOT EXISTS "finalDeletionAttemptedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "AccountDeletionTombstone" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "identifierType" "AuthIdentifierType" NOT NULL,
  "identifierHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AccountDeletionTombstone_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AccountDeletionTombstone_identifierHash_key"
ON "AccountDeletionTombstone"("identifierHash");

CREATE INDEX IF NOT EXISTS "AccountDeletionTombstone_userId_idx"
ON "AccountDeletionTombstone"("userId");

CREATE INDEX IF NOT EXISTS "AccountDeletionTombstone_identifierType_idx"
ON "AccountDeletionTombstone"("identifierType");

CREATE INDEX IF NOT EXISTS "User_deletionStatus_deletionScheduledFor_idx"
ON "User"("deletionStatus", "deletionScheduledFor");

CREATE INDEX IF NOT EXISTS "User_deletionReason_idx"
ON "User"("deletionReason");

CREATE INDEX IF NOT EXISTS "User_deletionRequestedAt_idx"
ON "User"("deletionRequestedAt");
