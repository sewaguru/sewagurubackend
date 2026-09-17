CREATE TABLE IF NOT EXISTS "Banner" (
  "id" TEXT NOT NULL,
  "title" TEXT,
  "subtitle" TEXT,
  "ctaLabel" TEXT,
  "linkUrl" TEXT,
  "imageUrl" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "startsAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Banner_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Banner_isActive_idx" ON "Banner"("isActive");
CREATE INDEX IF NOT EXISTS "Banner_sortOrder_idx" ON "Banner"("sortOrder");
