import { Response } from "express";
import { prisma } from "../lib/prisma";
import { AuthRequest } from "../types/types";
import { catchAsync } from "../utils/catchAsync";
import { AppError } from "../utils/AppError";
import { successResponse } from "../utils/response.util";
import { getParam } from "../utils/request.util";
import { uploadToS3, deleteFromS3 } from "../services/s3.service";
import {
  ProfessionalAvailabilityStatus,
  ProfessionalDocumentType,
} from "../generated/prisma";
import {
  professionalProfileInclude,
  requireOwnProfessionalProfile,
  getOnboardingStatusForUser,
  assertServiceOfferable,
  normalizeDisplayName,
  normalizeBio,
  normalizeExperienceYears,
  normalizeProfileImageUrl,
  resolveBranchId,
} from "../services/professional.service";
import {
  applyAvailabilityTransition,
  getGoOnlineEligibility,
} from "../services/professionalAvailability.service";
import {
  getLocationView,
  updateProfessionalLocation,
} from "../services/professionalLocation.service";
import {
  acceptJobOffer,
  rejectJobOffer,
} from "../services/jobOffer.service";
import {
  advanceJobStatus,
  cancelAssignedJob,
  JobLifecycleAction,
} from "../services/jobLifecycle.service";
import { hydrateBookingForResponse } from "../utils/bookingSnapshot";
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

//////////////////////////////////////////////////////
// PROFILE
//////////////////////////////////////////////////////

export const getProfessionalProfile = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);

    res.json(
      successResponse(profile, "Professional profile fetched")
    );
  }
);

export const createProfessionalProfile = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);

    const existing = await prisma.professionalProfile.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });

    if (existing) {
      throw new AppError(
        "Professional profile already exists. Use PATCH to update it.",
        409,
        "PROFESSIONAL_PROFILE_EXISTS"
      );
    }

    const displayName = normalizeDisplayName(
      req.body?.displayName,
      { required: true }
    )!;
    const bio = normalizeBio(req.body?.bio);
    const experienceYears = normalizeExperienceYears(
      req.body?.experienceYears
    );
    const profileImageUrl = normalizeProfileImageUrl(
      req.body?.profileImageUrl
    );
    const branchId = await resolveBranchId(req.body?.branchId);

    const created = await prisma.professionalProfile.create({
      data: {
        userId: user.id,
        displayName,
        bio: bio ?? null,
        experienceYears: experienceYears ?? null,
        profileImageUrl: profileImageUrl ?? null,
        branchId: branchId ?? null,
      },
      include: professionalProfileInclude,
    });

    res.json(
      successResponse(created, "Professional profile created")
    );
  }
);

export const updateProfessionalProfile = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    await requireOwnProfessionalProfile(user.id);

    const displayName = normalizeDisplayName(
      req.body?.displayName,
      { required: false }
    );
    const bio = normalizeBio(req.body?.bio);
    const experienceYears = normalizeExperienceYears(
      req.body?.experienceYears
    );
    const profileImageUrl = normalizeProfileImageUrl(
      req.body?.profileImageUrl
    );
    const branchId = await resolveBranchId(req.body?.branchId);

    const updated = await prisma.professionalProfile.update({
      where: { userId: user.id },
      data: {
        ...(displayName !== undefined ? { displayName } : {}),
        ...(bio !== undefined ? { bio } : {}),
        ...(experienceYears !== undefined
          ? { experienceYears }
          : {}),
        ...(profileImageUrl !== undefined
          ? { profileImageUrl }
          : {}),
        ...(branchId !== undefined ? { branchId } : {}),
      },
      include: professionalProfileInclude,
    });

    res.json(
      successResponse(updated, "Professional profile updated")
    );
  }
);

//////////////////////////////////////////////////////
// SERVICES
//////////////////////////////////////////////////////

export const getMyProfessionalServices = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);

    const services = await prisma.professionalService.findMany({
      where: { professionalId: profile.id, isActive: true },
      include: {
        serviceNode: {
          select: { id: true, name: true, slug: true, iconUrl: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    res.json(successResponse(services, "Services fetched"));
  }
);

export const addProfessionalService = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);

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
          professionalId: profile.id,
          serviceNodeId,
        },
      },
      update: { isActive: true },
      create: {
        professionalId: profile.id,
        serviceNodeId,
        isActive: true,
      },
      include: {
        serviceNode: {
          select: { id: true, name: true, slug: true, iconUrl: true },
        },
      },
    });

    res.json(successResponse(saved, "Service added"));
  }
);

export const removeProfessionalService = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);
    const serviceNodeId = getParam(
      req.params.serviceNodeId,
      "serviceNodeId"
    );

    const result = await prisma.professionalService.updateMany({
      where: {
        professionalId: profile.id,
        serviceNodeId,
        isActive: true,
      },
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
// SERVICE AREA (LOCATION + RADIUS)
//////////////////////////////////////////////////////

export const updateServiceArea = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);

    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);

    if (
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90
    ) {
      throw new AppError(
        "latitude must be a number between -90 and 90",
        400,
        "INVALID_LATITUDE"
      );
    }

    if (
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new AppError(
        "longitude must be a number between -180 and 180",
        400,
        "INVALID_LONGITUDE"
      );
    }

    let serviceRadiusKm = profile.serviceRadiusKm;

    if (req.body?.serviceRadiusKm !== undefined) {
      const parsedRadius = Number(req.body.serviceRadiusKm);

      if (
        !Number.isFinite(parsedRadius) ||
        parsedRadius < MIN_SERVICE_RADIUS_KM ||
        parsedRadius > MAX_SERVICE_RADIUS_KM
      ) {
        throw new AppError(
          `serviceRadiusKm must be between ${MIN_SERVICE_RADIUS_KM} and ${MAX_SERVICE_RADIUS_KM}`,
          400,
          "INVALID_SERVICE_RADIUS"
        );
      }

      serviceRadiusKm = parsedRadius;
    }

    const updated = await prisma.professionalProfile.update({
      where: { id: profile.id },
      data: {
        latitude,
        longitude,
        serviceRadiusKm,
        locationUpdatedAt: new Date(),
      },
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
// DOCUMENTS
//////////////////////////////////////////////////////

const DOCUMENT_TYPES = new Set<string>(
  Object.values(ProfessionalDocumentType)
);

export const listMyProfessionalDocuments = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);

    const documents = await prisma.professionalDocument.findMany({
      where: { professionalId: profile.id },
      include: {
        media: {
          select: { id: true, url: true, fileName: true, mimeType: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(successResponse(documents, "Documents fetched"));
  }
);

export const uploadProfessionalDocument = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);

    const file = (req as any).file as
      | Express.Multer.File
      | undefined;

    if (!file) {
      throw new AppError("No file uploaded", 400);
    }

    const type =
      typeof req.body?.type === "string" ? req.body.type : "";

    if (!DOCUMENT_TYPES.has(type)) {
      throw new AppError(
        `type must be one of: ${[...DOCUMENT_TYPES].join(", ")}`,
        400,
        "INVALID_DOCUMENT_TYPE"
      );
    }

    const documentNumber =
      typeof req.body?.documentNumber === "string"
        ? req.body.documentNumber.trim() || null
        : null;

    const note =
      typeof req.body?.note === "string"
        ? req.body.note.trim()
        : "";

    if (note.length > MAX_NOTE_LENGTH) {
      throw new AppError(
        `note cannot exceed ${MAX_NOTE_LENGTH} characters`,
        400
      );
    }

    const uploaded = await uploadToS3(
      file,
      `professional-documents/${profile.id}`
    );

    const media = await prisma.media.create({
      data: {
        url: uploaded.url,
        key: uploaded.key,
        fileName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      },
    });

    const document = await prisma.professionalDocument.create({
      data: {
        professionalId: profile.id,
        type: type as ProfessionalDocumentType,
        mediaId: media.id,
        documentNumber,
        note: note || null,
      },
      include: {
        media: {
          select: { id: true, url: true, fileName: true, mimeType: true },
        },
      },
    });

    res.json(successResponse(document, "Document uploaded"));
  }
);

export const deleteMyProfessionalDocument = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);
    const id = getParam(req.params.id, "documentId");

    const document = await prisma.professionalDocument.findFirst({
      where: { id, professionalId: profile.id },
      include: { media: { select: { id: true, key: true } } },
    });

    if (!document) {
      throw new AppError("Document not found", 404);
    }

    if (document.status === "APPROVED") {
      throw new AppError(
        "Approved documents cannot be removed.",
        409,
        "DOCUMENT_ALREADY_APPROVED"
      );
    }

    await prisma.professionalDocument.delete({
      where: { id: document.id },
    });

    if (document.media) {
      await deleteFromS3(document.media.key).catch((error) => {
        console.error(
          "[PROFESSIONAL][DOCUMENT] Failed to delete S3 object",
          { mediaId: document.media!.id, error }
        );
      });

      await prisma.media
        .delete({ where: { id: document.media.id } })
        .catch(() => {});
    }

    res.json(successResponse(null, "Document removed"));
  }
);

//////////////////////////////////////////////////////
// ONBOARDING STATUS
//////////////////////////////////////////////////////

export const getOnboardingStatus = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const { profile, onboarding } =
      await getOnboardingStatusForUser(user.id);

    res.json(
      successResponse(
        { professionalProfile: profile, onboarding },
        "Onboarding status fetched"
      )
    );
  }
);

//////////////////////////////////////////////////////
// AVAILABILITY (ONLINE / OFFLINE / BUSY)
//////////////////////////////////////////////////////

const VALID_AVAILABILITY_STATUSES = new Set<string>(
  Object.values(ProfessionalAvailabilityStatus)
);

export const getAvailabilityStatus = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);
    const eligibility = getGoOnlineEligibility(profile);

    res.json(
      successResponse(
        {
          availabilityStatus: profile.availabilityStatus,
          availabilityUpdatedAt: profile.availabilityUpdatedAt,
          verificationStatus: profile.verificationStatus,
          canGoOnline: eligibility.eligible,
          ...(eligibility.eligible
            ? {}
            : {
                blockedReason: eligibility.reason,
                blockedCode: eligibility.code,
              }),
          location: getLocationView(profile),
        },
        "Availability status fetched"
      )
    );
  }
);

const setAvailability = async (
  req: AuthRequest,
  res: Response,
  targetStatus: ProfessionalAvailabilityStatus
) => {
  const user = assertAuthenticatedUser(req);
  const profile = await requireOwnProfessionalProfile(user.id);

  const updated = await applyAvailabilityTransition({
    profile,
    targetStatus,
  });

  res.json(
    successResponse(
      {
        availabilityStatus: updated.availabilityStatus,
        availabilityUpdatedAt: updated.availabilityUpdatedAt,
      },
      `You are now ${updated.availabilityStatus}`
    )
  );
};

export const goOnline = catchAsync(async (req: AuthRequest, res: Response) =>
  setAvailability(req, res, ProfessionalAvailabilityStatus.ONLINE)
);

export const goOffline = catchAsync(async (req: AuthRequest, res: Response) =>
  setAvailability(req, res, ProfessionalAvailabilityStatus.OFFLINE)
);

export const updateAvailability = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const status =
      typeof req.body?.status === "string" ? req.body.status : "";

    if (!VALID_AVAILABILITY_STATUSES.has(status)) {
      throw new AppError(
        `status must be one of: ${[...VALID_AVAILABILITY_STATUSES].join(", ")}`,
        400
      );
    }

    return setAvailability(
      req,
      res,
      status as ProfessionalAvailabilityStatus
    );
  }
);

//////////////////////////////////////////////////////
// LOCATION (LIVE PING)
//////////////////////////////////////////////////////

export const getMyLocation = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);

    res.json(
      successResponse(getLocationView(profile), "Location fetched")
    );
  }
);

export const updateMyLocation = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);

    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);

    const updated = await updateProfessionalLocation({
      professionalId: profile.id,
      latitude,
      longitude,
    });

    res.json(
      successResponse(getLocationView(updated), "Location updated")
    );
  }
);

//////////////////////////////////////////////////////
// JOB OFFERS
//////////////////////////////////////////////////////

export const listMyJobOffers = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);

    const { status } = req.query as { status?: string };

    const offers = await prisma.bookingProfessionalOffer.findMany({
      where: {
        professionalId: profile.id,
        ...(status ? { status: status as any } : {}),
      },
      include: {
        booking: {
          select: {
            id: true,
            displayId: true,
            scheduledAt: true,
            status: true,
            address: {
              select: { locality: true, city: { select: { name: true } } },
            },
            items: {
              select: { serviceNode: { select: { name: true } } },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(successResponse(offers, "Job offers fetched"));
  }
);

export const acceptMyJobOffer = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);
    const offerId = getParam(req.params.id, "offerId");

    const result = await acceptJobOffer({
      offerId,
      professionalId: profile.id,
    });

    res.json(
      successResponse(
        result,
        result.alreadyAccepted
          ? "You have already accepted this job offer"
          : "Job offer accepted — you are assigned to this booking"
      )
    );
  }
);

export const rejectMyJobOffer = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);
    const offerId = getParam(req.params.id, "offerId");

    const note =
      typeof req.body?.note === "string" ? req.body.note : undefined;

    const result = await rejectJobOffer({
      offerId,
      professionalId: profile.id,
      note,
    });

    res.json(
      successResponse(
        result,
        result.alreadyRejected
          ? "You have already rejected this job offer"
          : "Job offer rejected"
      )
    );
  }
);

//////////////////////////////////////////////////////
// ASSIGNED JOBS (LIFECYCLE)
//////////////////////////////////////////////////////

const extractJobCustomerContact = (
  authMethods: Array<{ identifierType: string; identifier: string }>
) => ({
  phone:
    authMethods.find((a) => a.identifierType === "PHONE")?.identifier ??
    null,
  email:
    authMethods.find((a) => a.identifierType === "EMAIL")?.identifier ??
    null,
});

const jobBookingInclude = {
  items: { include: { serviceNode: true } },
  address: { include: { city: true } },
  branch: { include: { city: true } },
  user: {
    include: {
      profile: true,
      authMethods: {
        select: { identifier: true, identifierType: true },
      },
    },
  },
  timeline: { orderBy: { createdAt: "asc" as const } },
};

export const listMyJobs = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);

    const { status } = req.query as { status?: string };

    const bookings = await prisma.booking.findMany({
      where: {
        assignedProfessionalId: profile.id,
        ...(status ? { status: status as any } : {}),
      },
      include: jobBookingInclude,
      orderBy: { scheduledAt: "desc" },
    });

    const formatted = bookings.map((booking) => {
      const hydrated = hydrateBookingForResponse(booking);
      const { authMethods, ...safeUser } = booking.user as any;
      return {
        ...hydrated,
        user: {
          ...safeUser,
          ...extractJobCustomerContact(booking.user.authMethods),
        },
      };
    });

    res.json(successResponse(formatted, "Assigned jobs fetched"));
  }
);

export const getMyJobById = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);
    const bookingId = getParam(req.params.id, "bookingId");

    const booking = await prisma.booking.findFirst({
      where: { id: bookingId, assignedProfessionalId: profile.id },
      include: jobBookingInclude,
    });

    if (!booking) {
      throw new AppError("Booking not found.", 404, "BOOKING_NOT_FOUND");
    }

    const hydrated = hydrateBookingForResponse(booking);
    const { authMethods, ...safeUser } = booking.user as any;

    res.json(
      successResponse(
        {
          ...hydrated,
          user: {
            ...safeUser,
            ...extractJobCustomerContact(booking.user.authMethods),
          },
        },
        "Job details fetched"
      )
    );
  }
);

const makeJobLifecycleHandler = (action: JobLifecycleAction) =>
  catchAsync(async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);
    const bookingId = getParam(req.params.id, "bookingId");

    const result = await advanceJobStatus({
      bookingId,
      professionalId: profile.id,
      professionalUserId: user.id,
      action,
    });

    res.json(
      successResponse(
        result,
        result.alreadyInState
          ? "This job is already in that state"
          : "Job status updated"
      )
    );
  });

export const startJobTravel = makeJobLifecycleHandler("startTravel");
export const markJobArrived = makeJobLifecycleHandler("arrive");
export const startJobWork = makeJobLifecycleHandler("startWork");
export const completeJob = makeJobLifecycleHandler("complete");

export const cancelMyJob = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);
    const bookingId = getParam(req.params.id, "bookingId");

    const reason =
      typeof req.body?.reason === "string" ? req.body.reason : undefined;

    const result = await cancelAssignedJob({
      bookingId,
      professionalId: profile.id,
      professionalUserId: user.id,
      reason,
    });

    res.json(
      successResponse(
        result,
        result.alreadyCancelled
          ? "This job is already cancelled"
          : "Job cancelled"
      )
    );
  }
);

//////////////////////////////////////////////////////
// STATISTICS & REVIEWS
//////////////////////////////////////////////////////

export const getMyStatistics = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);

    const statistics = await getProfessionalStatistics(profile.id);

    res.json(successResponse(statistics, "Statistics fetched"));
  }
);

export const listMyReviews = catchAsync(
  async (req: AuthRequest, res: Response) => {
    const user = assertAuthenticatedUser(req);
    const profile = await requireOwnProfessionalProfile(user.id);

    const {
      page = "1",
      pageSize = "20",
    } = req.query as { page?: string; pageSize?: string };

    const pageNum = Math.max(1, Number(page) || 1);
    const limit = Math.min(Math.max(1, Number(pageSize) || 20), 100);
    const skip = (pageNum - 1) * limit;

    const where = { professionalId: profile.id, isVisible: true };

    const [total, reviews] = await Promise.all([
      prisma.serviceReview.count({ where }),
      prisma.serviceReview.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          rating: true,
          comment: true,
          createdAt: true,
          serviceNode: { select: { id: true, name: true, slug: true } },
          booking: { select: { id: true, displayId: true } },
        },
      }),
    ]);

    res.json(
      successResponse(reviews, "Reviews fetched", {
        page: pageNum,
        pageSize: limit,
        total,
        totalPages: Math.ceil(total / limit),
        averageRating: profile.averageRating,
        ratingCount: profile.ratingCount,
      })
    );
  }
);
