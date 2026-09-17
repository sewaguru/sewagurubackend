import { Request } from "express";

//////////////////////////////////////////////////////
// USER ROLES (MATCH PRISMA ENUM)
//////////////////////////////////////////////////////

export type UserRole =
  | "USER"
  | "ADMIN"
  | "BRANCH_ADMIN"
  | "SUPER_ADMIN"
  | "PROFESSIONAL";

//////////////////////////////////////////////////////
// AUTH IDENTIFIER
//////////////////////////////////////////////////////

export type AuthIdentifierType =
  | "PHONE"
  | "EMAIL";

//////////////////////////////////////////////////////
// JWT AUTH PAYLOAD ⭐
//////////////////////////////////////////////////////

export interface AuthUser {

  /** cuid() string */
  id: string;

  role: UserRole;

  /**
   * optional because
   * login can be phone OR email
   */
  identifier?: string;

  identifierType?: AuthIdentifierType;

  /**
   * dashboard usage
   */
  branchId?: string;

  /**
   * optional oauth fields
   */
  email?: string;
  name?: string;
  picture?: string | null;
  googleId?: string;
}

//////////////////////////////////////////////////////
// EXTENDED EXPRESS REQUEST
//////////////////////////////////////////////////////

export interface AuthRequest extends Request {
  user?: AuthUser | undefined;
}

declare global {
  namespace Express {
    interface User extends AuthUser {}
  }
}

//////////////////////////////////////////////////////
// STANDARD SUCCESS RESPONSE
//////////////////////////////////////////////////////

export interface SuccessResponse<T = unknown> {
  status: true;
  success: true;
  message: string;
  data?: T;
  meta?: Record<string, any>;
}

//////////////////////////////////////////////////////
// STANDARD ERROR RESPONSE
//////////////////////////////////////////////////////

export interface ErrorResponse {
  status: false;
  success: false;
  message: string;
  code?: string;
}

//////////////////////////////////////////////////////
// OTP TYPES (SYNC WITH PRISMA)
//////////////////////////////////////////////////////

export type OTPType =
  | "LOGIN"
  | "REGISTER"
  | "CHECKOUT"
  | "PHONE_UPDATE"
  | "ACCOUNT_RECOVERY"
  | "ACCOUNT_DELETE"
  | "ADMIN_INVITE";

