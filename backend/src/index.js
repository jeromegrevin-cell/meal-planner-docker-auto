import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import weeksRoutes from "./routes/weeks.js";
import healthRoutes from "./routes/health.js";
import chatRoutes from "./routes/chat.js";
import recipeFilesRoutes from "./routes/recipeFiles.js";


dotenv.config();

const app = express();

// --------------------
// Base middleware
// --------------------
app.use(cors());
app.use(express.json());

// --------------------
// Paths helpers
// --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------
// Static files (PDFs)
// --------------------
app.use("/pdfs", express.static(path.join(__dirname, "../pdfs")));

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
app.use("/api/weeks", weeksRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/recipes", recipeFilesRoutes);


// --------------------
// Server start
// --------------------
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`[backend] listening on port ${PORT}`);
});
