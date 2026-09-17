import { prisma } from "../lib/prisma";
import { AppError } from "../utils/AppError";

//////////////////////////////////////////////////////
// CREATE BRANCH
//////////////////////////////////////////////////////

export const createBranchService = async (data: {
  name: string;
  cityId: string;
  address: string;
  pincode: string;
  latitude: number;
  longitude: number;
  serviceRadiusKm?: number;
}) => {

  const city = await prisma.city.findUnique({
    where: { id: data.cityId },
    include: { branch: true },
  });

  if (!city)
    throw new AppError("City not found", 404);

  if (city.branch)
    throw new AppError(
      "Branch already exists for this city",
      400
    );

  return prisma.branch.create({
    data,
    include: { city: true },
  });
};

//////////////////////////////////////////////////////
// GET ALL BRANCHES
//////////////////////////////////////////////////////

export const getBranchesService = () =>
  prisma.branch.findMany({
    include: {
      city: true,
      admins: {
        include: { user: true },
      },
    },
  });

//////////////////////////////////////////////////////
// UPDATE BRANCH
//////////////////////////////////////////////////////

export const updateBranchService = async (
  id: string,
  data: any
) => {

  const branch =
    await prisma.branch.findUnique({
      where: { id },
    });

  if (!branch)
    throw new AppError(
      "Branch not found",
      404
    );

  return prisma.branch.update({
    where: { id },
    data,
  });
};