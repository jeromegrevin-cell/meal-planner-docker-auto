import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

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
  "http://localhost:5174",
  "http://127.0.0.1:5174"
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
    }
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

if (isProd && !apiKey) {
  throw new Error(
    "MEAL_PLANNER_API_KEY is required in production (refusing to start)"
  );
}

function requireApiKey(req, res, next) {
  if (!apiKey) return next(); // auth disabled in dev unless key is set

  const header =
    req.headers["x-api-key"] ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

  if (header && header === apiKey) return next();
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
