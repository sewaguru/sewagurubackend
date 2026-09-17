ALTER TABLE "DeviceToken"
ADD COLUMN IF NOT EXISTS "deviceId" TEXT,
ADD COLUMN IF NOT EXISTS "appVersion" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "DeviceToken_token_key"
ON "DeviceToken"("token");

CREATE INDEX IF NOT EXISTS "DeviceToken_userId_idx"
ON "DeviceToken"("userId");
