import {
  Request,
  Response,
  NextFunction,
  RequestHandler,
} from "express";

//////////////////////////////////////////////////////
// ASYNC WRAPPER (TYPE SAFE)
//////////////////////////////////////////////////////

export const catchAsync =
  (
    fn: (
      req: Request,
      res: Response,
      next: NextFunction
    ) => Promise<any>
  ): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(
      fn(req, res, next)
    ).catch(next);
  };