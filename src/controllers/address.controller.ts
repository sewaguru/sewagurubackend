import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { catchAsync } from "../utils/catchAsync";
import { successResponse } from "../utils/response.util";
import { AppError } from "../utils/AppError";
import {
  getCache,
  setCache,
  clearUserCache,
} from "../utils/cache";

//////////////////////////////////////////////////////
// HELPERS
//////////////////////////////////////////////////////

const getIdParam = (value: unknown): string => {
  if (!value || typeof value !== "string")
    throw new AppError("Invalid id", 400);

  return value;
};

//////////////////////////////////////////////////////
// GET USER ADDRESSES
//////////////////////////////////////////////////////

export const getAddresses = catchAsync(
  async (req: Request, res: Response) => {

    const userId = (req as any).user.id;

    const cacheKey = `addresses:${userId}`;
    const cached = getCache(cacheKey);

    if (cached)
      return res.json(
        successResponse(
          cached,
          "Addresses fetched (cached)"
        )
      );

    const addresses =
      await prisma.address.findMany({
        where: {
          userId,
          isActive: true,
        },
        include: {
          city: true,
        },
        orderBy: [
          { isPrimary: "desc" },
          { createdAt: "desc" },
        ],
      });

    setCache(cacheKey, addresses);

    res.json(
      successResponse(
        addresses,
        "Addresses fetched"
      )
    );
  }
);

//////////////////////////////////////////////////////
// ADD ADDRESS
//////////////////////////////////////////////////////

export const addAddress = catchAsync(
  async (req: Request, res: Response) => {

    const userId = (req as any).user.id;

    const {
      label,
      customLabel,
      contactName,
      contactPhone,
      addressLine1,
      addressLine2,
      buildingName,
      floor,
      doorNumber,
      locality,
      landmark,
      cityId,
      pincode,
      latitude,
      longitude,
      instructions,
      isPrimary,
    } = req.body;

    //////////////////////////////////////////////////
    // VALIDATION
    //////////////////////////////////////////////////
    if (!addressLine1)
      throw new AppError(
        "Required fields missing",
        400
      );

    if (
      latitude !== undefined &&
      typeof latitude !== "number"
    ) {
      throw new AppError(
        "latitude must be a number",
        400
      );
    }

    if (
      longitude !== undefined &&
      typeof longitude !== "number"
    ) {
      throw new AppError(
        "longitude must be a number",
        400
      );
    }

    let cityDerived:
      | { cityId: string; state: string; country: string }
      | undefined;

    if (cityId) {
      const city = await prisma.city.findUnique({
        where: { id: cityId },
      });
      if (!city)
        throw new AppError("Invalid city", 400);
      cityDerived = {
        cityId,
        state: city.state,
        country: city.country ?? "India",
      };
    }

    //////////////////////////////////////////////////
    // TRANSACTION
    //////////////////////////////////////////////////
    const address = await prisma.$transaction(
      async (tx) => {

        if (isPrimary) {
          await tx.address.updateMany({
            where: { userId },
            data: { isPrimary: false },
          });
        }

        return tx.address.create({
          data: {
            userId,

            label,
            customLabel,
            contactName,
            contactPhone,

            addressLine1,
            addressLine2,
            buildingName,
            floor,
            doorNumber,
            locality,
            landmark,

            ...cityDerived,

            latitude:
              typeof latitude ===
              "number"
                ? latitude
                : 0,
            longitude:
              typeof longitude ===
              "number"
                ? longitude
                : 0,

            ...(typeof pincode === "string" && pincode
              ? { pincode }
              : {}),
            instructions,

            isPrimary: !!isPrimary,
          },
          include: {
            city: true,
          },
        });
      }
    );

    clearUserCache(userId);

    res.json(
      successResponse(address, "Address added")
    );
  }
);

//////////////////////////////////////////////////////
// UPDATE ADDRESS
//////////////////////////////////////////////////////

export const updateAddress = catchAsync(
  async (req: Request, res: Response) => {

    const userId = (req as any).user.id;
    const id = getIdParam(req.params.id);

    const existing =
      await prisma.address.findFirst({
        where: {
          id,
          userId,
          isActive: true,
        },
      });

    if (!existing)
      throw new AppError("Address not found", 404);

    const { cityId, isPrimary, ...rest } =
      req.body;

    if (
      rest.latitude !== undefined &&
      typeof rest.latitude !== "number"
    ) {
      throw new AppError(
        "latitude must be a number",
        400
      );
    }

    if (
      rest.longitude !== undefined &&
      typeof rest.longitude !== "number"
    ) {
      throw new AppError(
        "longitude must be a number",
        400
      );
    }

    const updated =
      await prisma.$transaction(
        async (tx) => {

          let derivedData = {};

          if (cityId) {
            const city =
              await tx.city.findUnique({
                where: { id: cityId },
              });

            if (!city)
              throw new AppError(
                "Invalid city",
                400
              );

            derivedData = {
              cityId,
              state: city.state,
              country:
                city.country ?? "India",
            };
          }

          if (isPrimary) {
            await tx.address.updateMany({
              where: { userId },
              data: { isPrimary: false },
            });
          }

          return tx.address.update({
            where: { id },
            data: {
              ...rest,
              ...derivedData,
              ...(isPrimary !== undefined && {
                isPrimary,
              }),
            },
            include: {
              city: true,
            },
          });
        }
      );

    clearUserCache(userId);

    res.json(
      successResponse(
        updated,
        "Address updated"
      )
    );
  }
);

//////////////////////////////////////////////////////
// DELETE ADDRESS (SOFT)
//////////////////////////////////////////////////////

export const deleteAddress = catchAsync(
  async (req: Request, res: Response) => {

    const userId = (req as any).user.id;
    const id = getIdParam(req.params.id);

    const address =
      await prisma.address.findFirst({
        where: { id, userId },
      });

    if (!address)
      throw new AppError(
        "Address not found",
        404
      );

    await prisma.address.update({
      where: { id },
      data: { isActive: false },
    });

    clearUserCache(userId);

    res.json(
      successResponse(
        null,
        "Address removed"
      )
    );
  }
);

//////////////////////////////////////////////////////
// SET PRIMARY ADDRESS
//////////////////////////////////////////////////////

export const setPrimaryAddress =
  catchAsync(
    async (
      req: Request,
      res: Response
    ) => {

      const userId =
        (req as any).user.id;

      const id = getIdParam(
        req.params.id
      );

      const address =
        await prisma.address.findFirst({
          where: {
            id,
            userId,
            isActive: true,
          },
        });

      if (!address) {
        throw new AppError(
          "Address not found",
          404
        );
      }

      const updated =
        await prisma.$transaction(
          async (tx) => {

            await tx.address.updateMany({
              where: {
                userId,
                isActive: true,
              },
              data: {
                isPrimary: false,
              },
            });

            return tx.address.update({
              where: { id },
              data: {
                isPrimary: true,
              },
              include: {
                city: true,
              },
            });
          }
        );

      clearUserCache(userId);

      res.json(
        successResponse(
          updated,
          "Primary address updated"
        )
      );
    }
  );

//////////////////////////////////////////////////////
// GET SINGLE ADDRESS
//////////////////////////////////////////////////////

export const getAddressById =
  catchAsync(
    async (
      req: Request,
      res: Response
    ) => {

      const userId =
        (req as any).user.id;

      const id = getIdParam(
        req.params.id
      );

      const address =
        await prisma.address.findFirst({
          where: {
            id,
            userId,
            isActive: true,
          },
          include: {
            city: true,
          },
        });

      if (!address)
        throw new AppError(
          "Address not found",
          404
        );

      res.json(
        successResponse(
          address,
          "Address fetched"
        )
      );
    }
  );
