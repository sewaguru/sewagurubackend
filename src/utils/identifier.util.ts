import { AppError } from "./AppError";

export type IdentifierType =
  | "PHONE"
  | "EMAIL";

const normalizeEmail = (
  value: string
) => value.trim().toLowerCase();

const normalizeIndianPhone = (
  value: string
) => {
  const digits = value.replace(/\D/g, "");

  if (digits.length === 10) {
    return `91${digits}`;
  }

  if (
    digits.length === 11 &&
    digits.startsWith("0")
  ) {
    return `91${digits.slice(1)}`;
  }

  if (
    digits.length === 12 &&
    digits.startsWith("91")
  ) {
    return digits;
  }

  throw new AppError(
    "Invalid phone number",
    400,
    "INVALID_PHONE"
  );
};

export const inferIdentifierType = (
  identifier: string
): IdentifierType =>
  identifier.includes("@")
    ? "EMAIL"
    : "PHONE";

export const normalizeIdentifier = (
  identifier: string,
  type: IdentifierType
) =>
  type === "EMAIL"
    ? normalizeEmail(identifier)
    : normalizeIndianPhone(identifier);

export const normalizeAuthIdentifier = (
  input: string
) => {
  const raw = input.trim();

  if (!raw) {
    throw new AppError(
      "Identifier required",
      400
    );
  }

  const type = inferIdentifierType(raw);

  return {
    identifierType: type,
    identifier: normalizeIdentifier(
      raw,
      type
    ),
    rawIdentifier: raw,
  };
};

export const getIdentifierLookupCandidates = (
  rawIdentifier: string,
  normalizedIdentifier: string,
  type: IdentifierType
) => {
  const candidates = new Set<string>();

  candidates.add(normalizedIdentifier);
  candidates.add(rawIdentifier.trim());

  if (type === "PHONE") {
    const digits = rawIdentifier.replace(
      /\D/g,
      ""
    );

    if (digits.length === 10) {
      candidates.add(digits);
    }

    if (
      digits.length === 12 &&
      digits.startsWith("91")
    ) {
      candidates.add(digits.slice(2));
    }
  }

  return [...candidates].filter(Boolean);
};

