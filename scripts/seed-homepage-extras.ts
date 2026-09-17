import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

/**
 * Seeds dummy GRID-size promo banners and customer testimonials so the
 * newly expanded homepage CMS has something to show in every section.
 * Companion to seed-banners.ts (which only seeds HERO banners). Prefers
 * real images from the Media library; falls back to Unsplash stock photos
 * (whitelisted in sewaguru/next.config.ts) if none exist. Each part is
 * skipped independently if that data already exists, so it's safe to
 * re-run and won't clobber real content created via the dashboard.
 */
const connectionString = process.env.DATABASE_URL!;
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const GRID_FALLBACK_IMAGES = [
  'https://images.unsplash.com/photo-1581578731548-c64695cc6952?w=900&h=700&fit=crop',
  'https://images.unsplash.com/photo-1584622781564-1d987f7333c1?w=900&h=700&fit=crop',
  'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?w=900&h=700&fit=crop',
];

const GRID_COPY = [
  {
    title: 'Interior Design',
    subtitle: 'Full-home makeovers by certified designers',
    ctaLabel: 'View Plans',
    linkUrl: '/services',
  },
  {
    title: 'Painting Services',
    subtitle: 'Premium finishes, on schedule',
    ctaLabel: 'Get a Quote',
    linkUrl: '/services',
  },
  {
    title: 'Pest Control',
    subtitle: 'Safe, effective, guaranteed',
    ctaLabel: 'Book Now',
    linkUrl: '/services',
  },
];

const AVATAR_FALLBACK_IMAGES = [
  'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200&h=200&fit=crop',
  'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=200&h=200&fit=crop',
  'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200&h=200&fit=crop',
  'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=200&h=200&fit=crop',
];

const TESTIMONIALS = [
  {
    customerName: 'Priya Sharma',
    customerRole: 'Bengaluru',
    quote:
      'The team transformed our living room in just a week. Professional, punctual, and the quality exceeded what we expected.',
    rating: 5,
  },
  {
    customerName: 'Rahul Verma',
    customerRole: 'Hyderabad',
    quote:
      'Booked an AC service through the app — technician arrived on time and fixed the issue in under an hour. Very smooth experience.',
    rating: 5,
  },
  {
    customerName: 'Anjali Menon',
    customerRole: 'Ballari',
    quote:
      'Great value for money on our deep cleaning package. Will definitely be booking again for our next home.',
    rating: 4,
  },
  {
    customerName: 'Vikram Singh',
    customerRole: 'Bengaluru',
    quote:
      'From consultation to final handover, the interior design process was transparent and stress-free.',
    rating: 5,
  },
];

async function seedGridBanners() {
  const existingCount = await prisma.banner.count({
    where: { size: 'GRID' },
  });
  if (existingCount > 0) {
    console.log(
      `Skipped promo tiles: ${existingCount} GRID banner(s) already exist.`
    );
    return;
  }

  const media = await prisma.media.findMany({
    orderBy: { createdAt: 'desc' },
    take: GRID_COPY.length,
    select: { url: true },
  });

  const images =
    media.length > 0 ? media.map((m) => m.url) : GRID_FALLBACK_IMAGES;

  let sortOrder = 0;
  for (const copy of GRID_COPY) {
    const imageUrl = images[sortOrder % images.length];
    await prisma.banner.create({
      data: {
        ...copy,
        size: 'GRID',
        imageUrl,
        isActive: true,
        sortOrder,
      },
    });
    console.log(`  [OK] promo tile: ${copy.title}`);
    sortOrder += 1;
  }
}

async function seedTestimonials() {
  const existingCount = await prisma.testimonial.count();
  if (existingCount > 0) {
    console.log(
      `Skipped testimonials: ${existingCount} already exist.`
    );
    return;
  }

  let sortOrder = 0;
  for (const testimonial of TESTIMONIALS) {
    await prisma.testimonial.create({
      data: {
        ...testimonial,
        avatarUrl: AVATAR_FALLBACK_IMAGES[sortOrder % AVATAR_FALLBACK_IMAGES.length],
        isActive: true,
        sortOrder,
      },
    });
    console.log(`  [OK] testimonial: ${testimonial.customerName}`);
    sortOrder += 1;
  }
}

async function main() {
  await seedGridBanners();
  await seedTestimonials();
  console.log('Seeding complete.');
}

main()
  .catch((err: unknown) => {
    console.error('Seeding failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
