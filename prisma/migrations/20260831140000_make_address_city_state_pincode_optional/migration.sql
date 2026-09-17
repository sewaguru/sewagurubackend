-- Make Address.cityId, Address.state, and Address.pincode nullable, to
-- match prisma/schema.prisma.
--
-- schema.prisma switched these three columns from required to optional in
-- commit cb9394d ("v"), alongside the account-deletion migration dated the
-- same day, but no ALTER TABLE for Address was ever generated or applied —
-- the live database has kept enforcing NOT NULL on all three ever since.
--
-- Addresses saved from the mobile app normally omit cityId/state/pincode
-- (a reverse-geocoded city name doesn't always match a row in the City
-- table, and pincode isn't always resolved), which trips a Postgres NOT
-- NULL violation on insert. Prisma reports that as error code P2011, and
-- the API's global error handler masks any "P*" Prisma error as a generic
-- "Database error" (DB_ERROR) — which is what the client currently sees
-- on every address save that doesn't happen to include all three fields.

ALTER TABLE "Address" ALTER COLUMN "cityId" DROP NOT NULL;
ALTER TABLE "Address" ALTER COLUMN "state" DROP NOT NULL;
ALTER TABLE "Address" ALTER COLUMN "pincode" DROP NOT NULL;
