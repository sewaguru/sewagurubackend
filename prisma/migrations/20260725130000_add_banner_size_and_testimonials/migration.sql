DO $$ BEGIN
  CREATE TYPE "BannerSize" AS ENUM ('HERO', 'GRID');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Banner"
ADD COLUMN IF NOT EXISTS "size" "BannerSize" NOT NULL DEFAULT 'HERO';

CREATE INDEX IF NOT EXISTS "Banner_size_idx" ON "Banner"("size");

CREATE TABLE IF NOT EXISTS "Testimonial" (
  "id" TEXT NOT NULL,
  "customerName" TEXT NOT NULL,
  "customerRole" TEXT,
  "avatarUrl" TEXT,
  "quote" TEXT NOT NULL,
  "rating" INTEGER,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Testimonial_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Testimonial_isActive_idx" ON "Testimonial"("isActive");
CREATE INDEX IF NOT EXISTS "Testimonial_sortOrder_idx" ON "Testimonial"("sortOrder");
