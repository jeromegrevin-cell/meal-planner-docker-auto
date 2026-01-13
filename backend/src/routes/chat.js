import express from "express";
import path from "path";
import fs from "fs/promises";
import OpenAI from "openai";
import { readJson, writeJson } from "../lib/jsonStore.js";

const router = express.Router();

const CHAT_DIR = path.join(process.cwd(), "data", "chat_sessions");

// ---------- OpenAI lazy client ----------
let cachedClient = null;
let cachedKey = null;

function getOpenAIClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  if (!cachedClient || cachedKey !== key) {
    cachedClient = new OpenAI({ apiKey: key });
    cachedKey = key;
  }
  return cachedClient;
}

function getModel() {
  return process.env.OPENAI_MODEL || "gpt-5.2";
}

// ---------- Utils ----------
function nowIso() {
  return new Date().toISOString();
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function chatPath(weekId) {
  return path.join(CHAT_DIR, `${weekId}.json`);
}

async function ensureChatFile(weekId) {
  await ensureDir(CHAT_DIR);

  const p = chatPath(weekId);
  try {
    const data = await readJson(p);
    return { path: p, data };
  } catch (e) {
    if (e?.code !== "ENOENT" && e?.code !== "EMPTY_JSON") throw e;

    const fresh = {
      week_id: weekId,
      messages: [],
      usage_totals: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0
      },
      usage_by_model: {},
      updated_at: nowIso()
    };
    await writeJson(p, fresh);
    return { path: p, data: fresh };
  }
}

function addUsage(session, model, usage) {
  if (!usage) return;

  const input = Number(usage.input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  const total =
    usage.total_tokens != null ? usage.total_tokens : input + output;

  session.usage_totals.input_tokens += input;
  session.usage_totals.output_tokens += output;
  session.usage_totals.total_tokens += total;

  if (!session.usage_by_model[model]) {
    session.usage_by_model[model] = {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0
    };
  }

  session.usage_by_model[model].input_tokens += input;
  session.usage_by_model[model].output_tokens += output;
  session.usage_by_model[model].total_tokens += total;
}

// ---------- Routes ----------

/**
 * GET /api/chat/current?week_id=2026-W02
 */
router.get("/current", async (req, res) => {
  const weekId = String(req.query.week_id || "");
  if (!weekId) return res.status(400).json({ error: "missing_week_id" });

  try {
    const { data } = await ensureChatFile(weekId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "chat_read_failed", details: e.message });
  }
});

/**
 * POST /api/chat/current
 */
router.post("/current", async (req, res) => {
  const weekId = String(req.body?.week_id || "");
  const message = String(req.body?.message || "");
  const context = req.body?.context || null;

  if (!weekId) return res.status(400).json({ error: "missing_week_id" });
  if (!message.trim())
    return res.status(400).json({ error: "missing_message" });

  try {
    const { path: p, data } = await ensureChatFile(weekId);

    data.messages.push({
      role: "user",
      content: message,
      context,
      created_at: nowIso()
    });

    let assistantText = "";
    let usage = null;
    let warning = null;

    const openai = getOpenAIClient();
    const model = getModel();

    if (openai) {
      try {
        const system = {
          role: "system",
          content:
            "Tu es l'assistant du cockpit menus. Reponds en francais, court, actionnable."
        };

        const history = data.messages
          .slice(-20)
          .map((m) => ({ role: m.role, content: m.content }));

        const resp = await openai.responses.create({
          model,
          input: [system, ...history]
        });

        assistantText = resp.output_text || "(aucune reponse)";
        usage = resp.usage || null;
      } catch (e) {
        assistantText = e?.message || "OpenAI error";
        warning = "openai_error";
      }
    } else {
      assistantText = "OpenAI non configure.";
      warning = "openai_not_configured";
    }

    data.messages.push({
      role: "assistant",
      content: assistantText,
      context,
      created_at: nowIso(),
      usage: usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      model
    });

    addUsage(data, model, usage);

    data.updated_at = nowIso();
    await writeJson(p, data);

    res.json({ ...data, ...(warning ? { warning } : {}) });
  } catch (e) {
    res.status(500).json({ error: "chat_write_failed", details: e.message });
  }
});

/**
 * GET /api/chat/usage?week_id=2026-W02
 */
router.get("/usage", async (req, res) => {
  const weekId = String(req.query.week_id || "");
  if (!weekId) return res.status(400).json({ error: "missing_week_id" });

  try {
    const { data } = await ensureChatFile(weekId);
    res.json({
      week_id: weekId,
      usage_totals: data.usage_totals,
      usage_by_model: data.usage_by_model,
      updated_at: data.updated_at
    });
  } catch (e) {
    res.status(500).json({ error: "usage_read_failed", details: e.message });
  }
});

/**
 * GET /api/chat/usage/all
 */
router.get("/usage/all", async (_req, res) => {
  try {
    await ensureDir(CHAT_DIR);
    const files = await fs.readdir(CHAT_DIR);
    const out = [];

    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const raw = await readJson(path.join(CHAT_DIR, f));
      out.push({
        week_id: raw.week_id,
        total_tokens: raw.usage_totals?.total_tokens ?? 0
      });
    }

    out.sort((a, b) => a.week_id.localeCompare(b.week_id));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: "usage_all_failed", details: e.message });
  }
});

// ------------------------------------------------------------------
// Backward compatibility / Tokens aliases
// IMPORTANT: must match "" AND "/" when mounted with app.use()
// ------------------------------------------------------------------

const redirectToUsageAll = (_req, res) => {
  res.redirect(302, "/api/chat/usage/all");
};

// GET /api/chat
router.get("", redirectToUsageAll);

// GET /api/chat/
router.get("/", redirectToUsageAll);

// legacy aliases
router.get("/tokens", redirectToUsageAll);
router.get("/usage/tokens", redirectToUsageAll);

export default router;
