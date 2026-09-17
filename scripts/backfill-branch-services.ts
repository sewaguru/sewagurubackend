import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

/**
 * One-off backfill: createServiceNode never created BranchService rows,
 * so every SERVICE node created before that fix is invisible on the
 * public storefront (withBranchAvailability filters it out for lacking
 * an active BranchService row) even though it shows fine in the admin
 * dashboard (which queries the node directly, branch-agnostic).
 *
 * This enables every existing, non-deleted SERVICE node for every
 * active branch, skipping any pair that's already enabled/disabled so
 * it won't clobber deliberate per-branch opt-outs.
 */
const connectionString = process.env.DATABASE_URL!;
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

async function main() {
  const [services, branches] = await Promise.all([
    prisma.serviceNode.findMany({
      where: { type: 'SERVICE', isActive: true, deletedAt: null },
      select: { id: true, name: true },
    }),
    prisma.branch.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
    }),
  ]);

  if (!services.length || !branches.length) {
    console.log(
      `Nothing to backfill (services: ${services.length}, branches: ${branches.length})`
    );
    return;
  }

  const data = services.flatMap((service) =>
    branches.map((branch) => ({
      serviceNodeId: service.id,
      branchId: branch.id,
    }))
  );

  const result = await prisma.branchService.createMany({
    data,
    skipDuplicates: true,
  });

  console.log(
    `Checked ${services.length} service(s) x ${branches.length} branch(es). Created ${result.count} missing BranchService row(s).`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
