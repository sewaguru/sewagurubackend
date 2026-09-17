import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

/**
 * Creates (or reuses) the Play Store / App Store review test account —
 * reachable via EITHER info@sewaguru.in OR the whitelisted test phone
 * number, both linked to the SAME account — and seeds a couple of test
 * bookings so reviewers see real data in Orders. Pairs with the
 * TEST_OTP_BYPASS_* env vars (see src/config/config.ts / otp.service.ts),
 * which make both identifiers accept the fixed OTP instead of a real one.
 * Idempotent: safe to re-run, reuses the existing account/bookings.
 */
const connectionString = process.env.DATABASE_URL!;
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const TEST_EMAIL = (process.env.TEST_OTP_BYPASS_EMAIL ?? 'info@sewaguru.in')
  .trim()
  .toLowerCase();
const TEST_PHONE_RAW = (process.env.TEST_OTP_BYPASS_PHONE ?? '1234567890').trim();
const TEST_PHONE_NORMALIZED = `91${TEST_PHONE_RAW.replace(/\D/g, '').slice(-10)}`;

async function ensureTestUser() {
  const existingAuth = await prisma.userAuth.findFirst({
    where: {
      identifier: { in: [TEST_EMAIL, TEST_PHONE_NORMALIZED] },
    },
    include: { user: true },
  });

  if (existingAuth) {
    console.log(`Reusing existing test user: ${existingAuth.user.id}`);
    return existingAuth.user;
  }

  const user = await prisma.user.create({
    data: {
      role: 'USER',
      isActive: true,
      profile: {
        create: {
          fullName: 'App Store Review',
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

  console.log(`Created test user: ${user.id}`);
  console.log(`  email: ${TEST_EMAIL}`);
  console.log(`  phone: ${TEST_PHONE_NORMALIZED} (raw: ${TEST_PHONE_RAW})`);
  return user;
}

async function ensureTestAddress(userId: string) {
  const existing = await prisma.address.findFirst({
    where: { userId },
  });
  if (existing) return existing;

  const branch = await prisma.branch.findFirst({
    where: { isActive: true },
    include: { city: true },
  });

  if (!branch) {
    console.log('No active branch found — skipping address + bookings.');
    return null;
  }

  return prisma.address.create({
    data: {
      userId,
      label: 'HOME',
      addressLine1: 'App Review Test Address',
      addressLine2: branch.address,
      cityId: branch.cityId,
      state: branch.city.state,
      pincode: branch.pincode,
      latitude: branch.latitude,
      longitude: branch.longitude,
      isPrimary: true,
      isActive: true,
    },
  });
}

async function seedTestBookings(userId: string, addressId: string | null) {
  const existingCount = await prisma.booking.count({ where: { userId } });
  if (existingCount > 0) {
    console.log(`Skipped test bookings: ${existingCount} already exist for this user.`);
    return;
  }

  const branch = await prisma.branch.findFirst({ where: { isActive: true } });
  if (!branch) {
    console.log('No active branch found — skipping test bookings.');
    return;
  }

  const service = await prisma.serviceNode.findFirst({
    where: { type: 'SERVICE', isActive: true, isBookable: true },
    orderBy: { sortOrder: 'asc' },
  });

  if (!service) {
    console.log('No bookable service found — skipping test bookings.');
    return;
  }

  const price = service.defaultPrice ?? 499;

  const bookingsToCreate = [
    {
      status: 'BOOKED' as const,
      paymentStatus: 'PENDING' as const,
      scheduledAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), // 2 days from now
      displayId: 'SW90001',
    },
    {
      status: 'COMPLETED' as const,
      paymentStatus: 'PAID' as const,
      scheduledAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
      displayId: 'SW90002',
    },
  ];

  for (const draft of bookingsToCreate) {
    const booking = await prisma.booking.create({
      data: {
        displayId: draft.displayId,
        userId,
        branchId: branch.id,
        addressId,
        status: draft.status,
        paymentStatus: draft.paymentStatus,
        scheduledAt: draft.scheduledAt,
        subtotal: price,
        totalAmount: price,
        items: {
          create: [
            {
              serviceNodeId: service.id,
              price,
              quantity: 1,
              lineTotal: price,
              serviceSnapshot: { name: service.name },
            },
          ],
        },
      },
    });
    console.log(`  [OK] test booking ${booking.displayId} (${draft.status})`);
  }
}

async function main() {
  const user = await ensureTestUser();
  const address = await ensureTestAddress(user.id);
  await seedTestBookings(user.id, address?.id ?? null);
  console.log('Done.');
}

main()
  .catch((err) => {
    console.error('Seeding failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
