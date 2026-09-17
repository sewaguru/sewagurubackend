
import {
  ErrorResponse,
  SuccessResponse,
} from "../types/types";

//////////////////////////////////////////////////////
// SUCCESS RESPONSE
//////////////////////////////////////////////////////

export const successResponse = <T>(
  data: T,
  message = "Success",
  meta?: Record<string, any>
): SuccessResponse<T> => {

  return {
    status: true,
    success: true,
    message,
    data,
    ...(meta && { meta }),
  };
};

//////////////////////////////////////////////////////
// ERROR RESPONSE
//////////////////////////////////////////////////////

export const errorResponse = (
  message = "Something went wrong",
  code = "SERVER_ERROR"
): ErrorResponse => {

  return {
    status: false,
    success: false,
    message,
    code,
  };
};
