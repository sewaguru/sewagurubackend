import { prisma } from "../lib/prisma";
import { assertIdentifierNotPermanentlyDeleted } from "./account-deletion.service";

export async function findOrCreateUser(
  identifier: string,
  type: "PHONE" | "EMAIL"
) {
  //////////////////////////////////////////////////
  // EXISTING AUTH
  //////////////////////////////////////////////////
  const auth =
    await prisma.userAuth.findFirst({
      where: {
        identifier,
        identifierType: type,
      },
      include: { user: true },
    });

  if (auth) return auth.user;

  await assertIdentifierNotPermanentlyDeleted({
    identifier,
    identifierType: type,
  });

  //////////////////////////////////////////////////
  // CREATE USER
  //////////////////////////////////////////////////
  const user = await prisma.user.create({
    data: {},
  });

  //////////////////////////////////////////////////
  // CREATE LOGIN METHOD
  //////////////////////////////////////////////////
  await prisma.userAuth.create({
    data: {
      userId: user.id,
      identifier,
      identifierType: type,
      provider:
        type === "PHONE"
          ? "PHONE_OTP"
          : "EMAIL_OTP",
      isPrimary: true,
      isVerified: true,
    },
  });

  return user;
}
