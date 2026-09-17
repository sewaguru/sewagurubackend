import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

const connectionString = process.env.DATABASE_URL!;
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

interface ServiceSeed {
  name: string;
  slug: string;
  description: string;
  defaultPrice: number;
  durationMinutes: number;
  sortOrder: number;
}

interface CategorySeed {
  name: string;
  slug: string;
  description: string;
  sortOrder: number;
  services: ServiceSeed[];
}

const categories: CategorySeed[] = [
  {
    name: 'Facial & Skin Care',
    slug: 'facial-and-skin-care',
    description:
      'Professional facial and skin care treatments designed to rejuvenate, brighten, and nourish your skin — performed by trained beauticians at your doorstep.',
    sortOrder: 1,
    services: [
      {
        name: 'Cleanup (Face & Neck)',
        slug: 'cleanup-face-neck',
        description:
          'A deep cleansing treatment for the face and neck that removes impurities, unclogs pores, and leaves skin refreshed and naturally glowing.',
        defaultPrice: 400,
        durationMinutes: 30,
        sortOrder: 1,
      },
      {
        name: 'Fruit Facial',
        slug: 'fruit-facial',
        description:
          'Enriched with natural fruit extracts, this facial nourishes and brightens skin for a radiant, youthful appearance.',
        defaultPrice: 600,
        durationMinutes: 45,
        sortOrder: 2,
      },
      {
        name: 'Wine Facial',
        slug: 'wine-facial',
        description:
          'Infused with grape seed antioxidants, this luxurious wine facial revitalizes skin, minimizes fine lines, and enhances natural radiance.',
        defaultPrice: 1000,
        durationMinutes: 60,
        sortOrder: 3,
      },
      {
        name: 'Silver Facial',
        slug: 'silver-facial',
        description:
          'A premium silver-infused facial that detoxifies, brightens, and gives skin a healthy, luminous glow.',
        defaultPrice: 1000,
        durationMinutes: 60,
        sortOrder: 4,
      },
      {
        name: 'Pearl Facial',
        slug: 'pearl-facial',
        description:
          'Harnessing the power of pearl extracts, this facial deeply moisturizes, lightens blemishes, and imparts a flawless pearlescent skin tone.',
        defaultPrice: 1000,
        durationMinutes: 60,
        sortOrder: 5,
      },
      {
        name: 'Anti-Aging Facial',
        slug: 'anti-aging-facial',
        description:
          'A targeted treatment using advanced anti-aging ingredients to reduce wrinkles, firm skin, and restore youthful vitality.',
        defaultPrice: 1200,
        durationMinutes: 75,
        sortOrder: 6,
      },
      {
        name: 'Whitening Facial',
        slug: 'whitening-facial',
        description:
          'A brightening facial designed to lighten pigmentation, even skin tone, and reveal a clearer, more luminous complexion.',
        defaultPrice: 1000,
        durationMinutes: 60,
        sortOrder: 7,
      },
      {
        name: 'Herbal Facial',
        slug: 'herbal-facial',
        description:
          'A soothing herbal facial using natural plant extracts to calm, nourish, and rejuvenate sensitive or stressed skin.',
        defaultPrice: 650,
        durationMinutes: 60,
        sortOrder: 8,
      },
      {
        name: 'D-Tan Facial',
        slug: 'd-tan-facial',
        description:
          'An intensive de-tanning facial that removes sun-induced tan, reduces pigmentation, and restores your natural skin tone.',
        defaultPrice: 800,
        durationMinutes: 45,
        sortOrder: 9,
      },
      {
        name: 'Diamond Facial',
        slug: 'diamond-facial',
        description:
          'Our most luxurious facial using diamond microdermabrasion to exfoliate deeply, reduce scars, and deliver a diamond-like radiant glow.',
        defaultPrice: 1500,
        durationMinutes: 90,
        sortOrder: 10,
      },
      {
        name: 'Gold Facial',
        slug: 'gold-facial',
        description:
          'A regal 24K gold-infused facial that stimulates collagen, reduces inflammation, and gives skin a warm, golden luminosity.',
        defaultPrice: 1200,
        durationMinutes: 75,
        sortOrder: 11,
      },
      {
        name: 'Face Bleach',
        slug: 'face-bleach',
        description:
          'A gentle bleaching treatment that lightens facial hair and brightens skin tone for an instantly refreshed look.',
        defaultPrice: 400,
        durationMinutes: 20,
        sortOrder: 12,
      },
      {
        name: 'Face & Neck Bleach',
        slug: 'face-neck-bleach',
        description:
          'Complete bleaching for face and neck to even out tone, lighten hair, and leave skin looking bright and polished.',
        defaultPrice: 600,
        durationMinutes: 30,
        sortOrder: 13,
      },
      {
        name: 'Face Bleach + D-Tan',
        slug: 'face-bleach-d-tan',
        description:
          'Combines bleaching and de-tanning for a comprehensive treatment that brightens skin and reverses sun damage on the face.',
        defaultPrice: 800,
        durationMinutes: 45,
        sortOrder: 14,
      },
      {
        name: 'Face & Neck Bleach + D-Tan',
        slug: 'face-neck-bleach-d-tan',
        description:
          'Full face and neck bleach combined with D-Tan removal for a complete brightening and rejuvenation experience.',
        defaultPrice: 1000,
        durationMinutes: 60,
        sortOrder: 15,
      },
      {
        name: 'Full Face D-Tan',
        slug: 'full-face-d-tan',
        description:
          'Targeted de-tanning treatment for the full face to reverse sun damage and restore your natural skin tone.',
        defaultPrice: 350,
        durationMinutes: 30,
        sortOrder: 16,
      },
      {
        name: 'Hand Bleach',
        slug: 'hand-bleach',
        description:
          'Lightens and brightens hands by reducing tan lines and dark patches for softer, more even-toned skin.',
        defaultPrice: 400,
        durationMinutes: 20,
        sortOrder: 17,
      },
    ],
  },
  {
    name: 'Saloon',
    slug: 'saloon',
    description:
      'Expert salon services including haircuts, nail care, threading, and waxing — all delivered at your doorstep by skilled professionals.',
    sortOrder: 2,
    services: [
      {
        name: 'U Cut',
        slug: 'u-cut',
        description:
          'A classic U-shaped haircut that creates a soft, rounded silhouette at the back — perfect for a clean, feminine look.',
        defaultPrice: 200,
        durationMinutes: 30,
        sortOrder: 1,
      },
      {
        name: 'V Cut',
        slug: 'v-cut',
        description:
          'A stylish V-shaped haircut that adds a sharp, defined point at the nape, creating a sleek and modern finish.',
        defaultPrice: 300,
        durationMinutes: 30,
        sortOrder: 2,
      },
      {
        name: 'Step Cut',
        slug: 'step-cut',
        description:
          'A versatile step-layered haircut that adds volume and movement, suitable for all face shapes and hair types.',
        defaultPrice: 500,
        durationMinutes: 45,
        sortOrder: 3,
      },
      {
        name: 'Layer Cut',
        slug: 'layer-cut',
        description:
          'Multi-layered cutting technique that creates bounce, volume, and natural flow — ideal for both thick and fine hair.',
        defaultPrice: 600,
        durationMinutes: 45,
        sortOrder: 4,
      },
      {
        name: 'Feather Cut',
        slug: 'feather-cut',
        description:
          'Soft, wispy feathered layers that frame the face beautifully, giving a light, airy, and effortlessly stylish look.',
        defaultPrice: 600,
        durationMinutes: 45,
        sortOrder: 5,
      },
      {
        name: 'Pedicure',
        slug: 'pedicure',
        description:
          'A relaxing foot care treatment including soaking, scrubbing, cuticle care, and nail grooming to leave feet soft and refreshed.',
        defaultPrice: 700,
        durationMinutes: 60,
        sortOrder: 6,
      },
      {
        name: 'Manicure',
        slug: 'manicure',
        description:
          'A complete hand care treatment including nail shaping, cuticle treatment, hand massage, and polish for beautiful, well-groomed hands.',
        defaultPrice: 500,
        durationMinutes: 45,
        sortOrder: 7,
      },
      {
        name: 'Eyebrows Threading',
        slug: 'threading-eyebrows',
        description:
          'Precision eyebrow threading to define and shape your brows for a clean, polished, and symmetrical look.',
        defaultPrice: 60,
        durationMinutes: 10,
        sortOrder: 8,
      },
      {
        name: 'Upper Lips Threading',
        slug: 'threading-upper-lips',
        description:
          'Quick and precise upper lip threading to remove unwanted hair for a smooth and confident appearance.',
        defaultPrice: 50,
        durationMinutes: 10,
        sortOrder: 9,
      },
      {
        name: 'Forehead Threading',
        slug: 'threading-forehead',
        description:
          'Gentle forehead threading to remove fine hair and define the hairline for a neat, polished look.',
        defaultPrice: 30,
        durationMinutes: 10,
        sortOrder: 10,
      },
      {
        name: 'Full Face Threading',
        slug: 'threading-full-face',
        description:
          'Complete face threading covering eyebrows, upper lips, chin, cheeks, and forehead for a perfectly groomed appearance.',
        defaultPrice: 150,
        durationMinutes: 20,
        sortOrder: 11,
      },
      {
        name: 'Half Hands Waxing',
        slug: 'waxing-half-hands',
        description:
          'Smooth, hair-free skin from wrist to elbow with our precise half-hand waxing treatment.',
        defaultPrice: 200,
        durationMinutes: 20,
        sortOrder: 12,
      },
      {
        name: 'Full Hands Waxing',
        slug: 'waxing-full-hands',
        description:
          'Complete arm waxing from fingertips to shoulder for silky-smooth, hair-free hands and arms.',
        defaultPrice: 300,
        durationMinutes: 30,
        sortOrder: 13,
      },
      {
        name: 'Half Legs Waxing',
        slug: 'waxing-half-legs',
        description:
          'Efficient waxing from ankle to knee for smooth, hair-free lower legs that last for weeks.',
        defaultPrice: 250,
        durationMinutes: 25,
        sortOrder: 14,
      },
      {
        name: 'Full Legs Waxing',
        slug: 'waxing-full-legs',
        description:
          'Full leg waxing from ankle to thigh for long-lasting smoothness and beautifully smooth skin.',
        defaultPrice: 350,
        durationMinutes: 40,
        sortOrder: 15,
      },
      {
        name: 'Full Face Wax',
        slug: 'waxing-full-face',
        description:
          'Gentle full-face waxing to remove facial hair and peach fuzz, leaving skin smooth and brighter-looking.',
        defaultPrice: 200,
        durationMinutes: 30,
        sortOrder: 16,
      },
    ],
  },
  {
    name: 'Bridal & Groom Makeup',
    slug: 'bridal-and-groom-makeup',
    description:
      'Premium bridal and event makeup services to make you look flawless, radiant, and camera-ready on your most special occasions.',
    sortOrder: 3,
    services: [
      {
        name: 'Bridal Makeup',
        slug: 'bridal-makeup',
        description:
          'A comprehensive bridal makeup package designed to make you look radiant, timeless, and unforgettable on your most special day.',
        defaultPrice: 6000,
        durationMinutes: 120,
        sortOrder: 1,
      },
      {
        name: 'Bridal Nude Makeup',
        slug: 'bridal-nude-makeup',
        description:
          'Sophisticated nude bridal makeup with a flawless skin finish, soft neutral tones, and a luxurious feel for a naturally stunning bridal look.',
        defaultPrice: 7000,
        durationMinutes: 150,
        sortOrder: 2,
      },
      {
        name: 'Airbrush Makeup',
        slug: 'airbrush-makeup',
        description:
          'Long-lasting, flawless airbrush makeup application using professional-grade equipment for a perfect, camera-ready bridal finish.',
        defaultPrice: 9000,
        durationMinutes: 180,
        sortOrder: 3,
      },
      {
        name: 'Matte Makeup',
        slug: 'matte-makeup',
        description:
          'Bold and refined matte bridal makeup that stays fresh all day, offering a velvety finish perfect for photography and celebrations.',
        defaultPrice: 6500,
        durationMinutes: 120,
        sortOrder: 4,
      },
      {
        name: 'Smokey Eye Look',
        slug: 'smokey-eye-look',
        description:
          'A dramatic smokey eye paired with complementary makeup for a bold, sultry, and unforgettable look at any occasion.',
        defaultPrice: 5000,
        durationMinutes: 90,
        sortOrder: 5,
      },
      {
        name: 'Bridal Natural Makeup',
        slug: 'bridal-natural-makeup',
        description:
          'Elegant natural bridal makeup that enhances your features with a fresh, glowing finish — ideal for daytime ceremonies and outdoor events.',
        defaultPrice: 4500,
        durationMinutes: 90,
        sortOrder: 6,
      },
      {
        name: 'Natural Makeup',
        slug: 'natural-makeup',
        description:
          'Effortless natural makeup for a subtle, everyday glow that highlights your best features without heavy coverage — ideal for receptions and casual events.',
        defaultPrice: 4000,
        durationMinutes: 75,
        sortOrder: 7,
      },
      {
        name: 'Nude Makeup',
        slug: 'nude-makeup',
        description:
          'Classic nude makeup with balanced tones and a polished finish, ideal for occasions where understated elegance is key.',
        defaultPrice: 4500,
        durationMinutes: 90,
        sortOrder: 8,
      },
    ],
  },
];

async function main(): Promise<void> {
  console.log('Starting service seeding...\n');

  let totalServices = 0;

  for (const category of categories) {
    console.log(`Creating category: ${category.name}`);

    const categoryNode = await prisma.serviceNode.upsert({
      where: { slug: category.slug },
      update: {
        name: category.name,
        description: category.description,
        sortOrder: category.sortOrder,
        isActive: true,
      },
      create: {
        name: category.name,
        slug: category.slug,
        type: 'CATEGORY',
        description: category.description,
        isBookable: false,
        sortOrder: category.sortOrder,
        isActive: true,
      },
    });

    for (const service of category.services) {
      await prisma.serviceNode.upsert({
        where: { slug: service.slug },
        update: {
          name: service.name,
          description: service.description,
          defaultPrice: service.defaultPrice,
          durationMinutes: service.durationMinutes,
          sortOrder: service.sortOrder,
          parentId: categoryNode.id,
          isActive: true,
        },
        create: {
          name: service.name,
          slug: service.slug,
          type: 'SERVICE',
          description: service.description,
          parentId: categoryNode.id,
          isBookable: true,
          consultationOnly: false,
          defaultPrice: service.defaultPrice,
          priceType: 'FIXED',
          pricingType: 'FIXED',
          durationType: 'FIXED',
          durationMinutes: service.durationMinutes,
          bookingMode: 'MULTI',
          sortOrder: service.sortOrder,
          isActive: true,
        },
      });

      console.log(`  [OK] ${service.name} - Rs.${service.defaultPrice}`);
      totalServices++;
    }

    console.log(`  ${category.services.length} services seeded for "${category.name}"\n`);
  }

  console.log(`Seeding complete. ${categories.length} categories, ${totalServices} services created/updated.`);
}

main()
  .catch((err: unknown) => {
    console.error('Seeding failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
