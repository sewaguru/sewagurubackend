-- Adds Sign in with Apple support alongside the existing Google login.
--
-- APPLE: a new AuthProvider value for the UserAuth row created when a user
-- signs in with their Apple ID.
--
-- APPLE_SUB: a new AuthIdentifierType value used only for the APPLE
-- provider's UserAuth row. Apple's identity token only carries email/name
-- on the user's first-ever authorization for this app; every subsequent
-- sign-in may omit them. Apple's "sub" claim (a stable, per-user,
-- per-app identifier) is present on every sign-in, so it — not email — is
-- what repeat logins are looked up by.

ALTER TYPE "AuthProvider" ADD VALUE IF NOT EXISTS 'APPLE';
ALTER TYPE "AuthIdentifierType" ADD VALUE IF NOT EXISTS 'APPLE_SUB';
