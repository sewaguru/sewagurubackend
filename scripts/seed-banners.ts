import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

/**
 * Seeds a handful of dummy homepage banners so the new Banner CMS has
 * something to show immediately. Prefers real images already uploaded to
 * the Media library (dashboard -> Media); only falls back to Unsplash stock
 * photos (already whitelisted in sewaguru/next.config.ts) if the library is
 * empty. Skips entirely if any banners already exist, so it's safe to run
 * more than once and won't clobber real banners created via the dashboard.
 */
const connectionString = process.env.DATABASE_URL!;
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const FALLBACK_IMAGES = [
  'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1600&h=700&fit=crop',
  'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?w=1600&h=700&fit=crop',
  'https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?w=1600&h=700&fit=crop',
];

const DUMMY_COPY = [
  {
    title: 'Transform Your Home Today',
    subtitle: 'Book trusted interior design & renovation experts near you.',
    ctaLabel: 'Explore Services',
    linkUrl: '/services',
  },
  {
    title: 'Flat 20% Off Deep Cleaning',
    subtitle: 'Professional home cleaning, sanitised and doorstep-ready.',
    ctaLabel: 'Book Now',
    linkUrl: '/services',
  },
  {
    title: 'AC Service Starting ₹399',
    subtitle: 'Beat the heat with certified AC repair & maintenance.',
    ctaLabel: 'Get Started',
    linkUrl: '/services',
  },
];

async function main() {
  const existingCount = await prisma.banner.count();
  if (existingCount > 0) {
    console.log(
      `Skipped: ${existingCount} banner(s) already exist. Delete them from the dashboard first if you want to reseed.`
    );
    return;
  }

  const media = await prisma.media.findMany({
    orderBy: { createdAt: 'desc' },
    take: DUMMY_COPY.length,
    select: { url: true },
  });

  const images =
    media.length > 0 ? media.map((m) => m.url) : FALLBACK_IMAGES;

  if (media.length > 0) {
    console.log(`Using ${media.length} image(s) from the Media library.`);
  } else {
    console.log(
      'No media found in the library yet — using placeholder stock photos instead. ' +
        'Upload real images via Dashboard -> Media and edit these banners to swap them in.'
    );
  }

  let sortOrder = 0;
  for (const copy of DUMMY_COPY) {
    const imageUrl = images[sortOrder % images.length];
    await prisma.banner.create({
      data: {
        ...copy,
        imageUrl,
        isActive: true,
        sortOrder,
      },
    });
    console.log(`  [OK] ${copy.title}`);
    sortOrder += 1;
  }

  console.log(`Seeding complete. ${DUMMY_COPY.length} banner(s) created.`);
}

main()
  .catch((err: unknown) => {
    console.error('Seeding failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
