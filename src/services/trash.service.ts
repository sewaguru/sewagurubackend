import { Prisma } from "../generated/prisma";
import { prisma } from "../lib/prisma";
import { clearUserCache } from "../utils/cache";
import { AppError } from "../utils/AppError";
import { permanentlyAnonymizeUser } from "./account-deletion.service";

export const TRASH_GRACE_DAYS = 30;
const DORMANT_USER_RETENTION_DAYS =
  30;
const TRASH_PURGE_INTERVAL_MS =
  6 * 60 * 60 * 1000;

export type TrashEntityType =
  | "SERVICE"
  | "USER"
  | "BRANCH"
  | "BOOKING";

export type TrashSummary = Record<
  TrashEntityType,
  number
>;

export type TrashListItem = {
  entityType: TrashEntityType;
  id: string;
  title: string;
  subtitle: string | null;
  deletedAt: string;
  scheduledPurgeAt: string;
};

const addDays = (
  date: Date,
  days: number
) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

export const createTrashWindow = (
  now = new Date()
) => ({
  deletedAt: now,
  scheduledPurgeAt: addDays(
    now,
    TRASH_GRACE_DAYS
  ),
});

const collectServiceSubtreeIds = async (
  tx: Prisma.TransactionClient,
  rootId: string
) => {
  const nodes =
    await tx.serviceNode.findMany({
      select: {
        id: true,
        parentId: true,
      },
    });

  const childrenMap = new Map<
    string,
    string[]
  >();

  for (const node of nodes) {
    if (!node.parentId) continue;

    const siblings =
      childrenMap.get(node.parentId) ??
      [];
    siblings.push(node.id);
    childrenMap.set(
      node.parentId,
      siblings
    );
  }

  const ids = new Set<string>();
  const stack = [rootId];

  while (stack.length) {
    const current =
      stack.pop();

    if (!current) continue;
    if (ids.has(current)) continue;

    ids.add(current);

    const children =
      childrenMap.get(current);

    if (children?.length) {
      stack.push(...children);
    }
  }

  return [...ids];
};

const permanentlyDeleteBookingTx =
  async (
    tx: Prisma.TransactionClient,
    id: string
  ) => {
    await tx.booking.delete({
      where: { id },
    });
  };

const permanentlyDeleteBranchTx =
  async (
    tx: Prisma.TransactionClient,
    id: string
  ) => {
    await tx.cart.deleteMany({
      where: { branchId: id },
    });

    await tx.booking.deleteMany({
      where: { branchId: id },
    });

    await tx.coupon.deleteMany({
      where: { branchId: id },
    });

    await tx.offer.deleteMany({
      where: { branchId: id },
    });

    await tx.branchService.deleteMany({
      where: { branchId: id },
    });

    await tx.branchAdmin.deleteMany({
      where: { branchId: id },
    });

    await tx.branch.delete({
      where: { id },
    });
  };

const permanentlyDeleteServiceTreeTx =
  async (
    tx: Prisma.TransactionClient,
    id: string
  ) => {
    const deleteIds =
      await collectServiceSubtreeIds(
        tx,
        id
      );

    await tx.cartItem.deleteMany({
      where: {
        serviceNodeId: {
          in: deleteIds,
        },
      },
    });

    await tx.branchService.deleteMany({
      where: {
        serviceNodeId: {
          in: deleteIds,
        },
      },
    });

    await tx.bookingItem.updateMany({
      where: {
        serviceNodeId: {
          in: deleteIds,
        },
      },
      data: {
        serviceNodeId: null,
      },
    });

    await tx.serviceNode.deleteMany({
      where: {
        id: {
          in: deleteIds,
        },
      },
    });

    return deleteIds.length;
  };

export const moveUserToTrash = async (
  id: string
) => {
  const trashWindow =
    createTrashWindow();

  const user =
    await prisma.user.update({
      where: { id },
      data: {
        isActive: false,
        deletedAt:
          trashWindow.deletedAt,
        scheduledPurgeAt:
          trashWindow.scheduledPurgeAt,
      },
    });

  clearUserCache(id);
  return user;
};

export const restoreUserFromTrash =
  async (id: string) => {
    const user =
      await prisma.user.update({
        where: { id },
        data: {
          isActive: true,
          deletedAt: null,
          scheduledPurgeAt: null,
        },
      });

    clearUserCache(id);
    return user;
  };

export const permanentlyDeleteUser =
  async (id: string) => {
    await permanentlyAnonymizeUser({
      userId: id,
      mode: "TRASH_PURGE",
    });

    clearUserCache(id);
  };

export const moveBookingToTrash =
  async (
    id: string,
    actorId?: string | null,
    message = "Booking moved to trash from dashboard."
  ) => {
    return prisma.booking.update({
      where: { id },
      data: {
        isActive: false,
        ...createTrashWindow(),
        timeline: {
          create: {
            message,
            createdById:
              actorId ?? null,
          },
        },
      },
    });
  };

export const restoreBookingFromTrash =
  async (
    id: string,
    actorId?: string | null
  ) => {
    return prisma.booking.update({
      where: { id },
      data: {
        isActive: true,
        deletedAt: null,
        scheduledPurgeAt: null,
        timeline: {
          create: {
            message:
              "Booking restored from trash.",
            createdById:
              actorId ?? null,
          },
        },
      },
    });
  };

export const permanentlyDeleteBooking =
  async (id: string) => {
    await prisma.$transaction(
      async (tx) => {
        await permanentlyDeleteBookingTx(
          tx,
          id
        );
      }
    );
  };

export const moveBranchToTrash =
  async (id: string) => {
    return prisma.$transaction(
      async (tx) => {
        await tx.cart.deleteMany({
          where: { branchId: id },
        });

        return tx.branch.update({
          where: { id },
          data: {
            isActive: false,
            ...createTrashWindow(),
          },
        });
      }
    );
  };

export const restoreBranchFromTrash =
  async (id: string) => {
    return prisma.branch.update({
      where: { id },
      data: {
        isActive: true,
        deletedAt: null,
        scheduledPurgeAt: null,
      },
    });
  };

export const permanentlyDeleteBranch =
  async (id: string) => {
    await prisma.$transaction(
      async (tx) => {
        await permanentlyDeleteBranchTx(
          tx,
          id
        );
      }
    );
  };

export const moveServiceTreeToTrash =
  async (id: string) => {
    return prisma.$transaction(
      async (tx) => {
        const root =
          await tx.serviceNode.findUnique({
            where: { id },
            select: {
              id: true,
              deletedAt: true,
            },
          });

        if (!root) {
          throw new AppError(
            "Service not found",
            404,
            "SERVICE_NOT_FOUND"
          );
        }

        if (root.deletedAt) {
          throw new AppError(
            "Service is already in trash",
            409
          );
        }

        const deleteIds =
          await collectServiceSubtreeIds(
            tx,
            id
          );

        await tx.cartItem.deleteMany({
          where: {
            serviceNodeId: {
              in: deleteIds,
            },
          },
        });

        const result =
          await tx.serviceNode.updateMany(
            {
              where: {
                id: {
                  in: deleteIds,
                },
              },
              data: {
                isActive: false,
                ...createTrashWindow(),
              },
            }
          );

        return {
          deletedCount:
            result.count,
        };
      }
    );
  };

export const restoreServiceTreeFromTrash =
  async (id: string) => {
    return prisma.$transaction(
      async (tx) => {
        const root =
          await tx.serviceNode.findUnique({
            where: { id },
            select: {
              id: true,
              deletedAt: true,
            },
          });

        if (!root) {
          throw new AppError(
            "Service not found",
            404,
            "SERVICE_NOT_FOUND"
          );
        }

        if (!root.deletedAt) {
          throw new AppError(
            "Service is not in trash",
            409
          );
        }

        const ids =
          await collectServiceSubtreeIds(
            tx,
            id
          );

        const result =
          await tx.serviceNode.updateMany(
            {
              where: {
                id: {
                  in: ids,
                },
              },
              data: {
                isActive: true,
                deletedAt: null,
                scheduledPurgeAt: null,
              },
            }
          );

        return {
          restoredCount:
            result.count,
        };
      }
    );
  };

export const permanentlyDeleteServiceTree =
  async (id: string) => {
    return prisma.$transaction(
      async (tx) => {
        const root =
          await tx.serviceNode.findUnique({
            where: { id },
            select: {
              id: true,
              deletedAt: true,
            },
          });

        if (!root) {
          throw new AppError(
            "Service not found",
            404,
            "SERVICE_NOT_FOUND"
          );
        }

        const deletedCount =
          await permanentlyDeleteServiceTreeTx(
            tx,
            id
          );

        return {
          deletedCount,
        };
      }
    );
  };

const listDeletedServices =
  async (search: string) => {
    const services =
      await prisma.serviceNode.findMany({
        where: {
          AND: [
            {
              deletedAt: {
                not: null,
              },
            },
            {
              OR: [
                { parentId: null },
                {
                  parent: {
                    is: {
                      deletedAt: null,
                    },
                  },
                },
              ],
            },
            ...(search
              ? [
                  {
                    OR: [
                      {
                        name: {
                          contains:
                            search,
                          mode:
                            Prisma.QueryMode.insensitive,
                        },
                      },
                      {
                        slug: {
                          contains:
                            search,
                          mode:
                            Prisma.QueryMode.insensitive,
                        },
                      },
                    ],
                  },
                ]
              : []),
          ],
        },
        select: {
          id: true,
          name: true,
          slug: true,
          type: true,
          deletedAt: true,
          scheduledPurgeAt: true,
        },
        orderBy: {
          deletedAt: "desc",
        },
      });

    return services.map(
      (service): TrashListItem => ({
        entityType: "SERVICE",
        id: service.id,
        title: service.name,
        subtitle: `${service.type} | ${service.slug}`,
        deletedAt:
          service.deletedAt?.toISOString() ??
          new Date().toISOString(),
        scheduledPurgeAt:
          service.scheduledPurgeAt?.toISOString() ??
          new Date().toISOString(),
      })
    );
  };

const listDeletedUsers =
  async (search: string) => {
    const users =
      await prisma.user.findMany({
        where: {
          deletedAt: {
            not: null,
          },
          ...(search
            ? {
                OR: [
                  {
                    profile: {
                      is: {
                        fullName: {
                          contains:
                            search,
                          mode:
                            Prisma.QueryMode.insensitive,
                        },
                      },
                    },
                  },
                  {
                    authMethods: {
                      some: {
                        identifier: {
                          contains:
                            search,
                          mode:
                            Prisma.QueryMode.insensitive,
                        },
                      },
                    },
                  },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          role: true,
          deletedAt: true,
          scheduledPurgeAt: true,
          profile: {
            select: {
              fullName: true,
            },
          },
          authMethods: {
            select: {
              identifier: true,
            },
            take: 2,
          },
        },
        orderBy: {
          deletedAt: "desc",
        },
      });

    return users.map(
      (user): TrashListItem => ({
        entityType: "USER",
        id: user.id,
        title:
          user.profile?.fullName?.trim() ||
          user.authMethods[0]
            ?.identifier ||
          "Deleted user",
        subtitle:
          user.authMethods
            .map((item) =>
              item.identifier.trim()
            )
            .filter(Boolean)
            .join(" | ") ||
          user.role,
        deletedAt:
          user.deletedAt?.toISOString() ??
          new Date().toISOString(),
        scheduledPurgeAt:
          user.scheduledPurgeAt?.toISOString() ??
          new Date().toISOString(),
      })
    );
  };

const listDeletedBranches =
  async (search: string) => {
    const branches =
      await prisma.branch.findMany({
        where: {
          deletedAt: {
            not: null,
          },
          ...(search
            ? {
                OR: [
                  {
                    name: {
                      contains:
                        search,
                      mode:
                        Prisma.QueryMode.insensitive,
                    },
                  },
                  {
                    city: {
                      name: {
                        contains:
                          search,
                        mode:
                          Prisma.QueryMode.insensitive,
                      },
                    },
                  },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          name: true,
          deletedAt: true,
          scheduledPurgeAt: true,
          city: {
            select: {
              name: true,
              state: true,
            },
          },
        },
        orderBy: {
          deletedAt: "desc",
        },
      });

    return branches.map(
      (branch): TrashListItem => ({
        entityType: "BRANCH",
        id: branch.id,
        title: branch.name,
        subtitle: branch.city
          ? `${branch.city.name}, ${branch.city.state}`
          : null,
        deletedAt:
          branch.deletedAt?.toISOString() ??
          new Date().toISOString(),
        scheduledPurgeAt:
          branch.scheduledPurgeAt?.toISOString() ??
          new Date().toISOString(),
      })
    );
  };

const listDeletedBookings =
  async (search: string) => {
    const bookings =
      await prisma.booking.findMany({
        where: {
          deletedAt: {
            not: null,
          },
          ...(search
            ? {
                OR: [
                  {
                    displayId: {
                      contains:
                        search,
                      mode:
                        Prisma.QueryMode.insensitive,
                    },
                  },
                  {
                    user: {
                      is: {
                        profile: {
                          is: {
                            fullName: {
                              contains:
                                search,
                              mode:
                                Prisma.QueryMode.insensitive,
                            },
                          },
                        },
                      },
                    },
                  },
                  {
                    branch: {
                      is: {
                        name: {
                          contains:
                            search,
                          mode:
                            Prisma.QueryMode.insensitive,
                        },
                      },
                    },
                  },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          displayId: true,
          status: true,
          paymentStatus: true,
          deletedAt: true,
          scheduledPurgeAt: true,
          user: {
            select: {
              profile: {
                select: {
                  fullName: true,
                },
              },
            },
          },
          branch: {
            select: {
              name: true,
            },
          },
        },
        orderBy: {
          deletedAt: "desc",
        },
      });

    return bookings.map(
      (booking): TrashListItem => ({
        entityType: "BOOKING",
        id: booking.id,
        title:
          booking.displayId ||
          booking.id,
        subtitle: [
          booking.user?.profile
            ?.fullName,
          booking.branch?.name,
          `${booking.status} / ${booking.paymentStatus}`,
        ]
          .filter(Boolean)
          .join(" | "),
        deletedAt:
          booking.deletedAt?.toISOString() ??
          new Date().toISOString(),
        scheduledPurgeAt:
          booking.scheduledPurgeAt?.toISOString() ??
          new Date().toISOString(),
      })
    );
  };

export const listTrashItems =
  async ({
    entityType,
    search = "",
    page = 1,
    pageSize = 20,
  }: {
    entityType?: TrashEntityType;
    search?: string;
    page?: number;
    pageSize?: number;
  }) => {
    const trimmedSearch =
      search.trim();

    const [
      services,
      users,
      branches,
      bookings,
    ] = await Promise.all([
      !entityType ||
      entityType === "SERVICE"
        ? listDeletedServices(
            trimmedSearch
          )
        : Promise.resolve([]),
      !entityType ||
      entityType === "USER"
        ? listDeletedUsers(
            trimmedSearch
          )
        : Promise.resolve([]),
      !entityType ||
      entityType === "BRANCH"
        ? listDeletedBranches(
            trimmedSearch
          )
        : Promise.resolve([]),
      !entityType ||
      entityType === "BOOKING"
        ? listDeletedBookings(
            trimmedSearch
          )
        : Promise.resolve([]),
    ]);

    const items = [
      ...services,
      ...users,
      ...branches,
      ...bookings,
    ].sort((a, b) =>
      b.deletedAt.localeCompare(
        a.deletedAt
      )
    );

    const summary: TrashSummary = {
      SERVICE: services.length,
      USER: users.length,
      BRANCH: branches.length,
      BOOKING: bookings.length,
    };

    const total = items.length;
    const totalPages = total
      ? Math.ceil(total / pageSize)
      : 0;
    const start =
      (page - 1) * pageSize;

    return {
      items: items.slice(
        start,
        start + pageSize
      ),
      meta: {
        page,
        pageSize,
        total,
        totalPages,
        summary,
      },
    };
  };

export const purgeExpiredTrash =
  async () => {
    const now = new Date();
    const result = {
      SERVICE: 0,
      USER: 0,
      BRANCH: 0,
      BOOKING: 0,
    } as TrashSummary;

    const expiredBookings =
      await prisma.booking.findMany({
        where: {
          deletedAt: { not: null },
          scheduledPurgeAt: {
            lte: now,
          },
        },
        select: { id: true },
      });

    for (const booking of expiredBookings) {
      await permanentlyDeleteBooking(
        booking.id
      );
      result.BOOKING += 1;
    }

    const expiredUsers =
      await prisma.user.findMany({
        where: {
          deletedAt: { not: null },
          scheduledPurgeAt: {
            lte: now,
          },
        },
        select: { id: true },
      });

    for (const user of expiredUsers) {
      await permanentlyDeleteUser(
        user.id
      );
      result.USER += 1;
    }

    const expiredBranches =
      await prisma.branch.findMany({
        where: {
          deletedAt: { not: null },
          scheduledPurgeAt: {
            lte: now,
          },
        },
        select: { id: true },
      });

    for (const branch of expiredBranches) {
      await permanentlyDeleteBranch(
        branch.id
      );
      result.BRANCH += 1;
    }

    const expiredServices =
      await prisma.serviceNode.findMany({
        where: {
          deletedAt: { not: null },
          scheduledPurgeAt: {
            lte: now,
          },
          OR: [
            { parentId: null },
            {
              parent: {
                is: {
                  deletedAt: null,
                },
              },
            },
          ],
        },
        select: { id: true },
      });

    for (const service of expiredServices) {
      const purgeResult =
        await permanentlyDeleteServiceTree(
          service.id
        );
      result.SERVICE +=
        purgeResult.deletedCount;
    }

    return result;
  };

export const purgeDormantUsers =
  async () => {
    const cutoffDate =
      new Date();
    cutoffDate.setDate(
      cutoffDate.getDate() -
        DORMANT_USER_RETENTION_DAYS
    );

    const dormantUsers =
      await prisma.user.findMany({
        where: {
          role: "USER",
          isActive: true,
          deletedAt: null,
          bookings: {
            none: {},
          },
          OR: [
            {
              lastActiveAt: {
                lte: cutoffDate,
              },
            },
            {
              lastActiveAt: null,
              createdAt: {
                lte: cutoffDate,
              },
            },
          ],
        },
        select: {
          id: true,
        },
      });

    for (const user of dormantUsers) {
      await permanentlyDeleteUser(
        user.id
      );
    }

    return dormantUsers.length;
  };

export const startTrashCleanupJob =
  () => {
    const runCleanup = () => {
      void Promise.all([
        purgeExpiredTrash(),
        purgeDormantUsers(),
      ])
        .then(
          ([
            result,
            dormantDeletedCount,
          ]) => {
          const totalPurged =
            Object.values(result).reduce(
              (sum, count) =>
                sum + count,
              0
            ) +
            dormantDeletedCount;

          if (totalPurged > 0) {
            console.log(
              `[TRASH] Purged ${totalPurged} record(s) from expired trash.`,
              {
                trash: result,
                dormantUsers:
                  dormantDeletedCount,
              }
            );
          }
        }
        )
        .catch((error) => {
          console.error(
            "[TRASH] Failed to purge expired trash",
            error
          );
        });
    };

    runCleanup();

    const timer = setInterval(
      runCleanup,
      TRASH_PURGE_INTERVAL_MS
    );

    timer.unref?.();

    return () => {
      clearInterval(timer);
    };
  };

