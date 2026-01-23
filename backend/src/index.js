import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

import weeksRoutes from "./routes/weeks.js";
import healthRoutes from "./routes/health.js";
import chatRoutes from "./routes/chat.js";
import recipeFilesRoutes from "./routes/recipeFiles.js";
import driveRoutes from "./routes/drive.js";

dotenv.config();

const app = express();

// --------------------
// Base middleware
// --------------------
const rawCors = (process.env.CORS_ORIGINS || "").trim();
const defaultCors = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8003",
  "http://127.0.0.1:8003"
];
const allowedOrigins = new Set(
  (rawCors ? rawCors.split(",") : defaultCors).map((s) => s.trim())
);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.has(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true
  })
);
app.use(express.json());

// --------------------
// Paths helpers
// --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------
// API auth
// --------------------
const isProd = (process.env.NODE_ENV || "").trim() === "production";
const apiKey = (process.env.MEAL_PLANNER_API_KEY || "").trim();
const authPassword =
  (process.env.MEAL_PLANNER_AUTH_PASSWORD || "").trim() || apiKey;

if (isProd && !authPassword && !apiKey) {
  throw new Error(
    "MEAL_PLANNER_AUTH_PASSWORD or MEAL_PLANNER_API_KEY is required in production (refusing to start)"
  );
}

const sessionTtlHours = Number(process.env.MEAL_PLANNER_SESSION_TTL_HOURS || 12);
const sessions = new Map(); // token -> expiresAt (ms)

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const [k, v] = part.split("=").map((s) => s?.trim());
    if (k) out[k] = decodeURIComponent(v || "");
  }
  return out;
}

function getSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  return cookies.mp_session || "";
}

function isSessionValid(token) {
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function requireApiKey(req, res, next) {
  if (!authPassword && !apiKey) return next(); // auth disabled in dev unless key is set

  const header =
    req.headers["x-api-key"] ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

  if (apiKey && header && header === apiKey) return next();
  if (isSessionValid(getSessionToken(req))) return next();
  return res.status(401).json({ error: "unauthorized" });
}

const protectAllApi =
  isProd ||
  (process.env.MEAL_PLANNER_API_PROTECT_ALL || "").trim() === "1";

// --------------------
// Static files (PDFs)
// --------------------
const pdfsPublic = (process.env.MEAL_PLANNER_PDFS_PUBLIC || "").trim() === "1";
if (pdfsPublic) {
  console.warn("[backend] WARNING: /pdfs is public (MEAL_PLANNER_PDFS_PUBLIC=1)");
}
if (pdfsPublic) {
  app.use("/pdfs", express.static(path.join(__dirname, "../pdfs")));
} else {
  app.use("/pdfs", requireApiKey, express.static(path.join(__dirname, "../pdfs")));
}

// --------------------
// Health checks
// --------------------
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// --------------------
// Auth (session cookie)
// --------------------
app.post("/api/auth/login", (req, res) => {
  const password = String(req.body?.password || "");
  if (!authPassword) {
    return res.status(500).json({ error: "auth_not_configured" });
  }
  if (password !== authPassword) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + sessionTtlHours * 60 * 60 * 1000;
  sessions.set(token, expiresAt);

  res.cookie("mp_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    maxAge: sessionTtlHours * 60 * 60 * 1000
  });
  return res.json({ ok: true, expires_in_hours: sessionTtlHours });
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("mp_session");
  return res.json({ ok: true });
});

// Data health (JSON integrity)
app.use("/api/health", healthRoutes);

// --------------------
// API routes
// --------------------
if (protectAllApi) {
  app.use("/api", requireApiKey);
}

app.use("/api/weeks", weeksRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/recipes", recipeFilesRoutes);
app.use("/api/drive", requireApiKey, driveRoutes);

// --------------------
// Server start
// --------------------
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`[backend] listening on http://${HOST}:${PORT}`);
});
