import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

/**
 * Seeds the homepage CMS (hero banners, promo tiles, testimonials) using
 * REAL data already in this database: real category images (resolved via
 * the Media table), real category names/slugs for links, and the one real
 * customer review that currently has a comment. Does not fabricate fake
 * customer testimonials. Skips each section independently if it already
 * has content, so it's safe to re-run.
 */
const connectionString = process.env.DATABASE_URL!;
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

async function resolveImage(mediaId: string | null): Promise<string | null> {
  if (!mediaId) return null;
  const media = await prisma.media.findUnique({
    where: { id: mediaId },
    select: { url: true },
  });
  return media?.url ?? null;
}

async function seedHeroBanners() {
  const existing = await prisma.banner.count({ where: { size: 'HERO' } });
  if (existing > 0) {
    console.log(`Skipped hero banners: ${existing} already exist.`);
    return;
  }

  const picks = [
    {
      slug: 'interior-design',
      title: 'Transform Your Space',
      subtitle: 'Complete interior design & renovation solutions, done right.',
      ctaLabel: 'Explore Interior Design',
    },
    {
      slug: 'bridal-and-groom-makeup',
      title: 'Look Your Best on Your Big Day',
      subtitle: 'Professional bridal & groom makeup artists at your doorstep.',
      ctaLabel: 'Book Now',
    },
    {
      slug: 'house-keeping-cleaning-services',
      title: 'Spotless Homes, Every Time',
      subtitle: 'Trusted home cleaning professionals near you.',
      ctaLabel: 'Book Cleaning',
    },
  ];

  let sortOrder = 0;
  for (const pick of picks) {
    const node = await prisma.serviceNode.findUnique({
      where: { slug: pick.slug },
      select: { iconUrl: true },
    });
    const imageUrl = await resolveImage(node?.iconUrl ?? null);
    if (!imageUrl) {
      console.log(`  [SKIP] ${pick.slug} — no image found`);
      continue;
    }

    await prisma.banner.create({
      data: {
        size: 'HERO',
        title: pick.title,
        subtitle: pick.subtitle,
        ctaLabel: pick.ctaLabel,
        linkUrl: `/services/${pick.slug}`,
        imageUrl,
        isActive: true,
        sortOrder,
      },
    });
    console.log(`  [OK] hero banner: ${pick.title}`);
    sortOrder += 1;
  }
}

async function seedGridBanners() {
  const existing = await prisma.banner.count({ where: { size: 'GRID' } });
  if (existing > 0) {
    console.log(`Skipped promo tiles: ${existing} already exist.`);
    return;
  }

  const picks = [
    {
      slug: 'ac',
      title: 'AC Service & Repair',
      subtitle: 'Keep cool all summer with certified technicians.',
      ctaLabel: 'Book Now',
    },
    {
      slug: 'facial-and-skin-care',
      title: 'Facial & Skin Care',
      subtitle: 'Glow with expert treatments at home.',
      ctaLabel: 'View Services',
    },
    {
      slug: 'painting',
      title: 'Painting Services',
      subtitle: 'Fresh coat, expert finish, on schedule.',
      ctaLabel: 'Get Started',
    },
  ];

  let sortOrder = 0;
  for (const pick of picks) {
    const node = await prisma.serviceNode.findUnique({
      where: { slug: pick.slug },
      select: { iconUrl: true },
    });
    const imageUrl = await resolveImage(node?.iconUrl ?? null);
    if (!imageUrl) {
      console.log(`  [SKIP] ${pick.slug} — no image found`);
      continue;
    }

    await prisma.banner.create({
      data: {
        size: 'GRID',
        title: pick.title,
        subtitle: pick.subtitle,
        ctaLabel: pick.ctaLabel,
        linkUrl: `/services/${pick.slug}`,
        imageUrl,
        isActive: true,
        sortOrder,
      },
    });
    console.log(`  [OK] promo tile: ${pick.title}`);
    sortOrder += 1;
  }
}

async function seedSpotlightBanners() {
  const existing = await prisma.banner.count({ where: { size: 'SPOTLIGHT' } });
  if (existing > 0) {
    console.log(`Skipped spotlight slider: ${existing} already exist.`);
    return;
  }

  const picks = [
    {
      slug: 'boutique',
      title: 'Boutique Styling',
      subtitle: 'Curated fashion & styling services.',
      ctaLabel: 'Discover',
    },
    {
      slug: 'car-wash-at-your-doorstep',
      title: 'Car Wash at Your Doorstep',
      subtitle: 'Sparkling clean, without leaving home.',
      ctaLabel: 'Book Now',
    },
    {
      slug: 'water-proofing-solutions',
      title: 'Water Proofing Solutions',
      subtitle: 'Protect your home before the next monsoon.',
      ctaLabel: 'Get a Quote',
    },
    {
      slug: 'event-management',
      title: 'Event Management',
      subtitle: 'End-to-end planning for every occasion.',
      ctaLabel: 'Plan Now',
    },
  ];

  let sortOrder = 0;
  for (const pick of picks) {
    const node = await prisma.serviceNode.findUnique({
      where: { slug: pick.slug },
      select: { iconUrl: true },
    });
    const imageUrl = await resolveImage(node?.iconUrl ?? null);
    if (!imageUrl) {
      console.log(`  [SKIP] ${pick.slug} — no image found`);
      continue;
    }

    await prisma.banner.create({
      data: {
        size: 'SPOTLIGHT',
        title: pick.title,
        subtitle: pick.subtitle,
        ctaLabel: pick.ctaLabel,
        linkUrl: `/services/${pick.slug}`,
        imageUrl,
        isActive: true,
        sortOrder,
      },
    });
    console.log(`  [OK] spotlight: ${pick.title}`);
    sortOrder += 1;
  }
}

async function seedRealTestimonials() {
  const existing = await prisma.testimonial.count();
  if (existing > 0) {
    console.log(`Skipped testimonials: ${existing} already exist.`);
    return;
  }

  const reviews = await prisma.serviceReview.findMany({
    where: { isVisible: true, comment: { not: null } },
    orderBy: [{ rating: 'desc' }, { createdAt: 'desc' }],
    select: {
      rating: true,
      comment: true,
      user: {
        select: { profile: { select: { fullName: true, profileImageUrl: true } } },
      },
      serviceNode: { select: { name: true } },
      booking: { select: { addressSnapshot: true } },
    },
  });

  if (reviews.length === 0) {
    console.log('Skipped testimonials: no real reviews with comments found.');
    return;
  }

  let sortOrder = 0;
  for (const review of reviews) {
    const name = review.user.profile?.fullName?.trim();
    if (!name || !review.comment) continue;

    const addressSnapshot = review.booking.addressSnapshot as
      | { city?: { name?: string } }
      | null;
    const cityName = addressSnapshot?.city?.name;
    const customerRole = [cityName, review.serviceNode.name]
      .filter(Boolean)
      .join(' · ');

    await prisma.testimonial.create({
      data: {
        customerName: name,
        customerRole: customerRole || null,
        avatarUrl: review.user.profile?.profileImageUrl ?? null,
        quote: review.comment,
        rating: review.rating,
        isActive: true,
        sortOrder,
      },
    });
    console.log(`  [OK] real testimonial: ${name}`);
    sortOrder += 1;
  }

  console.log(
    `Seeded ${sortOrder} real testimonial(s). Only reviews with a written comment qualify — ` +
      'more will appear here as customers leave feedback.'
  );
}

async function main() {
  await seedHeroBanners();
  await seedGridBanners();
  await seedSpotlightBanners();
  await seedRealTestimonials();
  console.log('Done.');
}

main()
  .catch((err) => {
    console.error('Seeding failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
