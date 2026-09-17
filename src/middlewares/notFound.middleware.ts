import { Request, Response } from "express";
import { errorResponse } from "../utils/response.util";

export const notFoundMiddleware = (req: Request, res: Response) => {
  res.status(404).json(
    errorResponse(
      "Route Not Found",
      "NOT_FOUND"
    )
  );
};
