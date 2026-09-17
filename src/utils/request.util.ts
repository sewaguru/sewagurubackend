import { AppError } from "./AppError";

export const getParam = (
  value: unknown,
  name = "parameter"
): string => {

  if (!value || typeof value !== "string") {
    throw new AppError(
      `Invalid ${name}`,
      400
    );
  }

  return value;
};