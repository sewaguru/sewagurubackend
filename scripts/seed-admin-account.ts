import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

/**
 * Creates (or promotes) a SUPER_ADMIN account reachable via the
 * TEST_OTP_BYPASS_* identifiers — so logging into the dashboard with the
 * bypass OTP lands on an admin account instead of auto-registering a new
 * plain USER (see auth.controller.ts's "AUTO CREATE USER" branch, which
 * defaults role to USER when no matching identifier exists yet).
 * Idempotent: safe to re-run.
 */
const connectionString = process.env.DATABASE_URL!;
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const TEST_EMAIL = (process.env.TEST_OTP_BYPASS_EMAIL ?? 'info@sewaguru.in')
  .trim()
  .toLowerCase();
const TEST_PHONE_RAW = (process.env.TEST_OTP_BYPASS_PHONE ?? '1234567890').trim();
const TEST_PHONE_NORMALIZED = `91${TEST_PHONE_RAW.replace(/\D/g, '').slice(-10)}`;

async function main() {
  const existingAuth = await prisma.userAuth.findFirst({
    where: {
      identifier: { in: [TEST_EMAIL, TEST_PHONE_NORMALIZED] },
    },
    include: { user: true },
  });

  if (existingAuth) {
    const updated = await prisma.user.update({
      where: { id: existingAuth.user.id },
      data: {
        role: 'SUPER_ADMIN',
        isActive: true,
        isBlocked: false,
      },
    });
    console.log(`Promoted existing account to SUPER_ADMIN: ${updated.id}`);
    console.log(`  email: ${TEST_EMAIL}`);
    console.log(`  phone: ${TEST_PHONE_NORMALIZED} (raw: ${TEST_PHONE_RAW})`);
    return;
  }

  const user = await prisma.user.create({
    data: {
      role: 'SUPER_ADMIN',
      isActive: true,
      profile: {
        create: {
          fullName: 'SewaGuru Admin',
          email: TEST_EMAIL,
        },
      },
      authMethods: {
        create: [
          {
            provider: 'EMAIL_OTP',
            identifierType: 'EMAIL',
            identifier: TEST_EMAIL,
            isVerified: true,
            isPrimary: true,
          },
          {
            provider: 'PHONE_OTP',
            identifierType: 'PHONE',
            identifier: TEST_PHONE_NORMALIZED,
            isVerified: true,
            isPrimary: false,
          },
        ],
      },
    },
  });

  console.log(`Created SUPER_ADMIN account: ${user.id}`);
  console.log(`  email: ${TEST_EMAIL}`);
  console.log(`  phone: ${TEST_PHONE_NORMALIZED} (raw: ${TEST_PHONE_RAW})`);
}

main()
  .catch((err) => {
    console.error('Seeding failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
