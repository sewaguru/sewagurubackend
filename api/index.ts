// Vercel serverless entry point. Vercel's Node builder invokes this file
// directly per-request instead of running a long-lived process, so it must
// export the Express app (no app.listen()) rather than go through
// src/server.ts, which starts an HTTP server and background jobs meant for
// a traditional long-running host (Docker/VM), not a serverless function.
import app from "../src/app";

export default app;
