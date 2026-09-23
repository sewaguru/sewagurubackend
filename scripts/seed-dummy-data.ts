import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../src/generated/prisma/client';

/**
 * Populates a freshly-migrated, empty database with realistic dummy data
 * across every domain the admin dashboard covers: branches, professionals
 * (spanning every verification/availability state), customers, bookings
 * (spanning the full lifecycle + dispatch states), reviews, earnings, and
 * a payout. Idempotent-ish: safe to re-run (upserts / existence checks
 * everywhere), but bookings/reviews/earnings are only created once (they
 * have no natural unique key to upsert on) — re-running skips them if any
 * already exist for this seed's tagged branch.
 */
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const normPhone = (raw: string) => `91${raw.replace(/\D/g, '').slice(-10)}`;

const log = (msg: string) => console.log(`[seed] ${msg}`);

//////////////////////////////////////////////////////
// CITIES + BRANCHES
//////////////////////////////////////////////////////

async function ensureCityBranch(opts: {
  cityName: string;
  state: string;
  branchName: string;
  address: string;
  pincode: string;
  latitude: number;
  longitude: number;
}) {
  const city = await prisma.city.upsert({
    where: { name_state: { name: opts.cityName, state: opts.state } },
    update: {},
    create: { name: opts.cityName, state: opts.state },
  });

  const branch = await prisma.branch.upsert({
    where: { cityId: city.id },
    update: {},
    create: {
      name: opts.branchName,
      cityId: city.id,
      address: opts.address,
      pincode: opts.pincode,
      latitude: opts.latitude,
      longitude: opts.longitude,
    },
  });

  return { city, branch };
}

//////////////////////////////////////////////////////
// USERS
//////////////////////////////////////////////////////

async function ensureUser(opts: {
  role: 'USER' | 'PROFESSIONAL';
  fullName: string;
  phone: string;
  email?: string;
  gender?: 'MALE' | 'FEMALE' | 'OTHER';
}) {
  const identifier = normPhone(opts.phone);

  const existing = await prisma.userAuth.findFirst({
    where: { identifier },
    include: { user: true },
  });
  if (existing) return existing.user;

  return prisma.user.create({
    data: {
      role: opts.role,
      isActive: true,
      lastActiveAt: new Date(),
      profile: {
        create: {
          fullName: opts.fullName,
          email: opts.email,
          gender: opts.gender,
        },
      },
      authMethods: {
        create: [
          {
            provider: 'PHONE_OTP',
            identifierType: 'PHONE',
            identifier,
            isVerified: true,
            isPrimary: true,
          },
          ...(opts.email
            ? [
                {
                  provider: 'EMAIL_OTP' as const,
                  identifierType: 'EMAIL' as const,
                  identifier: opts.email,
                  isVerified: true,
                  isPrimary: false,
                },
              ]
            : []),
        ],
      },
    },
  });
}

//////////////////////////////////////////////////////
// PROFESSIONALS
//////////////////////////////////////////////////////

type ProfessionalSeed = {
  fullName: string;
  phone: string;
  email?: string;
  bio: string;
  experienceYears: number;
  verificationStatus: 'PENDING' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
  availabilityStatus: 'ONLINE' | 'OFFLINE' | 'BUSY';
  serviceRadiusKm: number;
  latOffset: number;
  lngOffset: number;
  services: string[];
  rating?: { average: number; count: number };
  jobsCompleted?: number;
};

async function ensureProfessional(
  seed: ProfessionalSeed,
  branchId: string,
  branchLat: number,
  branchLng: number,
  adminUserId: string,
  serviceIdByName: Map<string, string>,
) {
  const user = await ensureUser({
    role: 'PROFESSIONAL',
    fullName: seed.fullName,
    phone: seed.phone,
    email: seed.email,
  });

  const needsVerification = seed.verificationStatus !== 'PENDING';

  const profile = await prisma.professionalProfile.upsert({
    where: { userId: user.id },
    update: {},
    create: {
      userId: user.id,
      displayName: seed.fullName,
      bio: seed.bio,
      experienceYears: seed.experienceYears,
      verificationStatus: seed.verificationStatus,
      verificationNote:
        seed.verificationStatus === 'REJECTED'
          ? 'Submitted ID proof photo is blurry — please re-upload a clearer copy.'
          : seed.verificationStatus === 'SUSPENDED'
            ? 'Multiple customer complaints about missed appointments.'
            : needsVerification
              ? 'Documents verified, profile looks good.'
              : null,
      verifiedAt: needsVerification ? new Date() : null,
      verifiedById: needsVerification ? adminUserId : null,
      availabilityStatus: seed.availabilityStatus,
      availabilityUpdatedAt: new Date(),
      latitude: branchLat + seed.latOffset,
      longitude: branchLng + seed.lngOffset,
      locationUpdatedAt: new Date(),
      serviceRadiusKm: seed.serviceRadiusKm,
      branchId,
      averageRating: seed.rating?.average,
      ratingCount: seed.rating?.count ?? 0,
      totalJobsCompleted: seed.jobsCompleted ?? 0,
    },
  });

  for (const serviceName of seed.services) {
    const serviceNodeId = serviceIdByName.get(serviceName);
    if (!serviceNodeId) continue;
    await prisma.professionalService.upsert({
      where: { professionalId_serviceNodeId: { professionalId: profile.id, serviceNodeId } },
      update: { isActive: true },
      create: { professionalId: profile.id, serviceNodeId, isActive: true },
    });
  }

  const existingDocs = await prisma.professionalDocument.count({ where: { professionalId: profile.id } });
  if (existingDocs === 0) {
    const docStatus = seed.verificationStatus === 'PENDING' ? 'PENDING' : 'APPROVED';
    await prisma.professionalDocument.createMany({
      data: [
        {
          professionalId: profile.id,
          type: 'ID_PROOF',
          status: docStatus,
          documentNumber: 'XXXX-XXXX-1234',
          reviewedById: docStatus === 'APPROVED' ? adminUserId : null,
          reviewedAt: docStatus === 'APPROVED' ? new Date() : null,
        },
        {
          professionalId: profile.id,
          type: 'ADDRESS_PROOF',
          status: docStatus,
          reviewedById: docStatus === 'APPROVED' ? adminUserId : null,
          reviewedAt: docStatus === 'APPROVED' ? new Date() : null,
        },
      ],
    });
  }

  return { user, profile };
}

//////////////////////////////////////////////////////
// ADDRESSES
//////////////////////////////////////////////////////

async function ensureAddress(
  userId: string,
  branchLat: number,
  branchLng: number,
  locality: string,
  cityId: string,
  state: string,
  pincode: string,
) {
  const existing = await prisma.address.findFirst({ where: { userId } });
  if (existing) return existing;

  return prisma.address.create({
    data: {
      userId,
      label: 'HOME',
      addressLine1: `${Math.floor(Math.random() * 200) + 1}, ${locality} Main Road`,
      locality,
      cityId,
      state,
      pincode,
      latitude: branchLat + (Math.random() - 0.5) * 0.08,
      longitude: branchLng + (Math.random() - 0.5) * 0.08,
      isPrimary: true,
      isActive: true,
    },
  });
}

//////////////////////////////////////////////////////
// MAIN
//////////////////////////////////////////////////////

async function main() {
  log('Ensuring cities & branches...');
  const { city: bengaluru, branch: bengaluruBranch } = await ensureCityBranch({
    cityName: 'Bengaluru',
    state: 'Karnataka',
    branchName: 'SewaGuru Bengaluru',
    address: '100 Feet Road, Indiranagar',
    pincode: '560038',
    latitude: 12.9716,
    longitude: 77.6412,
  });
  const { city: mumbai, branch: mumbaiBranch } = await ensureCityBranch({
    cityName: 'Mumbai',
    state: 'Maharashtra',
    branchName: 'SewaGuru Mumbai',
    address: 'Linking Road, Bandra West',
    pincode: '400050',
    latitude: 19.076,
    longitude: 72.8777,
  });

  log('Ensuring a Super Admin to attribute verification/review actions to...');
  const adminIdentifier = normPhone('9999999999');
  let adminAuth = await prisma.userAuth.findFirst({ where: { identifier: adminIdentifier }, include: { user: true } });
  if (!adminAuth) {
    const adminUser = await prisma.user.create({
      data: {
        role: 'SUPER_ADMIN',
        isActive: true,
        profile: { create: { fullName: 'Seed Bot Admin' } },
        authMethods: {
          create: { provider: 'PHONE_OTP', identifierType: 'PHONE', identifier: adminIdentifier, isVerified: true, isPrimary: true },
        },
      },
    });
    adminAuth = { user: adminUser } as any;
  }
  const adminUserId = adminAuth!.user.id;

  log('Loading service catalog...');
  const services = await prisma.serviceNode.findMany({ where: { type: 'SERVICE', isBookable: true } });
  const serviceIdByName = new Map(services.map((s) => [s.name, s.id]));
  if (services.length === 0) {
    throw new Error('No services found — run `npm run seed:services` first.');
  }

  log('Ensuring professionals...');
  const professionalSeeds: ProfessionalSeed[] = [
    {
      fullName: 'Priya Sharma',
      phone: '9810000001',
      email: 'priya.sharma.pro@example.com',
      bio: 'Certified beautician with 6 years of experience in facials and skin treatments.',
      experienceYears: 6,
      verificationStatus: 'APPROVED',
      availabilityStatus: 'ONLINE',
      serviceRadiusKm: 15,
      latOffset: 0.01,
      lngOffset: 0.01,
      services: ['Cleanup (Face & Neck)', 'Fruit Facial', 'Wine Facial', 'D-Tan Facial'],
      rating: { average: 4.8, count: 42 },
      jobsCompleted: 58,
    },
    {
      fullName: 'Anjali Rao',
      phone: '9810000002',
      email: 'anjali.rao.pro@example.com',
      bio: 'Specialist hairstylist offering haircuts, threading, and waxing at your doorstep.',
      experienceYears: 4,
      verificationStatus: 'APPROVED',
      availabilityStatus: 'ONLINE',
      serviceRadiusKm: 12,
      latOffset: -0.015,
      lngOffset: 0.02,
      services: ['U Cut', 'Layer Cut', 'Eyebrows Threading', 'Full Face Threading'],
      rating: { average: 4.6, count: 31 },
      jobsCompleted: 40,
    },
    {
      fullName: 'Kavya Reddy',
      phone: '9810000003',
      bio: 'Bridal makeup artist with a portfolio of 100+ weddings.',
      experienceYears: 8,
      verificationStatus: 'APPROVED',
      availabilityStatus: 'BUSY',
      serviceRadiusKm: 20,
      latOffset: 0.02,
      lngOffset: -0.01,
      services: ['Bridal Makeup', 'Airbrush Makeup', 'Smokey Eye Look'],
      rating: { average: 4.9, count: 67 },
      jobsCompleted: 81,
    },
    {
      fullName: 'Sunita Devi',
      phone: '9820000004',
      bio: 'Manicure and pedicure specialist, Mumbai based.',
      experienceYears: 3,
      verificationStatus: 'APPROVED',
      availabilityStatus: 'OFFLINE',
      serviceRadiusKm: 10,
      latOffset: 0.01,
      lngOffset: 0.01,
      services: ['Pedicure', 'Manicure', 'Half Hands Waxing'],
      rating: { average: 4.3, count: 15 },
      jobsCompleted: 19,
    },
    {
      fullName: 'Meena Iyer',
      phone: '9810000005',
      bio: 'Newly registered — awaiting document review.',
      experienceYears: 1,
      verificationStatus: 'PENDING',
      availabilityStatus: 'OFFLINE',
      serviceRadiusKm: 10,
      latOffset: -0.01,
      lngOffset: -0.01,
      services: ['Cleanup (Face & Neck)', 'Eyebrows Threading'],
    },
    {
      fullName: 'Radha Krishnan',
      phone: '9810000006',
      bio: 'Application currently under review by the verification team.',
      experienceYears: 2,
      verificationStatus: 'UNDER_REVIEW',
      availabilityStatus: 'OFFLINE',
      serviceRadiusKm: 10,
      latOffset: 0.005,
      lngOffset: -0.02,
      services: ['Full Legs Waxing', 'Full Hands Waxing'],
    },
    {
      fullName: 'Fatima Khan',
      phone: '9810000007',
      bio: 'Application rejected — documentation issue.',
      experienceYears: 1,
      verificationStatus: 'REJECTED',
      availabilityStatus: 'OFFLINE',
      serviceRadiusKm: 10,
      latOffset: -0.02,
      lngOffset: 0.005,
      services: ['Nude Makeup'],
    },
    {
      fullName: 'Geeta Nair',
      phone: '9810000008',
      bio: 'Currently suspended pending investigation.',
      experienceYears: 5,
      verificationStatus: 'SUSPENDED',
      availabilityStatus: 'OFFLINE',
      serviceRadiusKm: 10,
      latOffset: 0.02,
      lngOffset: 0.02,
      services: ['Silver Facial', 'Gold Facial'],
      rating: { average: 3.9, count: 22 },
      jobsCompleted: 25,
    },
  ];

  const professionals: { user: any; profile: any; seed: ProfessionalSeed }[] = [];
  for (const seed of professionalSeeds) {
    const isMumbai = seed.phone.startsWith('982');
    const branch = isMumbai ? mumbaiBranch : bengaluruBranch;
    const result = await ensureProfessional(
      seed,
      branch.id,
      branch.latitude,
      branch.longitude,
      adminUserId,
      serviceIdByName,
    );
    professionals.push({ ...result, seed });
    log(`  professional: ${seed.fullName} (${seed.verificationStatus}/${seed.availabilityStatus})`);
  }

  log('Ensuring customers...');
  const customerSeeds = [
    { fullName: 'Rahul Verma', phone: '9900000001', email: 'rahul.verma@example.com', locality: 'Koramangala', branch: bengaluruBranch, city: bengaluru },
    { fullName: 'Sneha Patel', phone: '9900000002', email: 'sneha.patel@example.com', locality: 'Indiranagar', branch: bengaluruBranch, city: bengaluru },
    { fullName: 'Amit Joshi', phone: '9900000003', locality: 'Whitefield', branch: bengaluruBranch, city: bengaluru },
    { fullName: 'Divya Menon', phone: '9900000004', email: 'divya.menon@example.com', locality: 'HSR Layout', branch: bengaluruBranch, city: bengaluru },
    { fullName: 'Karan Malhotra', phone: '9900000005', locality: 'Bandra West', branch: mumbaiBranch, city: mumbai },
    { fullName: 'Pooja Nair', phone: '9900000006', email: 'pooja.nair@example.com', locality: 'Andheri West', branch: mumbaiBranch, city: mumbai },
  ];

  const customers: { user: any; addressId: string; branchId: string }[] = [];
  for (const seed of customerSeeds) {
    const user = await ensureUser({ role: 'USER', fullName: seed.fullName, phone: seed.phone, email: seed.email });
    const address = await ensureAddress(
      user.id,
      seed.branch.latitude,
      seed.branch.longitude,
      seed.locality,
      seed.city.id,
      seed.city.state,
      seed.branch.pincode,
    );
    customers.push({ user, addressId: address.id, branchId: seed.branch.id });
    log(`  customer: ${seed.fullName}`);
  }

  //////////////////////////////////////////////////////
  // BOOKINGS
  //////////////////////////////////////////////////////

  const existingBookingCount = await prisma.booking.count({ where: { displayId: { startsWith: 'SWD' } } });
  if (existingBookingCount > 0) {
    log(`Skipping booking/review/earning seed — ${existingBookingCount} seeded bookings already exist.`);
  } else {
    log('Creating bookings across the full lifecycle...');

    const approvedProfessionals = professionals.filter((p) => p.seed.verificationStatus === 'APPROVED');

    const pickService = (name: string) => {
      const id = serviceIdByName.get(name);
      if (!id) throw new Error(`Service not found: ${name}`);
      const node = services.find((s) => s.id === id)!;
      return node;
    };

    const daysFromNow = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    type BookingSeed = {
      displaySuffix: string;
      customer: (typeof customers)[number];
      serviceName: string;
      status: string;
      paymentStatus: string;
      dispatchStatus: string;
      scheduledAt: Date;
      createdAt: Date;
      professional?: (typeof professionals)[number];
      assigned?: boolean;
      timeline: { status?: string; paymentStatus?: string; message: string; offsetMinutes: number }[];
    };

    const bookingSeeds: BookingSeed[] = [
      {
        displaySuffix: '0001',
        customer: customers[0],
        serviceName: 'Cleanup (Face & Neck)',
        status: 'CREATED',
        paymentStatus: 'PENDING',
        dispatchStatus: 'NOT_DISPATCHED',
        scheduledAt: daysFromNow(3),
        createdAt: new Date(),
        timeline: [{ status: 'CREATED', message: 'Booking created', offsetMinutes: 0 }],
      },
      {
        displaySuffix: '0002',
        customer: customers[1],
        serviceName: 'Fruit Facial',
        status: 'BOOKED',
        paymentStatus: 'PAID',
        dispatchStatus: 'OFFERS_SENT',
        scheduledAt: daysFromNow(2),
        createdAt: new Date(Date.now() - 20 * 60 * 1000),
        timeline: [
          { status: 'CREATED', paymentStatus: 'PENDING', message: 'Booking created', offsetMinutes: 0 },
          { paymentStatus: 'PAID', message: 'Payment received', offsetMinutes: 2 },
        ],
      },
      {
        displaySuffix: '0003',
        customer: customers[2],
        serviceName: 'U Cut',
        status: 'BOOKED',
        paymentStatus: 'PAID',
        dispatchStatus: 'NO_ELIGIBLE_PROFESSIONALS',
        scheduledAt: daysFromNow(1),
        createdAt: new Date(Date.now() - 90 * 60 * 1000),
        timeline: [
          { status: 'CREATED', paymentStatus: 'PENDING', message: 'Booking created', offsetMinutes: 0 },
          { paymentStatus: 'PAID', message: 'Payment received', offsetMinutes: 3 },
        ],
      },
      {
        displaySuffix: '0004',
        customer: customers[3],
        serviceName: 'Eyebrows Threading',
        status: 'TECHNICIAN_ASSIGNED',
        paymentStatus: 'PAID',
        dispatchStatus: 'ASSIGNED',
        scheduledAt: daysFromNow(1),
        createdAt: new Date(Date.now() - 60 * 60 * 1000),
        professional: approvedProfessionals[1],
        assigned: true,
        timeline: [
          { status: 'CREATED', paymentStatus: 'PENDING', message: 'Booking created', offsetMinutes: 0 },
          { paymentStatus: 'PAID', message: 'Payment received', offsetMinutes: 2 },
          { status: 'TECHNICIAN_ASSIGNED', message: 'A professional accepted and was assigned.', offsetMinutes: 15 },
        ],
      },
      {
        displaySuffix: '0005',
        customer: customers[0],
        serviceName: 'Wine Facial',
        status: 'TECHNICIAN_EN_ROUTE',
        paymentStatus: 'PAID',
        dispatchStatus: 'ASSIGNED',
        scheduledAt: new Date(),
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
        professional: approvedProfessionals[0],
        assigned: true,
        timeline: [
          { status: 'CREATED', paymentStatus: 'PENDING', message: 'Booking created', offsetMinutes: 0 },
          { paymentStatus: 'PAID', message: 'Payment received', offsetMinutes: 2 },
          { status: 'TECHNICIAN_ASSIGNED', message: 'A professional accepted and was assigned.', offsetMinutes: 20 },
          { status: 'TECHNICIAN_EN_ROUTE', message: 'Professional started traveling to the location.', offsetMinutes: 150 },
        ],
      },
      {
        displaySuffix: '0006',
        customer: customers[4],
        serviceName: 'Pedicure',
        status: 'TECHNICIAN_ARRIVED',
        paymentStatus: 'PAID',
        dispatchStatus: 'ASSIGNED',
        scheduledAt: new Date(),
        createdAt: new Date(Date.now() - 4 * 60 * 60 * 1000),
        professional: approvedProfessionals[3],
        assigned: true,
        timeline: [
          { status: 'CREATED', paymentStatus: 'PENDING', message: 'Booking created', offsetMinutes: 0 },
          { paymentStatus: 'PAID', message: 'Payment received', offsetMinutes: 2 },
          { status: 'TECHNICIAN_ASSIGNED', message: 'A professional accepted and was assigned.', offsetMinutes: 20 },
          { status: 'TECHNICIAN_EN_ROUTE', message: 'Professional started traveling to the location.', offsetMinutes: 200 },
          { status: 'TECHNICIAN_ARRIVED', message: 'Professional arrived at the location.', offsetMinutes: 230 },
        ],
      },
      {
        displaySuffix: '0007',
        customer: customers[5],
        serviceName: 'Bridal Makeup',
        status: 'WORK_IN_PROGRESS',
        paymentStatus: 'PAID',
        dispatchStatus: 'ASSIGNED',
        scheduledAt: new Date(),
        createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
        professional: approvedProfessionals[2],
        assigned: true,
        timeline: [
          { status: 'CREATED', paymentStatus: 'PENDING', message: 'Booking created', offsetMinutes: 0 },
          { paymentStatus: 'PAID', message: 'Payment received', offsetMinutes: 2 },
          { status: 'TECHNICIAN_ASSIGNED', message: 'A professional accepted and was assigned.', offsetMinutes: 20 },
          { status: 'TECHNICIAN_EN_ROUTE', message: 'Professional started traveling to the location.', offsetMinutes: 200 },
          { status: 'TECHNICIAN_ARRIVED', message: 'Professional arrived at the location.', offsetMinutes: 230 },
          { status: 'WORK_IN_PROGRESS', message: 'Professional started the work.', offsetMinutes: 240 },
        ],
      },
      // Completed bookings (for earnings/reviews)
      ...([0, 1, 2, 3] as const).map((i) => ({
        displaySuffix: `010${i}`,
        customer: customers[i % customers.length],
        serviceName: ['Silver Facial', 'Layer Cut', 'Manicure', 'D-Tan Facial'][i],
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        dispatchStatus: 'ASSIGNED',
        scheduledAt: new Date(Date.now() - (i + 2) * 24 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - (i + 3) * 24 * 60 * 60 * 1000),
        professional: approvedProfessionals[i % approvedProfessionals.length],
        assigned: true,
        timeline: [
          { status: 'CREATED', paymentStatus: 'PENDING', message: 'Booking created', offsetMinutes: 0 },
          { paymentStatus: 'PAID', message: 'Payment received', offsetMinutes: 2 },
          { status: 'TECHNICIAN_ASSIGNED', message: 'A professional accepted and was assigned.', offsetMinutes: 20 },
          { status: 'TECHNICIAN_EN_ROUTE', message: 'Professional started traveling to the location.', offsetMinutes: 200 },
          { status: 'TECHNICIAN_ARRIVED', message: 'Professional arrived at the location.', offsetMinutes: 230 },
          { status: 'WORK_IN_PROGRESS', message: 'Professional started the work.', offsetMinutes: 240 },
          { status: 'COMPLETED', message: 'Professional marked the work as completed.', offsetMinutes: 300 },
        ],
      })),
      {
        displaySuffix: '0201',
        customer: customers[1],
        serviceName: 'Full Face Threading',
        status: 'CANCELLED',
        paymentStatus: 'REFUNDED',
        dispatchStatus: 'CANCELLED',
        scheduledAt: daysFromNow(-1),
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        timeline: [
          { status: 'CREATED', paymentStatus: 'PENDING', message: 'Booking created', offsetMinutes: 0 },
          { paymentStatus: 'PAID', message: 'Payment received', offsetMinutes: 2 },
          { status: 'CANCELLED', paymentStatus: 'REFUNDED', message: 'Cancelled by customer: Change of plans.', offsetMinutes: 60 },
        ],
      },
      {
        displaySuffix: '0202',
        customer: customers[2],
        serviceName: 'Half Legs Waxing',
        status: 'CREATED',
        paymentStatus: 'FAILED',
        dispatchStatus: 'NOT_DISPATCHED',
        scheduledAt: daysFromNow(2),
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
        timeline: [
          { status: 'CREATED', paymentStatus: 'PENDING', message: 'Booking created', offsetMinutes: 0 },
          { paymentStatus: 'FAILED', message: 'Payment attempt failed (card declined).', offsetMinutes: 5 },
        ],
      },
    ];

    let seq = 1;
    for (const b of bookingSeeds) {
      const service = pickService(b.serviceName);
      const price = service.defaultPrice ?? 500;
      const tax = Math.round(price * 0.05 * 100) / 100;
      const total = price + tax;

      const address = await prisma.address.findUnique({
        where: { id: b.customer.addressId },
        include: { city: true },
      });

      const booking = await prisma.booking.create({
        data: {
          displayId: `SWD${b.displaySuffix}`,
          userId: b.customer.user.id,
          branchId: b.customer.branchId,
          addressId: b.customer.addressId,
          status: b.status as any,
          paymentStatus: b.paymentStatus as any,
          dispatchStatus: b.dispatchStatus as any,
          dispatchedAt: b.dispatchStatus !== 'NOT_DISPATCHED' ? b.createdAt : null,
          dispatchAttempts: b.dispatchStatus !== 'NOT_DISPATCHED' ? 1 : 0,
          assignedProfessionalId: b.assigned ? b.professional!.profile.id : null,
          assignedAt: b.assigned ? new Date(b.createdAt.getTime() + 20 * 60 * 1000) : null,
          scheduledAt: b.scheduledAt,
          createdAt: b.createdAt,
          subtotal: price,
          taxAmount: tax,
          discountAmount: 0,
          totalAmount: total,
          addressSnapshot: address
            ? ({
                addressLine1: address.addressLine1,
                locality: address.locality,
                city: { name: address.city?.name ?? null, state: address.state },
                pincode: address.pincode,
              } as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          items: {
            create: [
              {
                serviceNodeId: service.id,
                price,
                quantity: 1,
                lineTotal: price,
                serviceSnapshot: { name: service.name, slug: service.slug } as Prisma.InputJsonValue,
              },
            ],
          },
          timeline: {
            create: b.timeline.map((t) => ({
              status: t.status as any,
              paymentStatus: t.paymentStatus as any,
              message: t.message,
              createdAt: new Date(b.createdAt.getTime() + t.offsetMinutes * 60 * 1000),
            })),
          },
        },
        include: { items: true },
      });

      log(`  booking ${booking.displayId} (${b.status}/${b.paymentStatus}/${b.dispatchStatus})`);
      seq++;

      // Reviews + earnings for completed bookings
      if (b.status === 'COMPLETED' && b.professional) {
        await prisma.serviceReview.create({
          data: {
            bookingId: booking.id,
            bookingItemId: booking.items[0]!.id,
            userId: b.customer.user.id,
            serviceNodeId: service.id,
            professionalId: b.professional.profile.id,
            rating: [5, 4, 5, 3][seq % 4] ?? 5,
            comment: [
              'Excellent service, very professional and on time!',
              'Good work, would book again.',
              'Loved the results, highly recommend.',
              'Service was okay, arrived a bit late.',
            ][seq % 4],
          },
        });

        const grossAmount = total;
        const platformFeeAmount = Math.round(grossAmount * 0.2 * 100) / 100;
        const netAmount = Math.round((grossAmount - platformFeeAmount) * 100) / 100;

        await prisma.professionalEarning.upsert({
          where: { professionalId_bookingId: { professionalId: b.professional.profile.id, bookingId: booking.id } },
          update: {},
          create: {
            professionalId: b.professional.profile.id,
            bookingId: booking.id,
            grossAmount,
            platformFeeAmount,
            netAmount,
            status: seq % 2 === 0 ? 'PAYABLE' : 'PAID',
          },
        });
      }
    }
  }

  //////////////////////////////////////////////////////
  // PAYOUT (one, for the first approved professional with PAID earnings)
  //////////////////////////////////////////////////////

  const firstApproved = professionals.find((p) => p.seed.verificationStatus === 'APPROVED');
  if (firstApproved) {
    const existingPayout = await prisma.payout.findFirst({ where: { professionalId: firstApproved.profile.id } });
    if (!existingPayout) {
      const paidEarnings = await prisma.professionalEarning.findMany({
        where: { professionalId: firstApproved.profile.id, status: 'PAID', payoutId: null },
      });
      if (paidEarnings.length > 0) {
        const amount = paidEarnings.reduce((sum, e) => sum + e.netAmount, 0);
        const payout = await prisma.payout.create({
          data: {
            professionalId: firstApproved.profile.id,
            amount,
            status: 'PAID',
            reference: 'UTR-SEED-000123456789',
            processedAt: new Date(),
          },
        });
        await prisma.professionalEarning.updateMany({
          where: { id: { in: paidEarnings.map((e) => e.id) } },
          data: { payoutId: payout.id },
        });
        log(`Created payout of ₹${amount} for ${firstApproved.seed.fullName}`);
      }
    }
  }

  log('Done.');
}

main()
  .catch((err) => {
    console.error('Seeding failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
