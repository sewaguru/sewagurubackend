import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { catchAsync } from "../utils/catchAsync";
import { successResponse } from "../utils/response.util";
import { AppError } from "../utils/AppError";
import { getParam } from "../utils/request.util";
import { AuthRequest } from "../types/types";
import { Prisma, Role } from "../generated/prisma";
import { DEFAULT_BRANCH_BOOKING_SETTINGS } from "../services/branchBookingSchedule.service";
import {
  moveBranchToTrash,
} from "../services/trash.service";
import { getAssignedBranchIds } from "../utils/branchScope.util";

// Alias kept so the many existing call sites below don't need renaming.
const getManagedBranchIds = getAssignedBranchIds;

const PINCODE_PATTERN = /^\d{6}$/;
const MAX_SERVICE_RADIUS_KM = 500;

const normalizeRequiredString = (
  value: unknown,
  label: string
) => {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw new AppError(
      `${label} is required`,
      400
    );
  }

  return value.trim();
};

const normalizePincode = (
  value: unknown
) => {
  const pincode =
    normalizeRequiredString(
      value,
      "pincode"
    );

  if (!PINCODE_PATTERN.test(pincode)) {
    throw new AppError(
      "pincode must be a 6 digit number",
      400
    );
  }

  return pincode;
};

const normalizeNumberInRange = (
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
) => {
  if (
    (typeof value !== "number" &&
      typeof value !== "string") ||
    (typeof value === "string" &&
      !value.trim())
  ) {
    throw new AppError(
      `${label} must be between ${minimum} and ${maximum}`,
      400
    );
  }

  const parsed = Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new AppError(
      `${label} must be between ${minimum} and ${maximum}`,
      400
    );
  }

  return parsed;
};

const normalizeCancellationCutoffMinutes =
  (value: unknown) => {
    if (
      (typeof value !== "number" &&
        typeof value !== "string") ||
      (typeof value === "string" &&
        !value.trim())
    ) {
      throw new AppError(
        "cancellationCutoffMinutes must be a whole number (0 or more)",
        400
      );
    }

    const parsed = Number(value);

    if (
      !Number.isFinite(parsed) ||
      !Number.isInteger(parsed) ||
      parsed < 0
    ) {
      throw new AppError(
        "cancellationCutoffMinutes must be a whole number (0 or more)",
        400
      );
    }

    return parsed;
  };

const getAvailableCity = async (
  cityIdValue: unknown,
  currentBranchId?: string
) => {
  const cityId =
    normalizeRequiredString(
      cityIdValue,
      "cityId"
    );
  const city =
    await prisma.city.findUnique({
      where: { id: cityId },
      include: {
        branch: {
          select: {
            id: true,
            deletedAt: true,
          },
        },
      },
    });

  if (!city) {
    throw new AppError(
      "Invalid city selected",
      400
    );
  }

  if (!city.isActive) {
    throw new AppError(
      "Select an active city for this branch",
      409
    );
  }

  if (
    city.branch &&
    city.branch.id !== currentBranchId
  ) {
    throw new AppError(
      city.branch.deletedAt
        ? "This city belongs to a branch in trash. Restore or permanently delete that branch before creating a new one."
        : "A branch already exists for this city",
      409
    );
  }

  return city;
};

const assertBranchCanBeActivated =
  async (id: string) => {
    const branch =
      await prisma.branch.findUnique({
        where: { id },
        select: {
          id: true,
          deletedAt: true,
          city: {
            select: {
              isActive: true,
            },
          },
        },
      });

    if (!branch) {
      throw new AppError(
        "Branch not found",
        404
      );
    }

    if (branch.deletedAt) {
      throw new AppError(
        "Restore this branch from trash before activating it",
        409
      );
    }

    if (!branch.city.isActive) {
      throw new AppError(
        "Enable the branch city before activating this branch",
        409
      );
    }

    const [
      assignedAdminCount,
      enabledServiceCount,
    ] = await Promise.all([
      prisma.branchAdmin.count({
        where: { branchId: id },
      }),
      prisma.branchService.count({
        where: {
          branchId: id,
          isActive: true,
          serviceNode: {
            isActive: true,
            isBookable: true,
            deletedAt: null,
          },
        },
      }),
    ]);

    if (assignedAdminCount === 0) {
      throw new AppError(
        "Assign at least one branch admin before activating this branch",
        409
      );
    }

    if (enabledServiceCount === 0) {
      throw new AppError(
        "Enable at least one active service before activating this branch",
        409
      );
    }
  };

//////////////////////////////////////////////////////
// CREATE BRANCH (ADMIN DASHBOARD)
//////////////////////////////////////////////////////

export const createBranch = catchAsync(
  async (req: Request, res: Response) => {

    const {
      name,
      cityId,
      address,
      pincode,
      latitude,
      longitude,
      serviceRadiusKm,
      cancellationCutoffMinutes,
    } = req.body;

    const normalizedCity =
      await getAvailableCity(cityId);
    const normalizedName =
      normalizeRequiredString(
        name,
        "name"
      );
    const normalizedAddress =
      normalizeRequiredString(
        address,
        "address"
      );
    const normalizedPincode =
      normalizePincode(pincode);
    const normalizedLatitude =
      normalizeNumberInRange(
        latitude,
        "latitude",
        -90,
        90
      );
    const normalizedLongitude =
      normalizeNumberInRange(
        longitude,
        "longitude",
        -180,
        180
      );
    const normalizedServiceRadiusKm =
      typeof serviceRadiusKm ===
        "undefined" ||
      serviceRadiusKm === null
        ? 20
        : normalizeNumberInRange(
            serviceRadiusKm,
            "serviceRadiusKm",
            0.1,
            MAX_SERVICE_RADIUS_KM
          );
    const normalizedCancellationCutoff =
      typeof cancellationCutoffMinutes ===
        "undefined" ||
      cancellationCutoffMinutes === null
        ? undefined
        : normalizeCancellationCutoffMinutes(
            cancellationCutoffMinutes
          );

    try {
      const branch =
        await prisma.branch.create({
          data: {
            name: normalizedName,
            cityId: normalizedCity.id,
            address:
              normalizedAddress,
            pincode:
              normalizedPincode,
            latitude:
              normalizedLatitude,
            longitude:
              normalizedLongitude,
            serviceRadiusKm:
              normalizedServiceRadiusKm,
            isActive: false,
            ...(typeof normalizedCancellationCutoff !==
            "undefined"
              ? {
                  cancellationCutoffMinutes:
                    normalizedCancellationCutoff,
                }
              : {}),
            bookingSettings: {
              create: {
                ...DEFAULT_BRANCH_BOOKING_SETTINGS,
              },
            },
          },
          include: { city: true },
        });

      res.json(
        successResponse(
          branch,
          "Branch draft created. Assign an admin and enable services before activation."
        )
      );
    } catch (error) {
      if (
        error instanceof
          Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new AppError(
          "A branch already exists for this city",
          409
        );
      }

      throw error;
    }
  }
);
//////////////////////////////////////////////////////
// ADMIN BRANCH LIST (INCLUDES ADMINS)
//////////////////////////////////////////////////////

export const getBranches = catchAsync(
  async (
    req: AuthRequest,
    res: Response
  ) => {
    if (!req.user) {
      throw new AppError(
        "Unauthorized",
        401
      );
    }

    res.setHeader(
      "Cache-Control",
      "no-store, max-age=0"
    );
    res.setHeader("Pragma", "no-cache");

    const {
      search,
      page = "1",
      pageSize = "20",
      includeAdmins = "false",
      includeInactive = "false",
    } = req.query as {
      search?: string;
      page?: string;
      pageSize?: string;
      includeAdmins?: string;
      includeInactive?: string;
    };

    const pageNum = Math.max(
      1,
      Number(page) || 1
    );

    const limit = Math.min(
      Math.max(
        1,
        Number(pageSize) || 20
      ),
      100
    );

    const skip = (pageNum - 1) * limit;

    const managedBranchIds =
      req.user.role === "SUPER_ADMIN"
        ? null
        : await getManagedBranchIds(
            req.user.id
          );

    if (
      managedBranchIds &&
      managedBranchIds.length === 0
    ) {
      return res.json(
        successResponse(
          [],
          "No branches assigned",
          {
            page: pageNum,
            pageSize: limit,
            total: 0,
            totalPages: 0,
          }
        )
      );
    }

    const where: Prisma.BranchWhereInput =
      managedBranchIds
        ? { id: { in: managedBranchIds } }
        : {};

    where.deletedAt = null;

    const withInactive =
      includeInactive === "true" ||
      includeInactive === "1";

    // For dashboard lists we default to showing active branches only.
    // Deleted branches are represented by isActive=false (soft delete).
    if (!withInactive) {
      where.isActive = true;
    }

    const q =
      typeof search === "string"
        ? search.trim()
        : "";

    if (q) {
      where.OR = [
        {
          name: {
            contains: q,
            mode: "insensitive",
          },
        },
        {
          address: {
            contains: q,
            mode: "insensitive",
          },
        },
        {
          pincode: {
            contains: q,
            mode: "insensitive",
          },
        },
        {
          city: {
            name: {
              contains: q,
              mode: "insensitive",
            },
          },
        },
      ];
    }

    const withAdmins =
      includeAdmins === "true" ||
      includeAdmins === "1";

    const [total, branches] =
      await Promise.all([
        prisma.branch.count({ where }),
        prisma.branch.findMany({
          where,
          skip,
          take: limit,
          orderBy: {
            createdAt: "desc",
          },
          include: {
            city: true,
            ...(withAdmins
              ? {
                  admins: {
                    include: {
                      user: {
                        include: {
                          profile: true,
                        },
                      },
                    },
                  },
                }
              : {}),
            _count: {
              select: { admins: true },
            },
          },
        }),
      ]);

    const formatted = branches.map(
      (b) => ({
        id: b.id,
        name: b.name,
        address: b.address,
        pincode: b.pincode,
        latitude: b.latitude,
        longitude: b.longitude,
        serviceRadiusKm: b.serviceRadiusKm,
        cancellationCutoffMinutes:
          b.cancellationCutoffMinutes,
        isActive: b.isActive,
        city: b.city,
        createdAt: b.createdAt,
        adminsCount: b._count.admins,
        ...(withAdmins
          ? { admins: b.admins }
          : {}),
      })
    );

    res.json(
      successResponse(
        formatted,
        "Branches fetched",
        {
          page: pageNum,
          pageSize: limit,
          total,
          totalPages: Math.ceil(
            total / limit
          ),
        }
      )
    );
  }
);

//////////////////////////////////////////////////////
// PUBLIC BRANCH LIST (FRONTEND WEBSITE)
//////////////////////////////////////////////////////

export const getPublicBranches =
  catchAsync(
    async (_: Request, res: Response) => {

      const branches =
        await prisma.branch.findMany({
          where: {
            isActive: true,
            deletedAt: null,
          },
          include: {
            city: true,
          },
          orderBy: {
            createdAt: "desc",
          },
        });

      const formatted = branches.map(
        (b) => ({
          id: b.id,
          name: b.name,
          address: b.address,
          pincode: b.pincode,
          latitude: b.latitude,
          longitude: b.longitude,
          serviceRadiusKm: b.serviceRadiusKm,
          cancellationCutoffMinutes:
            b.cancellationCutoffMinutes,
          city: {
            id: b.city.id,
            name: b.city.name,
            state: b.city.state,
            country: b.city.country,
          },
        })
      );

      res.json(
        successResponse(
          formatted,
          "Branches fetched"
        )
      );
    }
  );

export const getBranchById =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      if (!req.user) {
        throw new AppError(
          "Unauthorized",
          401
        );
      }

      const id = getParam(
        req.params.id,
        "branchId"
      );

      if (
        req.user.role !==
        "SUPER_ADMIN"
      ) {
        const branchIds =
          await getManagedBranchIds(
            req.user.id
          );

        if (
          !branchIds.includes(id)
        ) {
          throw new AppError(
            "Forbidden",
            403
          );
        }
      }

      const branch =
        await prisma.branch.findFirst({
          where: {
            id,
            deletedAt: null,
          },
          include: {
            city: true,
            admins: {
              include: {
                user: {
                  include: {
                    profile: true,
                  },
                },
              },
            },
          },
        });

      if (!branch)
        throw new AppError(
          "Branch not found",
          404
        );

      res.json(successResponse(branch));
    }
  );

//////////////////////////////////////////////////////
// DELETE BRANCH (SOFT DELETE)
//////////////////////////////////////////////////////

export const deleteBranch = catchAsync(
  async (
    req: AuthRequest,
    res: Response
  ) => {
    if (!req.user) {
      throw new AppError(
        "Unauthorized",
        401
      );
    }

    if (req.user.role !== "SUPER_ADMIN") {
      throw new AppError(
        "Forbidden",
        403
      );
    }

    const id = getParam(
      req.params.id,
      "branchId"
    );

    await prisma.branch.findUniqueOrThrow({
      where: { id },
    });

    const branch =
      await moveBranchToTrash(id);

    res.json(
      successResponse(
        branch,
        "Branch moved to trash. It will be permanently deleted after 30 days unless restored."
      )
    );
  }
);

const getBranchUpdateData = (
  role: string,
  body: Record<string, unknown>
) => {
  const allowedKeys =
    role === "SUPER_ADMIN"
      ? [
          "name",
          "cityId",
          "address",
          "pincode",
          "latitude",
          "longitude",
          "serviceRadiusKm",
          "cancellationCutoffMinutes",
        ]
      : [
          "name",
          "address",
          "pincode",
          "latitude",
          "longitude",
          "serviceRadiusKm",
          "cancellationCutoffMinutes",
        ];

  const rawData = Object.fromEntries(
    Object.entries(body).filter(
      ([key]) =>
        allowedKeys.includes(key)
    )
  );
  const data: Record<
    string,
    string | number
  > = {};

  if ("name" in rawData) {
    data.name =
      normalizeRequiredString(
        rawData.name,
        "name"
      );
  }

  if ("cityId" in rawData) {
    data.cityId =
      normalizeRequiredString(
        rawData.cityId,
        "cityId"
      );
  }

  if ("address" in rawData) {
    data.address =
      normalizeRequiredString(
        rawData.address,
        "address"
      );
  }

  if ("pincode" in rawData) {
    data.pincode =
      normalizePincode(
        rawData.pincode
      );
  }

  if ("latitude" in rawData) {
    data.latitude =
      normalizeNumberInRange(
        rawData.latitude,
        "latitude",
        -90,
        90
      );
  }

  if ("longitude" in rawData) {
    data.longitude =
      normalizeNumberInRange(
        rawData.longitude,
        "longitude",
        -180,
        180
      );
  }

  if ("serviceRadiusKm" in rawData) {
    data.serviceRadiusKm =
      normalizeNumberInRange(
        rawData.serviceRadiusKm,
        "serviceRadiusKm",
        0.1,
        MAX_SERVICE_RADIUS_KM
      );
  }

  if (
    "cancellationCutoffMinutes" in
    rawData
  ) {
    data.cancellationCutoffMinutes =
      normalizeCancellationCutoffMinutes(
        rawData
          .cancellationCutoffMinutes
      );
  }

  return data;
};

  export const updateBranch =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      if (!req.user) {
        throw new AppError(
          "Unauthorized",
          401
        );
      }

      const id = getParam(
        req.params.id,
        "branchId"
      );

      const branch =
        await prisma.branch.findFirst({
          where: {
            id,
            deletedAt: null,
          },
        });

      if (!branch) {
        throw new AppError(
          "Branch not found",
          404
        );
      }

      if (
        req.user.role !==
        "SUPER_ADMIN"
      ) {
        const branchIds =
          await getManagedBranchIds(
            req.user.id
          );

        if (
          !branchIds.includes(id)
        ) {
          throw new AppError(
            "Forbidden",
            403
          );
        }
      }

      const data =
        getBranchUpdateData(
          req.user.role,
          req.body as Record<
            string,
            unknown
          >
        );

      if (
        typeof data.cityId ===
        "string"
      ) {
        await getAvailableCity(
          data.cityId,
          id
        );
      }

      if (
        Object.keys(data).length ===
        0
      ) {
        throw new AppError(
          "No permitted branch fields provided",
          400
        );
      }

      let updated;

      try {
        updated =
          await prisma.branch.update({
            where: { id },
            data,
          });
      } catch (error) {
        if (
          error instanceof
            Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          throw new AppError(
            "A branch already exists for this city",
            409
          );
        }

        throw error;
      }

      res.json(
        successResponse(
          updated,
          "Branch updated"
        )
      );
    }
  );

  export const toggleBranchStatus =
  catchAsync(
    async (
      req: AuthRequest,
      res: Response
    ) => {
      if (!req.user) {
        throw new AppError(
          "Unauthorized",
          401
        );
      }

      const id = getParam(
        req.params.id,
        "branchId"
      );

      const { isActive } = req.body;

      if (typeof isActive !== "boolean")
        throw new AppError(
          "isActive must be boolean",
          400
        );

      if (
        req.user.role !==
        "SUPER_ADMIN"
      ) {
        const branchIds =
          await getManagedBranchIds(
            req.user.id
          );

        if (
          !branchIds.includes(id)
        ) {
          throw new AppError(
            "Forbidden",
            403
          );
        }
      }

      const existingBranch =
        await prisma.branch.findFirst({
          where: {
            id,
            deletedAt: null,
          },
          select: { id: true },
        });

      if (!existingBranch) {
        throw new AppError(
          "Branch not found",
          404
        );
      }

      if (isActive) {
        await assertBranchCanBeActivated(
          id
        );
      }

      const branch =
        await prisma.branch.update({
          where: { id },
          data: { isActive },
        });

      res.json(
        successResponse(
          branch,
          "Branch status updated"
        )
      );
    }
  );

  export const assignBranchAdmin =
  catchAsync(
    async (req: Request, res: Response) => {

      const branchId = getParam(
        req.params.id,
        "branchId"
      );

      const { userId, isHead } =
        req.body as {
          userId?: string;
          isHead?: boolean;
        };

      if (!userId) {
        throw new AppError(
          "userId required",
          400
        );
      }

      if (
        typeof isHead !== "undefined" &&
        typeof isHead !== "boolean"
      ) {
        throw new AppError(
          "isHead must be boolean",
          400
        );
      }

      const [branch, user] =
        await Promise.all([
          prisma.branch.findFirst({
            where: {
              id: branchId,
              deletedAt: null,
            },
            select: { id: true },
          }),
          prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, role: true },
          }),
        ]);

      if (!branch) {
        throw new AppError(
          "Branch not found",
          404
        );
      }

      if (!user) {
        throw new AppError(
          "User not found",
          404
        );
      }

      if (
        user.role !== Role.ADMIN &&
        user.role !== Role.BRANCH_ADMIN
      ) {
        throw new AppError(
          "Only ADMIN / BRANCH_ADMIN users can be assigned to branches",
          400
        );
      }

      const assignment =
        await prisma.branchAdmin.upsert({
          where: {
            userId_branchId: {
              userId,
              branchId,
            },
          },
          update: { isHead: Boolean(isHead) },
          create: {
            userId,
            branchId,
            isHead: Boolean(isHead),
          },
          include: {
            user: {
              include: {
                profile: true,
              },
            },
          },
        });

      res.json(
        successResponse(
          assignment,
          "Admin assigned"
        )
      );
    }
  );

  export const removeBranchAdmin =
  catchAsync(
    async (req: Request, res: Response) => {

      const branchId = getParam(
        req.params.id,
        "branchId"
      );

      const userId = getParam(
        req.params.userId,
        "userId"
      );

      const existing =
        await prisma.branchAdmin.findUnique(
          {
            where: {
              userId_branchId: {
                userId,
                branchId,
              },
            },
            select: { id: true },
          }
        );

      if (!existing) {
        throw new AppError(
          "Admin assignment not found",
          404
        );
      }

      await prisma.branchAdmin.delete(
        {
          where: {
            userId_branchId: {
              userId,
              branchId,
            },
          },
        }
      );

      res.json(
        successResponse(
          null,
          "Admin removed"
        )
      );
    }
  );

  
