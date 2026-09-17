import {
  NotificationType,
  ProfessionalVerificationStatus,
} from "../generated/prisma";
import { prisma } from "../lib/prisma";
import { AppError } from "../utils/AppError";
import { createNotification } from "./notification.service";

export type VerificationAction =
  | "review"
  | "approve"
  | "reject"
  | "suspend"
  | "block"
  | "reactivate";

type TransitionRule = {
  from: ProfessionalVerificationStatus[] | "any-but-target";
  to: ProfessionalVerificationStatus;
  reasonRequired: boolean;
  notification?: {
    type: NotificationType;
    title: string;
    message: (note: string | null) => string;
  };
};

const TRANSITIONS: Record<VerificationAction, TransitionRule> = {
  review: {
    from: [ProfessionalVerificationStatus.PENDING],
    to: ProfessionalVerificationStatus.UNDER_REVIEW,
    reasonRequired: false,
  },
  approve: {
    from: [
      ProfessionalVerificationStatus.PENDING,
      ProfessionalVerificationStatus.UNDER_REVIEW,
      ProfessionalVerificationStatus.REJECTED,
    ],
    to: ProfessionalVerificationStatus.APPROVED,
    reasonRequired: false,
    notification: {
      type: NotificationType.PROFESSIONAL_APPROVED,
      title: "Application approved",
      message: () =>
        "Your professional profile has been approved by SewaGuru.",
    },
  },
  reject: {
    from: [
      ProfessionalVerificationStatus.PENDING,
      ProfessionalVerificationStatus.UNDER_REVIEW,
    ],
    to: ProfessionalVerificationStatus.REJECTED,
    reasonRequired: true,
    notification: {
      type: NotificationType.PROFESSIONAL_REJECTED,
      title: "Application not approved",
      message: (note) =>
        note
          ? `Your professional application was not approved. Reason: ${note}`
          : "Your professional application was not approved.",
    },
  },
  suspend: {
    from: [ProfessionalVerificationStatus.APPROVED],
    to: ProfessionalVerificationStatus.SUSPENDED,
    reasonRequired: true,
    notification: {
      type: NotificationType.PROFESSIONAL_SUSPENDED,
      title: "Account suspended",
      message: (note) =>
        note
          ? `Your professional account has been suspended. Reason: ${note}`
          : "Your professional account has been suspended.",
    },
  },
  block: {
    // Block is the universal escape hatch: allowed from any state except
    // an already-blocked one, regardless of where the professional is in
    // the onboarding/approval lifecycle.
    from: "any-but-target",
    to: ProfessionalVerificationStatus.BLOCKED,
    reasonRequired: true,
    // Intentionally no notification — matches the explicit event list
    // (approved/rejected/suspended/reactivated only).
  },
  reactivate: {
    from: [
      ProfessionalVerificationStatus.SUSPENDED,
      ProfessionalVerificationStatus.BLOCKED,
    ],
    to: ProfessionalVerificationStatus.APPROVED,
    reasonRequired: false,
    notification: {
      type: NotificationType.PROFESSIONAL_REACTIVATED,
      title: "Account reactivated",
      message: () =>
        "Your professional account has been reactivated. You are approved again.",
    },
  },
};

const describeStatuses = (
  statuses: ProfessionalVerificationStatus[]
) => statuses.join(", ");

export const applyVerificationTransition = async ({
  professionalId,
  action,
  adminUserId,
  note,
}: {
  professionalId: string;
  action: VerificationAction;
  adminUserId: string;
  note?: string | null;
}) => {
  const rule = TRANSITIONS[action];

  const profile = await prisma.professionalProfile.findUnique({
    where: { id: professionalId },
    select: { id: true, userId: true, verificationStatus: true },
  });

  if (!profile) {
    throw new AppError("Professional not found", 404);
  }

  const currentStatus = profile.verificationStatus;

  const isAllowed =
    rule.from === "any-but-target"
      ? currentStatus !== rule.to
      : rule.from.includes(currentStatus);

  if (!isAllowed) {
    const allowedDescription =
      rule.from === "any-but-target"
        ? `any status other than ${rule.to}`
        : describeStatuses(rule.from);

    throw new AppError(
      `Cannot ${action} a professional from status ${currentStatus}. Allowed from: ${allowedDescription}.`,
      409,
      "INVALID_VERIFICATION_TRANSITION"
    );
  }

  const trimmedNote =
    typeof note === "string" && note.trim() ? note.trim() : null;

  if (rule.reasonRequired && !trimmedNote) {
    throw new AppError(
      `A reason is required to ${action} a professional.`,
      400,
      "REASON_REQUIRED"
    );
  }

  const updated = await prisma.professionalProfile.update({
    where: { id: profile.id },
    data: {
      verificationStatus: rule.to,
      verificationNote: trimmedNote,
      verifiedAt: new Date(),
      verifiedById: adminUserId,
    },
  });

  if (rule.notification) {
    try {
      await createNotification({
        userId: profile.userId,
        type: rule.notification.type,
        title: rule.notification.title,
        message: rule.notification.message(trimmedNote),
        linkUrl: "/professional/onboarding-status",
        data: {
          professionalId: profile.id,
          verificationStatus: rule.to,
        },
      });
    } catch (error) {
      console.error(
        "[PROFESSIONAL_ADMIN] Failed to send lifecycle notification",
        { professionalId: profile.id, action, error }
      );
    }
  }

  return updated;
};
