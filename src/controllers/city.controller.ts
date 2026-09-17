import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { catchAsync } from "../utils/catchAsync";
import { successResponse } from "../utils/response.util";
import { AppError } from "../utils/AppError";

//////////////////////////////////////////////////////
// GET ALL CITIES
//////////////////////////////////////////////////////

export const getCities = catchAsync(
  async (req: Request, res: Response) => {
    const includeInactive =
      req.query.includeInactive ===
      "true";

    const cities =
      await prisma.city.findMany({
        ...(!includeInactive
          ? {
              where: {
                isActive: true,
              },
            }
          : {}),
        orderBy: {
          name: "asc",
        },
        include: {
          branch: {
            select: {
              id: true,
            },
          },
        },
      });

    res.json(
      successResponse(
        cities.map(
          ({ branch, ...city }) => ({
            ...city,
            hasBranch:
              Boolean(branch),
          })
        )
      )
    );
  }
);

const normalizeCityString = (
  value: unknown,
  field: string
) => {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw new AppError(
      `${field} is required`,
      400
    );
  }

  return value.trim();
};

const getCityIdParam = (
  value: string | string[] | undefined
) => {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw new AppError(
      "City id is required",
      400
    );
  }

  return value.trim();
};

export const createCity = catchAsync(
  async (req: Request, res: Response) => {
    const name =
      normalizeCityString(
        req.body?.name,
        "name"
      );
    const state =
      normalizeCityString(
        req.body?.state,
        "state"
      );
    const country =
      typeof req.body?.country ===
        "string" &&
      req.body.country.trim()
        ? req.body.country.trim()
        : "India";

    const existing =
      await prisma.city.findUnique({
        where: {
          name_state: {
            name,
            state,
          },
        },
      });

    if (existing) {
      throw new AppError(
        "City already exists for this state",
        409
      );
    }

    const city = await prisma.city.create({
      data: {
        name,
        state,
        country,
        isActive: true,
      },
    });

    res.json(
      successResponse(
        city,
        "City created"
      )
    );
  }
);

export const updateCity = catchAsync(
  async (req: Request, res: Response) => {
    const id = getCityIdParam(
      req.params.id
    );

    const existing =
      await prisma.city.findUnique({
        where: { id },
      });

    if (!existing) {
      throw new AppError(
        "City not found",
        404
      );
    }

    const name =
      req.body?.name !== undefined
        ? normalizeCityString(
            req.body.name,
            "name"
          )
        : existing.name;
    const state =
      req.body?.state !== undefined
        ? normalizeCityString(
            req.body.state,
            "state"
          )
        : existing.state;
    const country =
      req.body?.country !== undefined
        ? normalizeCityString(
            req.body.country,
            "country"
          )
        : existing.country;

    const duplicate =
      await prisma.city.findFirst({
        where: {
          id: { not: id },
          name,
          state,
        },
      });

    if (duplicate) {
      throw new AppError(
        "Another city with this name and state already exists",
        409
      );
    }

    const city = await prisma.city.update({
      where: { id },
      data: {
        name,
        state,
        country,
      },
    });

    res.json(
      successResponse(
        city,
        "City updated"
      )
    );
  }
);

export const toggleCityStatus =
  catchAsync(
    async (
      req: Request,
      res: Response
    ) => {
      const id = getCityIdParam(
        req.params.id
      );

      if (
        typeof req.body?.isActive !==
        "boolean"
      ) {
        throw new AppError(
          "isActive must be a boolean",
          400
        );
      }

      const city =
        await prisma.city.findUnique({
          where: { id },
          include: {
            branch: {
              select: {
                id: true,
                isActive: true,
              },
            },
          },
        });

      if (!city) {
        throw new AppError(
          "City not found",
          404
        );
      }

      if (
        req.body.isActive === false &&
        city.branch?.isActive
      ) {
        throw new AppError(
          "Deactivate the active branch for this city before disabling the city",
          409
        );
      }

      const updated =
        await prisma.city.update({
          where: { id },
          data: {
            isActive:
              req.body.isActive,
          },
        });

      res.json(
        successResponse(
          updated,
          req.body.isActive
            ? "City enabled"
            : "City disabled"
        )
      );
    }
  );
