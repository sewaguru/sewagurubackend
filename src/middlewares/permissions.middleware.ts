import { Role } from "../generated/prisma";
import { requireRole } from "./requireRole.middleware";

export const requireSuperAdmin = requireRole(
  Role.SUPER_ADMIN
);

export const requireAdmin = requireRole(
  Role.ADMIN,
  Role.SUPER_ADMIN
);

export const requireBranchAdmin = requireRole(
  Role.BRANCH_ADMIN,
  Role.ADMIN,
  Role.SUPER_ADMIN
);

export const requireBranchOperator =
  requireRole(
    Role.BRANCH_ADMIN,
    Role.SUPER_ADMIN
  );

export const requireOrderManager =
  requireRole(
    Role.ADMIN,
    Role.BRANCH_ADMIN,
    Role.SUPER_ADMIN
  );

export const requireProfessional =
  requireRole(Role.PROFESSIONAL);

