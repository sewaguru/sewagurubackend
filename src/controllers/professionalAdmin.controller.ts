import { Response } from "express";
import { prisma } from "../lib/prisma";
import { AuthRequest } from "../types/types";
import { catchAsync } from "../utils/catchAsync";
import { AppError } from "../utils/AppError";
import { successResponse } from "../utils/response.util";
import { getParam } from "../utils/request.util";
import { getAssignedBranchIds } from "../utils/branchScope.util";
import {
  Prisma,
  ProfessionalDocumentStatus,
  ProfessionalVerificationStatus,
  ProfessionalAvailabilityStatus,
  PayoutStatus,
} from "../generated/prisma";
import {
  professionalProfileInclude,
  requireProfessionalProfileById,
  computeOnboardingStatus,
  getOnboardingStatusForUser,
  assertServiceOfferable,
  normalizeDisplayName,
  normalizeBio,
  normalizeExperienceYears,
  normalizeProfileImageUrl,
  resolveBranchId,
} from "../services/professional.service";
import {
  applyVerificationTransition,
  VerificationAction,
} from "../services/professionalAdmin.service";
import { getLocationView } from "../services/professionalLocation.service";
import { updatePayoutStatusByAdmin } from "../services/payout.service";
import { getProfessionalStatistics } from "../services/professionalStats.service";

//////////////////////////////////////////////////////
// HELPERS
//////////////////////////////////////////////////////

const assertAuthenticatedUser = (req: AuthRequest) => {
  if (!req.user) {
    throw new AppError("Unauthorized", 401);
  }
  return req.user;
};

const MAX_NOTE_LENGTH = 500;
const MIN_SERVICE_RADIUS_KM = 1;
const MAX_SERVICE_RADIUS_KM = 50;

// Mirrors the branch-scoping already used for bookings/payments: an ADMIN
// with BranchAdmin assignments is restricted to those branches; an ADMIN
// with none, or a SUPER_ADMIN, sees/manages everyone. A professional with
// no home branch is only reachable by an unscoped admin.
const assertBranchAccessForAdmin = async (
  authUser: { id: string; role: string },
  professionalBranchId: string | null
) => {
  if (authUser.role === "SUPER_ADMIN") {
    return;
  }

  const assignedBranchIds = await getAssignedBranchIds(authUser.id);

  if (assignedBranchIds.length === 0) {
    return;
  }

  if (
    !professionalBranchId ||
    !assignedBranchIds.includes(professionalBranchId)
  ) {
    throw new AppError("Forbidden", 403);
  }
};

const extractContact = (
  authMethods: Array<{
    identifierType: string;
    identifier: string;
  }>
) => ({
  phone:
    authMethods.find((a) => a.identifierType === "PHONE")?.identifier ??
    null,
  email:
    authMethods.find((a) => a.identifierType === "EMAIL")?.identifier ??
    null,
});

//////////////////////////////////////////////////////
// LIST / FILTER / SEARCH
//////////////////////////////////////////////////////

type ProfessionalListQuery = {
  search?: string;
  verificationStatus?: ProfessionalVerificationStatus;
  availabilityStatus?: ProfessionalAvailabilityStatus;
  branchId?: string;
  serviceNodeId?: string;
  page?: string;
  pageSize?: string;
};

const buildSearchWhere = (
  rawSearch?: string
): Prisma.ProfessionalProfileWhereInput | null => {
  const search =
    typeof rawSearch === "string" ? rawSearch.trim() : "";

  if (!search) return null;

  return {
    OR: [
      { displayName: { contains: search, mode: "insensitive" } },
      {
        user: {
          authMethods: {
            some: {
              identifier: { contains: search, mode: "insensitive" },
            },
          },
        },
      },
    ],
  };
};

export const listProfessionals = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const authUser = assertAuthenticatedUser(req);

    const {
      search,
      verificationStatus,
      availabilityStatus,
      branchId,
      serviceNodeId,
      page = "1",
      pageSize = "20",
    } = req.query as ProfessionalListQuery;

    const pageNum = Math.max(1, Number(page) || 1);
    const limit = Math.min(Math.max(1, Number(pageSize) || 20), 100);
    const skip = (pageNum - 1) * limit;

    const assignedBranchIds = await getAssignedBranchIds(authUser.id);
    const isBranchScoped =
      authUser.role !== "SUPER_ADMIN" && assignedBranchIds.length > 0;

    if (isBranchScoped && branchId && !assignedBranchIds.includes(branchId)) {
      throw new AppError("Forbidden", 403);
    }

    const scopeWhere: Prisma.ProfessionalProfileWhereInput = isBranchScoped
      ? { branchId: branchId ? branchId : { in: assignedBranchIds } }
      : branchId
      ? { branchId }
      : {};

    const filterWhere: Prisma.ProfessionalProfileWhereInput = {
      ...(verificationStatus ? { verificationStatus } : {}),
      ...(availabilityStatus ? { availabilityStatus } : {}),
      ...(serviceNodeId
        ? { services: { some: { serviceNodeId, isActive: true } } }
        : {}),
    };

    const searchWhere = buildSearchWhere(search);

    const combined: Prisma.ProfessionalProfileWhereInput = {
      AND: [
        scopeWhere,
        filterWhere,
        ...(searchWhere ? [searchWhere] : []),
      ],
    };

    const [total, data, statusGroups] = await Promise.all([
      prisma.professionalProfile.count({ where: combined }),
      prisma.professionalProfile.findMany({
        where: combined,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          branch: { select: { id: true, name: true } },
          user: {
            select: {
              authMethods: {
                select: { identifier: true, identifierType: true },
              },
            },
          },
          _count: {
            select: { services: true, documents: true },
          },
        },
      }),
      prisma.professionalProfile.groupBy({
        by: ["verificationStatus"],
        where: scopeWhere,
        _count: { _all: true },
      }),
    ]);

    const summary = {
      total: 0,
      pending: 0,
      underReview: 0,
      approved: 0,
      rejected: 0,
      suspended: 0,
      blocked: 0,
    };

    for (const group of statusGroups) {
      summary.total += group._count._all;
      switch (group.verificationStatus) {
        case "PENDING":
          summary.pending = group._count._all;
          break;
        case "UNDER_REVIEW":
          summary.underReview = group._count._all;
          break;
        case "APPROVED":
          summary.approved = group._count._all;
          break;
        case "REJECTED":
          summary.rejected = group._count._all;
          break;
        case "SUSPENDED":
          summary.suspended = group._count._all;
          break;
        case "BLOCKED":
          summary.blocked = group._count._all;
          break;
      }
    }

    const formatted = data.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      profileImageUrl: p.profileImageUrl,
      verificationStatus: p.verificationStatus,
      availabilityStatus: p.availabilityStatus,
      experienceYears: p.experienceYears,
      averageRating: p.averageRating,
      ratingCount: p.ratingCount,
      branch: p.branch,
      ...extractContact(p.user.authMethods),
      servicesCount: p._count.services,
      documentsCount: p._count.documents,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }));

    res.json(
      successResponse(formatted, "Professionals fetched", {
        page: pageNum,
        pageSize: limit,
        total,
        totalPages: Math.ceil(total / limit),
        summary,
      })
    );
  }
);

//////////////////////////////////////////////////////
// GET DETAILS
//////////////////////////////////////////////////////

export const getProfessionalDetail = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const authUser = assertAuthenticatedUser(req);
    const id = getParam(req.params.id, "professionalId");

    const profile = await prisma.professionalProfile.findUnique({
      where: { id },
      include: {
        branch: {
          select: {
            id: true,
            name: true,
            city: { select: { name: true, state: true } },
          },
        },
        user: {
          select: {
            id: true,
            role: true,
            isActive: true,
            isBlocked: true,
            createdAt: true,
            lastActiveAt: true,
            authMethods: {
              select: {
                identifier: true,
                identifierType: true,
                isVerified: true,
                isPrimary: true,
              },
            },
          },
        },
        verifiedBy: {
          select: {
            id: true,
            profile: { select: { fullName: true } },
          },
        },
        services: {
          include: {
            serviceNode: {
              select: { id: true, name: true, slug: true },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        documents: {
          include: {
            media: {
              select: { id: true, url: true, fileName: true, mimeType: true },
            },
            reviewedBy: {
              select: {
                id: true,
                profile: { select: { fullName: true } },
              },
            },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!profile) {
      throw new AppError("Professional not found", 404);
    }

    await assertBranchAccessForAdmin(authUser, profile.branchId);

    const [{ onboarding }, statistics] = await Promise.all([
      getOnboardingStatusForUser(profile.userId),
      // Same composed function the professional's own /statistics endpoint
      // calls — one source of truth for job/offer/rating/earnings numbers,
      // reused here rather than a second, narrower inline computation.
      getProfessionalStatistics(id),
    ]);

    res.json(
      successResponse(
        {
          id: profile.id,
          displayName: profile.displayName,
          bio: profile.bio,
          profileImageUrl: profile.profileImageUrl,
          experienceYears: profile.experienceYears,
          verificationStatus: profile.verificationStatus,
          verificationNote: profile.verificationNote,
          verifiedAt: profile.verifiedAt,
          verifiedBy: profile.verifiedBy
            ? {
                id: profile.verifiedBy.id,
                fullName: profile.verifiedBy.profile?.fullName ?? null,
              }
            : null,
          availabilityStatus: profile.availabilityStatus,
          availabilityUpdatedAt: profile.availabilityUpdatedAt,
          location: getLocationView(profile),
          branch: profile.branch,
          statistics,
          contact: extractContact(profile.user.authMethods),
          user: {
            id: profile.user.id,
            role: profile.user.role,
            isActive: profile.user.isActive,
            isBlocked: profile.user.isBlocked,
            createdAt: profile.user.createdAt,
            lastActiveAt: profile.user.lastActiveAt,
          },
          services: profile.services,
          documents: profile.documents,
          onboarding,
          createdAt: profile.createdAt,
          updatedAt: profile.updatedAt,
        },
        "Professional details fetched"
      )
    );
  }
);

//////////////////////////////////////////////////////
// UPDATE (GENERAL PROFILE FIELDS)
//////////////////////////////////////////////////////

export const updateProfessionalByAdmin = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const authUser = assertAuthenticatedUser(req);
    const id = getParam(req.params.id, "professionalId");

    const profile = await requireProfessionalProfileById(id);
    await assertBranchAccessForAdmin(authUser, profile.branchId);

    const displayName = normalizeDisplayName(req.body?.displayName, {
      required: false,
    });
    const bio = normalizeBio(req.body?.bio);
    const experienceYears = normalizeExperienceYears(
      req.body?.experienceYears
    );
    const profileImageUrl = normalizeProfileImageUrl(
      req.body?.profileImageUrl
    );
    const branchId = await resolveBranchId(req.body?.branchId);

    const updated = await prisma.professionalProfile.update({
      where: { id },
      data: {
        ...(displayName !== undefined ? { displayName } : {}),
        ...(bio !== undefined ? { bio } : {}),
        ...(experienceYears !== undefined ? { experienceYears } : {}),
        ...(profileImageUrl !== undefined ? { profileImageUrl } : {}),
        ...(branchId !== undefined ? { branchId } : {}),
      },
      include: professionalProfileInclude,
    });

    res.json(successResponse(updated, "Professional updated"));
  }
);

//////////////////////////////////////////////////////
// SERVICE AREA (ADMIN OVERRIDE)
//////////////////////////////////////////////////////

export const updateServiceAreaByAdmin = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const authUser = assertAuthenticatedUser(req);
    const id = getParam(req.params.id, "professionalId");

    const profile = await requireProfessionalProfileById(id);
    await assertBranchAccessForAdmin(authUser, profile.branchId);

    const body = (req.body ?? {}) as {
      latitude?: unknown;
      longitude?: unknown;
      serviceRadiusKm?: unknown;
    };

    if (
      body.latitude === undefined &&
      body.longitude === undefined &&
      body.serviceRadiusKm === undefined
    ) {
      throw new AppError(
        "Provide at least one of latitude, longitude, serviceRadiusKm",
        400
      );
    }

    const data: Prisma.ProfessionalProfileUpdateInput = {};
    let locationTouched = false;

    if (body.latitude !== undefined) {
      const lat = Number(body.latitude);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        throw new AppError(
          "latitude must be a number between -90 and 90",
          400,
          "INVALID_LATITUDE"
        );
      }
      data.latitude = lat;
      locationTouched = true;
    }

    if (body.longitude !== undefined) {
      const lng = Number(body.longitude);
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
        throw new AppError(
          "longitude must be a number between -180 and 180",
          400,
          "INVALID_LONGITUDE"
        );
      }
      data.longitude = lng;
      locationTouched = true;
    }

    if (body.serviceRadiusKm !== undefined) {
      const radius = Number(body.serviceRadiusKm);
      if (
        !Number.isFinite(radius) ||
        radius < MIN_SERVICE_RADIUS_KM ||
        radius > MAX_SERVICE_RADIUS_KM
      ) {
        throw new AppError(
          `serviceRadiusKm must be between ${MIN_SERVICE_RADIUS_KM} and ${MAX_SERVICE_RADIUS_KM}`,
          400,
          "INVALID_SERVICE_RADIUS"
        );
      }
      data.serviceRadiusKm = radius;
    }

    if (locationTouched) {
      data.locationUpdatedAt = new Date();
    }

    const updated = await prisma.professionalProfile.update({
      where: { id },
      data,
    });

    res.json(
      successResponse(
        {
          latitude: updated.latitude,
          longitude: updated.longitude,
          serviceRadiusKm: updated.serviceRadiusKm,
          locationUpdatedAt: updated.locationUpdatedAt,
        },
        "Service area updated"
      )
    );
  }
);

//////////////////////////////////////////////////////
// SERVICES MANAGEMENT
//////////////////////////////////////////////////////

export const listProfessionalServicesByAdmin = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const authUser = assertAuthenticatedUser(req);
    const id = getParam(req.params.id, "professionalId");

    const profile = await requireProfessionalProfileById(id);
    await assertBranchAccessForAdmin(authUser, profile.branchId);

    const services = await prisma.professionalService.findMany({
      where: { professionalId: id },
      include: {
        serviceNode: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    res.json(successResponse(services, "Services fetched"));
  }
);

export const addProfessionalServiceByAdmin = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const authUser = assertAuthenticatedUser(req);
    const id = getParam(req.params.id, "professionalId");

    const profile = await requireProfessionalProfileById(id);
    await assertBranchAccessForAdmin(authUser, profile.branchId);

    const serviceNodeId =
      typeof req.body?.serviceNodeId === "string"
        ? req.body.serviceNodeId.trim()
        : "";

    if (!serviceNodeId) {
      throw new AppError("serviceNodeId is required", 400);
    }

    await assertServiceOfferable(serviceNodeId);

    const saved = await prisma.professionalService.upsert({
      where: {
        professionalId_serviceNodeId: {
          professionalId: id,
          serviceNodeId,
        },
      },
      update: { isActive: true },
      create: { professionalId: id, serviceNodeId, isActive: true },
      include: {
        serviceNode: { select: { id: true, name: true, slug: true } },
      },
    });

    res.json(successResponse(saved, "Service added"));
  }
);

export const removeProfessionalServiceByAdmin = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const authUser = assertAuthenticatedUser(req);
    const id = getParam(req.params.id, "professionalId");
    const serviceNodeId = getParam(
      req.params.serviceNodeId,
      "serviceNodeId"
    );

    const profile = await requireProfessionalProfileById(id);
    await assertBranchAccessForAdmin(authUser, profile.branchId);

    const result = await prisma.professionalService.updateMany({
      where: { professionalId: id, serviceNodeId, isActive: true },
      data: { isActive: false },
    });

    res.json(
      successResponse(
        { removedCount: result.count },
        result.count > 0
          ? "Service removed"
          : "Service was not active for this professional"
      )
    );
  }
);

//////////////////////////////////////////////////////
// DOCUMENTS
//////////////////////////////////////////////////////

export const listProfessionalDocumentsByAdmin = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const authUser = assertAuthenticatedUser(req);
    const id = getParam(req.params.id, "professionalId");

    const profile = await requireProfessionalProfileById(id);
    await assertBranchAccessForAdmin(authUser, profile.branchId);

    const documents = await prisma.professionalDocument.findMany({
      where: { professionalId: id },
      include: {
        media: {
          select: { id: true, url: true, fileName: true, mimeType: true },
        },
        reviewedBy: {
          select: { id: true, profile: { select: { fullName: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(successResponse(documents, "Documents fetched"));
  }
);

export const reviewProfessionalDocument = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const authUser = assertAuthenticatedUser(req);
    const id = getParam(req.params.id, "professionalId");
    const documentId = getParam(req.params.documentId, "documentId");

    const profile = await requireProfessionalProfileById(id);
    await assertBranchAccessForAdmin(authUser, profile.branchId);

    const status =
      typeof req.body?.status === "string" ? req.body.status : "";

    if (status !== "APPROVED" && status !== "REJECTED") {
      throw new AppError("status must be APPROVED or REJECTED", 400);
    }

    const document = await prisma.professionalDocument.findFirst({
      where: { id: documentId, professionalId: id },
    });

    if (!document) {
      throw new AppError("Document not found", 404);
    }

    const updated = await prisma.professionalDocument.update({
      where: { id: documentId },
      data: {
        status: status as ProfessionalDocumentStatus,
        reviewedById: authUser.id,
        reviewedAt: new Date(),
      },
      include: {
        media: {
          select: { id: true, url: true, fileName: true, mimeType: true },
        },
      },
    });

    res.json(
      successResponse(
        updated,
        status === "APPROVED" ? "Document approved" : "Document rejected"
      )
    );
  }
);

//////////////////////////////////////////////////////
// ONBOARDING STATUS (ADMIN VIEW)
//////////////////////////////////////////////////////

export const getOnboardingStatusByAdmin = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const authUser = assertAuthenticatedUser(req);
    const id = getParam(req.params.id, "professionalId");

    const profile = await requireProfessionalProfileById(id);
    await assertBranchAccessForAdmin(authUser, profile.branchId);

    const onboarding = computeOnboardingStatus(profile);

    res.json(
      successResponse(
        { professionalProfile: profile, onboarding },
        "Onboarding status fetched"
      )
    );
  }
);

//////////////////////////////////////////////////////
// LIFECYCLE ACTIONS
//////////////////////////////////////////////////////

const makeLifecycleHandler = (action: VerificationAction) =>
  catchAsync(async (req: AuthRequest, res: Response) => {
    const authUser = assertAuthenticatedUser(req);
    const id = getParam(req.params.id, "professionalId");

    const profile = await requireProfessionalProfileById(id);
    await assertBranchAccessForAdmin(authUser, profile.branchId);

    const note =
      typeof req.body?.note === "string" ? req.body.note : undefined;

    if (note && note.length > MAX_NOTE_LENGTH) {
      throw new AppError(
        `note cannot exceed ${MAX_NOTE_LENGTH} characters`,
        400
      );
    }

    const updated = await applyVerificationTransition({
      professionalId: id,
      action,
      adminUserId: authUser.id,
      note,
    });

    res.json(
      successResponse(updated, `Professional ${action} action completed`)
    );
  });

export const reviewProfessional = makeLifecycleHandler("review");
export const approveProfessional = makeLifecycleHandler("approve");
export const rejectProfessional = makeLifecycleHandler("reject");
export const suspendProfessional = makeLifecycleHandler("suspend");
export const blockProfessional = makeLifecycleHandler("block");
export const reactivateProfessional = makeLifecycleHandler("reactivate");

//////////////////////////////////////////////////////
// PAYOUT PROCESSING (admin side of the payout foundation — no automated
// bank transfer, just moving a Payout through PENDING/PROCESSING/PAID/
// FAILED/CANCELLED once money has actually been sent outside this system)
//////////////////////////////////////////////////////

export const updatePayoutStatus = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const authUser = assertAuthenticatedUser(req);
    const payoutId = getParam(req.params.payoutId, "payoutId");

    // Phase 10 hardening: every other admin action in this router checks
    // branch access; this one didn't, letting a branch-scoped ADMIN
    // process a payout for a professional outside their branch.
    const payout = await prisma.payout.findUnique({
      where: { id: payoutId },
      select: { professional: { select: { branchId: true } } },
    });

    if (!payout) {
      throw new AppError("Payout not found.", 404, "PAYOUT_NOT_FOUND");
    }

    await assertBranchAccessForAdmin(authUser, payout.professional.branchId);

    const status =
      typeof req.body?.status === "string" ? req.body.status : "";

    if (!Object.values(PayoutStatus).includes(status as PayoutStatus)) {
      throw new AppError(
        `status must be one of: ${Object.values(PayoutStatus).join(", ")}`,
        400
      );
    }

    const reference =
      typeof req.body?.reference === "string" ? req.body.reference : undefined;
    const failureReason =
      typeof req.body?.failureReason === "string"
        ? req.body.failureReason
        : undefined;

    const updated = await updatePayoutStatusByAdmin({
      payoutId,
      status: status as PayoutStatus,
      reference,
      failureReason,
    });

    res.json(successResponse(updated, "Payout status updated"));
  }
);

//////////////////////////////////////////////////////
// STATISTICS & REVIEWS
//////////////////////////////////////////////////////

export const getProfessionalStatisticsByAdmin = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const authUser = assertAuthenticatedUser(req);
    const id = getParam(req.params.id, "professionalId");

    const profile = await requireProfessionalProfileById(id);
    await assertBranchAccessForAdmin(authUser, profile.branchId);

    const statistics = await getProfessionalStatistics(id);

    res.json(successResponse(statistics, "Statistics fetched"));
  }
);

export const listProfessionalReviewsByAdmin = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const authUser = assertAuthenticatedUser(req);
    const id = getParam(req.params.id, "professionalId");

    const profile = await requireProfessionalProfileById(id);
    await assertBranchAccessForAdmin(authUser, profile.branchId);

    const {
      page = "1",
      pageSize = "20",
    } = req.query as { page?: string; pageSize?: string };

    const pageNum = Math.max(1, Number(page) || 1);
    const limit = Math.min(Math.max(1, Number(pageSize) || 20), 100);
    const skip = (pageNum - 1) * limit;

    // Admins see hidden/moderated reviews too, unlike the professional's
    // own and the public-facing review listings.
    const where = { professionalId: id };

    const [total, reviews] = await Promise.all([
      prisma.serviceReview.count({ where }),
      prisma.serviceReview.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          serviceNode: { select: { id: true, name: true, slug: true } },
          booking: { select: { id: true, displayId: true } },
          user: { select: { id: true, profile: { select: { fullName: true } } } },
        },
      }),
    ]);

    res.json(
      successResponse(reviews, "Reviews fetched", {
        page: pageNum,
        pageSize: limit,
        total,
        totalPages: Math.ceil(total / limit),
      })
    );
  }
);
