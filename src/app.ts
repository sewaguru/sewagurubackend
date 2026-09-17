import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser"; 
import passport from "passport";
import routes from "./routes";
import { notFoundMiddleware } from "./middlewares/notFound.middleware";
import { config } from "./config/config";
import { globalErrorHandler } from "./middlewares/error.middleware";
import { initializeGoogleStrategy } from "./auth/google.strategy";

const app = express();
initializeGoogleStrategy();

const normalizeOrigin = (origin: string) => {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.trim().replace(/\/+$/, "");
  }
};

/* ====== TRUST PROXY SETTING ====== */
if (config.TRUST_PROXY) {
  app.set("trust proxy", 1);
}

/* ====== SECURITY HEADERS ====== */
app.use(helmet());

/* ====== LOGGER ====== */
if (config.NODE_ENV !== "production") {
  app.use(morgan("dev"));
}

/* ====== CORS CONFIG ====== */
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow tools like Postman or server-to-server calls
      if (!origin) return callback(null, true);

      const normalizedOrigin = normalizeOrigin(origin);

      // Dev ergonomics: if ALLOWED_ORIGINS isn't set, don't block local UI.
      if (
        config.NODE_ENV !== "production" &&
        config.ALLOWED_ORIGINS.length === 0
      ) {
        return callback(null, true);
      }

      if (config.ALLOWED_ORIGINS.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  })
);

/* ====== COOKIE PARSER ====== */
app.use(cookieParser()); 
app.use(passport.initialize());

/* ====== BODY PARSERS ====== */

// Only parse JSON if content-type is exactly application/json
app.use(
  express.json({
    limit: "20mb",
    type: ["application/json"],
    verify: (
      req: express.Request & {
        rawBody?: string;
      },
      _res,
      buf
    ) => {
      req.rawBody = buf.toString("utf8");
    },
  })
)

// Parse urlencoded normally
app.use(
  express.urlencoded({
    extended: true,
    limit: "20mb",
  })
)



/* ====== ROUTES ====== */
app.get("/", (req, res) => {
  res.json({
    status: true,
    message: "Sewaguru Backend API Running",
    environment: process.env.NODE_ENV,
  });
});

app.use("/api", routes);

/* ====== HEALTH CHECK ====== */
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    env: config.NODE_ENV,
    runtimeSource:
      process.env.RUNTIME_SOURCE ??
      "unknown",
    runtimeEntry:
      process.env.RUNTIME_ENTRY ??
      "unknown",
    time: new Date(),
  });
});

/* ====== ERROR HANDLING ====== */
app.use(notFoundMiddleware);
app.use(globalErrorHandler);

export default app;
