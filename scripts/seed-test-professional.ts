import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

/**
 * Creates (or promotes) an already-APPROVED, ONLINE professional reachable
 * via the given phone number, offering every bookable service, so it's
 * immediately usable for end-to-end partner-app testing (no manual
 * verification step needed). Pair with TEST_OTP_BYPASS_PHONE set to the
 * same number so login doesn't need a real SMS OTP.
 * Idempotent: safe to re-run.
 */
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const PHONE_RAW = process.argv[2] ?? '7090607571';
const PHONE_NORMALIZED = `91${PHONE_RAW.replace(/\D/g, '').slice(-10)}`;
const DISPLAY_NAME = 'Test Professional';

async function main() {
  const existingAuth = await prisma.userAuth.findFirst({
    where: { identifier: PHONE_NORMALIZED },
    include: { user: { include: { professionalProfile: true } } },
  });

  let userId: string;
  if (existingAuth) {
    userId = existingAuth.user.id;
    await prisma.user.update({
      where: { id: userId },
      data: { role: 'PROFESSIONAL', isActive: true, isBlocked: false },
    });
    console.log(`Reusing existing user for ${PHONE_NORMALIZED}: ${userId}`);
  } else {
    const user = await prisma.user.create({
      data: {
        role: 'PROFESSIONAL',
        isActive: true,
        lastActiveAt: new Date(),
        profile: { create: { fullName: DISPLAY_NAME } },
        authMethods: {
          create: {
            provider: 'PHONE_OTP',
            identifierType: 'PHONE',
            identifier: PHONE_NORMALIZED,
            isVerified: true,
            isPrimary: true,
          },
        },
      },
    });
    userId = user.id;
    console.log(`Created user for ${PHONE_NORMALIZED}: ${userId}`);
  }

  // Attribute the approval to a real admin if one exists (falls back to
  // self-attribution if not — verifiedById has no FK constraint issue
  // either way since User already exists at this point).
  const anyAdmin = await prisma.user.findFirst({
    where: { role: { in: ['SUPER_ADMIN', 'ADMIN'] } },
    orderBy: { createdAt: 'asc' },
  });
  const verifiedById = anyAdmin?.id ?? userId;

  const branch = await prisma.branch.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!branch) {
    throw new Error('No branch found — seed cities/branches first (see scripts/seed-dummy-data.ts).');
  }

  const profile = await prisma.professionalProfile.upsert({
    where: { userId },
    update: {
      verificationStatus: 'APPROVED',
      verificationNote: 'Approved for QA/testing.',
      verifiedAt: new Date(),
      verifiedById,
      availabilityStatus: 'ONLINE',
      availabilityUpdatedAt: new Date(),
      latitude: branch.latitude,
      longitude: branch.longitude,
      locationUpdatedAt: new Date(),
      serviceRadiusKm: 50,
      branchId: branch.id,
      isActive: true,
      deletedAt: null,
    },
    create: {
      userId,
      displayName: DISPLAY_NAME,
      bio: 'Approved test account — offers every service, for full end-to-end QA.',
      experienceYears: 5,
      verificationStatus: 'APPROVED',
      verificationNote: 'Approved for QA/testing.',
      verifiedAt: new Date(),
      verifiedById,
      availabilityStatus: 'ONLINE',
      availabilityUpdatedAt: new Date(),
      latitude: branch.latitude,
      longitude: branch.longitude,
      locationUpdatedAt: new Date(),
      serviceRadiusKm: 50,
      branchId: branch.id,
    },
  });
  console.log(`Professional profile ready: ${profile.id} (APPROVED / ONLINE, branch: ${branch.name})`);

  const allServices = await prisma.serviceNode.findMany({
    where: { type: 'SERVICE', isBookable: true, isActive: true },
    select: { id: true },
  });
  for (const service of allServices) {
    await prisma.professionalService.upsert({
      where: { professionalId_serviceNodeId: { professionalId: profile.id, serviceNodeId: service.id } },
      update: { isActive: true },
      create: { professionalId: profile.id, serviceNodeId: service.id, isActive: true },
    });
  }
  console.log(`Assigned ${allServices.length} services.`);

  const existingDocs = await prisma.professionalDocument.count({ where: { professionalId: profile.id } });
  if (existingDocs === 0) {
    await prisma.professionalDocument.createMany({
      data: [
        {
          professionalId: profile.id,
          type: 'ID_PROOF',
          status: 'APPROVED',
          documentNumber: 'TEST-ID-0001',
          reviewedById: verifiedById,
          reviewedAt: new Date(),
        },
        {
          professionalId: profile.id,
          type: 'ADDRESS_PROOF',
          status: 'APPROVED',
          reviewedById: verifiedById,
          reviewedAt: new Date(),
        },
      ],
    });
    console.log('Added approved ID/address proof documents.');
  }

  console.log('\nDone. Login with:');
  console.log(`  phone: ${PHONE_RAW} (stored as ${PHONE_NORMALIZED})`);
  console.log('  OTP: whatever TEST_OTP_BYPASS_CODE is set to, once TEST_OTP_BYPASS_PHONE matches this number.');
}

main()
  .catch((err) => {
    console.error('Seeding failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
