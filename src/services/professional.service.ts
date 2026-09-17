import { prisma } from "../lib/prisma";
import { AppError } from "../utils/AppError";

//////////////////////////////////////////////////////
// OWN PROFILE LOOKUP (self-scoped everywhere it's used)
//////////////////////////////////////////////////////

export const professionalProfileInclude = {
  branch: {
    select: { id: true, name: true },
  },
  services: {
    where: { isActive: true },
    include: {
      serviceNode: {
        select: { id: true, name: true, slug: true },
      },
    },
  },
  documents: {
    orderBy: { createdAt: "desc" as const },
  },
};

export type OwnProfessionalProfile = NonNullable<
  Awaited<ReturnType<typeof getOwnProfessionalProfile>>
>;

export const getOwnProfessionalProfile = (userId: string) =>
  prisma.professionalProfile.findUnique({
    where: { userId },
    include: professionalProfileInclude,
  });

export const requireOwnProfessionalProfile = async (
  userId: string
) => {
  const profile = await getOwnProfessionalProfile(userId);

  if (!profile) {
    throw new AppError(
      "Professional profile not found. Complete registration first.",
      404,
      "PROFESSIONAL_PROFILE_NOT_FOUND"
    );
  }

  return profile;
};

//////////////////////////////////////////////////////
// ONBOARDING STATUS
//////////////////////////////////////////////////////

export type OnboardingStep =
  | "CREATE_PROFILE"
  | "SELECT_SERVICES"
  | "SET_SERVICE_AREA"
  | "UPLOAD_DOCUMENTS"
  | "AWAITING_APPROVAL"
  | "APPROVED";

export const computeOnboardingStatus = (
  profile: OwnProfessionalProfile | null
) => {
  const hasProfile = Boolean(profile);
  const hasServices = Boolean(profile) && profile!.services.length > 0;
  const hasServiceArea =
    Boolean(profile) &&
    profile!.latitude != null &&
    profile!.longitude != null;
  const hasDocuments = Boolean(profile) && profile!.documents.length > 0;

  let nextStep: OnboardingStep;

  if (!hasProfile) {
    nextStep = "CREATE_PROFILE";
  } else if (!hasServices) {
    nextStep = "SELECT_SERVICES";
  } else if (!hasServiceArea) {
    nextStep = "SET_SERVICE_AREA";
  } else if (!hasDocuments) {
    nextStep = "UPLOAD_DOCUMENTS";
  } else if (profile!.verificationStatus === "APPROVED") {
    nextStep = "APPROVED";
  } else {
    nextStep = "AWAITING_APPROVAL";
  }

  return {
    hasProfile,
    hasServices,
    hasServiceArea,
    hasDocuments,
    verificationStatus: profile?.verificationStatus ?? null,
    isComplete:
      hasProfile && hasServices && hasServiceArea && hasDocuments,
    nextStep,
  };
};

export const getOnboardingStatusForUser = async (
  userId: string
) => {
  const profile = await getOwnProfessionalProfile(userId);
  return {
    profile,
    onboarding: computeOnboardingStatus(profile),
  };
};

//////////////////////////////////////////////////////
// LOOKUP BY PROFESSIONAL ID (admin surface)
//////////////////////////////////////////////////////

export const getProfessionalProfileById = (id: string) =>
  prisma.professionalProfile.findUnique({
    where: { id },
    include: professionalProfileInclude,
  });

export const requireProfessionalProfileById = async (
  id: string
) => {
  const profile = await getProfessionalProfileById(id);

  if (!profile) {
    throw new AppError("Professional not found", 404);
  }

  return profile;
};

//////////////////////////////////////////////////////
// SERVICE ELIGIBILITY (shared by self-service and admin management)
//////////////////////////////////////////////////////

export const assertServiceOfferable = async (
  serviceNodeId: string
) => {
  const serviceNode = await prisma.serviceNode.findFirst({
    where: { id: serviceNodeId, deletedAt: null },
    select: {
      id: true,
      type: true,
      isBookable: true,
      isActive: true,
    },
  });

  if (!serviceNode) {
    throw new AppError("Service not found", 404, "SERVICE_NOT_FOUND");
  }

  if (
    serviceNode.type !== "SERVICE" ||
    !serviceNode.isBookable ||
    !serviceNode.isActive
  ) {
    throw new AppError(
      "This service is not available for professionals to offer.",
      400,
      "SERVICE_NOT_OFFERABLE"
    );
  }

  return serviceNode;
};

//////////////////////////////////////////////////////
// PROFILE FIELD NORMALIZATION (shared by self-service and admin update)
//////////////////////////////////////////////////////

const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_BIO_LENGTH = 1000;
const MAX_EXPERIENCE_YEARS = 60;

export const normalizeDisplayName = (
  value: unknown,
  { required }: { required: boolean }
) => {
  if (value === undefined) {
    if (required) {
      throw new AppError("displayName is required", 400);
    }
    return undefined;
  }

  if (typeof value !== "string") {
    throw new AppError("displayName must be a string", 400);
  }

  const trimmed = value.trim();

  if (!trimmed) {
    throw new AppError("displayName is required", 400);
  }

  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new AppError(
      `displayName cannot exceed ${MAX_DISPLAY_NAME_LENGTH} characters`,
      400
    );
  }

  return trimmed;
};

export const normalizeBio = (value: unknown) => {
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (typeof value !== "string") {
    throw new AppError("bio must be a string", 400);
  }

  const trimmed = value.trim();

  if (trimmed.length > MAX_BIO_LENGTH) {
    throw new AppError(
      `bio cannot exceed ${MAX_BIO_LENGTH} characters`,
      400
    );
  }

  return trimmed || null;
};

export const normalizeExperienceYears = (value: unknown) => {
  if (value === undefined) return undefined;
  if (value === null) return null;

  const parsed = Number(value);

  if (
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > MAX_EXPERIENCE_YEARS
  ) {
    throw new AppError(
      `experienceYears must be a whole number between 0 and ${MAX_EXPERIENCE_YEARS}`,
      400
    );
  }

  return parsed;
};

export const normalizeProfileImageUrl = (value: unknown) => {
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (typeof value !== "string") {
    throw new AppError("profileImageUrl must be a string", 400);
  }

  return value.trim() || null;
};

export const resolveBranchId = async (value: unknown) => {
  if (value === undefined) return undefined;
  if (value === null) return null;

  if (typeof value !== "string" || !value.trim()) {
    throw new AppError("branchId must be a string", 400);
  }

  const branch = await prisma.branch.findFirst({
    where: { id: value, isActive: true, deletedAt: null },
    select: { id: true },
  });

  if (!branch) {
    throw new AppError("Branch not found", 404, "BRANCH_NOT_FOUND");
  }

  return branch.id;
};
