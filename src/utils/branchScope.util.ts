import { prisma } from "../lib/prisma";

// Branches an ADMIN/BRANCH_ADMIN user is assigned to via BranchAdmin. An
// empty array conventionally means "not branch-scoped" (sees everything) —
// each caller decides how to interpret that, matching existing behavior in
// booking/payment/branch admin listings.
export const getAssignedBranchIds = async (userId: string) => {
  const adminBranches = await prisma.branchAdmin.findMany({
    where: { userId },
    select: { branchId: true },
  });

  return adminBranches.map((row) => row.branchId);
};
