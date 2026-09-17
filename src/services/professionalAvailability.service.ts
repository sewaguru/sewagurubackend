import {
  ProfessionalAvailabilityStatus,
} from "../generated/prisma";
import { prisma } from "../lib/prisma";
import { AppError } from "../utils/AppError";
import {
  computeOnboardingStatus,
  OwnProfessionalProfile,
} from "./professional.service";

//////////////////////////////////////////////////////
// GO-ONLINE ELIGIBILITY
//////////////////////////////////////////////////////

export type GoOnlineEligibility =
  | { eligible: true; reason: null; code: null }
  | {
      eligible: false;
      reason: string;
      code:
        | "NOT_APPROVED"
        | "ACCOUNT_SUSPENDED"
        | "ACCOUNT_BLOCKED"
        | "ONBOARDING_INCOMPLETE";
    };

export const getGoOnlineEligibility = (
  profile: OwnProfessionalProfile
): GoOnlineEligibility => {
  if (profile.verificationStatus === "SUSPENDED") {
    return {
      eligible: false,
      reason:
        "Your professional account is suspended. You cannot go online.",
      code: "ACCOUNT_SUSPENDED",
    };
  }

  if (profile.verificationStatus === "BLOCKED") {
    return {
      eligible: false,
      reason:
        "Your professional account is blocked. You cannot go online.",
      code: "ACCOUNT_BLOCKED",
    };
  }

  if (profile.verificationStatus !== "APPROVED") {
    return {
      eligible: false,
      reason:
        "Your professional account is not yet approved. You cannot go online.",
      code: "NOT_APPROVED",
    };
  }

  const onboarding = computeOnboardingStatus(profile);

  if (!onboarding.isComplete) {
    return {
      eligible: false,
      reason:
        "Complete your onboarding (profile, services, service area, documents) before going online.",
      code: "ONBOARDING_INCOMPLETE",
    };
  }

  return { eligible: true, reason: null, code: null };
};

//////////////////////////////////////////////////////
// AVAILABILITY STATE MACHINE
//////////////////////////////////////////////////////

const ALLOWED_TRANSITIONS: Record<
  ProfessionalAvailabilityStatus,
  ProfessionalAvailabilityStatus[]
> = {
  OFFLINE: [ProfessionalAvailabilityStatus.ONLINE],
  ONLINE: [
    ProfessionalAvailabilityStatus.OFFLINE,
    ProfessionalAvailabilityStatus.BUSY,
  ],
  BUSY: [
    ProfessionalAvailabilityStatus.OFFLINE,
    ProfessionalAvailabilityStatus.ONLINE,
  ],
};

export const applyAvailabilityTransition = async ({
  profile,
  targetStatus,
}: {
  profile: OwnProfessionalProfile;
  targetStatus: ProfessionalAvailabilityStatus;
}) => {
  const currentStatus = profile.availabilityStatus;

  // Idempotent no-op: re-requesting the current state just refreshes the
  // timestamp instead of failing a transition-table lookup.
  if (currentStatus !== targetStatus) {
    const allowedTargets = ALLOWED_TRANSITIONS[currentStatus];

    if (!allowedTargets.includes(targetStatus)) {
      throw new AppError(
        `Cannot go ${targetStatus} while ${currentStatus}.`,
        409,
        "INVALID_AVAILABILITY_TRANSITION"
      );
    }

    if (targetStatus === ProfessionalAvailabilityStatus.ONLINE) {
      const eligibility = getGoOnlineEligibility(profile);

      if (!eligibility.eligible) {
        throw new AppError(eligibility.reason, 403, eligibility.code);
      }
    }
  }

  return prisma.professionalProfile.update({
    where: { id: profile.id },
    data: {
      availabilityStatus: targetStatus,
      availabilityUpdatedAt: new Date(),
    },
  });
};
