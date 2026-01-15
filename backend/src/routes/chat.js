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

function normalizeSlotKey(slot) {
  return String(slot || "").trim();
}

function normalizeTitle(title) {
  return String(title || "").trim();
}

function newProposalId() {
  return `p_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function peopleSignature(people) {
  const adults = Number.isFinite(people?.adults) ? people.adults : 0;
  const children = Number.isFinite(people?.children) ? people.children : 0;
  const months = Array.isArray(people?.child_birth_months)
    ? people.child_birth_months.join(",")
    : "";
  return `${adults}|${children}|${months}`;
}

async function ensureChatFile(weekId) {
  await ensureDir(CHAT_DIR);

  const p = chatPath(weekId);
  try {
    const data = await readJson(p);

    if (!data.menu_proposals || typeof data.menu_proposals !== "object") {
      data.menu_proposals = {};
    }

    return { path: p, data };
  } catch (e) {
    if (e?.code !== "ENOENT" && e?.code !== "EMPTY_JSON") throw e;

    const fresh = {
      week_id: weekId,
      messages: [],
      menu_proposals: {},
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
  const total = usage.total_tokens != null ? usage.total_tokens : input + output;

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
 * GET /api/chat/proposals?week_id=2026-W04
 */
router.get("/proposals", async (req, res) => {
  const weekId = String(req.query.week_id || "");
  if (!weekId) return res.status(400).json({ error: "missing_week_id" });

  try {
    const { data } = await ensureChatFile(weekId);
    res.json({ week_id: weekId, menu_proposals: data.menu_proposals || {} });
  } catch (e) {
    res.status(500).json({ error: "proposals_read_failed", details: e.message });
  }
});

/**
 * POST /api/chat/proposals/import
 */
router.post("/proposals/import", async (req, res) => {
  const weekId = String(req.body?.week_id || "");
  const proposals = req.body?.proposals || null;

  if (!weekId) return res.status(400).json({ error: "missing_week_id" });
  if (!proposals || typeof proposals !== "object") {
    return res.status(400).json({ error: "missing_proposals" });
  }

  try {
    const { path: p, data } = await ensureChatFile(weekId);
    if (!data.menu_proposals || typeof data.menu_proposals !== "object") {
      data.menu_proposals = {};
    }

    const createdAt = nowIso();

    for (const [slotRaw, listRaw] of Object.entries(proposals)) {
      const slot = normalizeSlotKey(slotRaw);
      if (!slot) continue;

      const list = Array.isArray(listRaw) ? listRaw : [];
      if (!data.menu_proposals[slot]) data.menu_proposals[slot] = [];

      for (const item of list) {
        const title =
          typeof item === "string"
            ? normalizeTitle(item)
            : normalizeTitle(item?.title);

        if (!title) continue;

        data.menu_proposals[slot].push({
          proposal_id: newProposalId(),
          title,
          source: "CHAT_IMPORT",
          status: "PROPOSED",
          to_save: false,
          created_at: createdAt
        });
      }
    }

    data.updated_at = nowIso();
    await writeJson(p, data);

    res.json({ ok: true, week_id: weekId, menu_proposals: data.menu_proposals });
  } catch (e) {
    res.status(500).json({ error: "proposals_import_failed", details: e.message });
  }
});

/**
 * POST /api/chat/proposals/generate
 * body: { week_id, slots, overwrite }
 */
router.post("/proposals/generate", async (req, res) => {
  const weekId = String(req.body?.week_id || "");
  const slots = Array.isArray(req.body?.slots) ? req.body.slots : [];
  const overwrite = !!req.body?.overwrite;

  if (!weekId) return res.status(400).json({ error: "missing_week_id" });
  if (slots.length === 0) {
    return res.status(400).json({ error: "missing_slots" });
  }

  try {
    const { path: p, data } = await ensureChatFile(weekId);
    if (!data.menu_proposals || typeof data.menu_proposals !== "object") {
      data.menu_proposals = {};
    }

    const openai = getOpenAIClient();
    if (!openai) {
      return res.status(500).json({ error: "openai_not_configured" });
    }

    const model = getModel();

    const prompt = [
      "Donne un menu hebdomadaire au format strict suivant (une ligne par slot):",
      ...slots.map((s) => `- ${s}: <titre>`),
      "Aucun texte en plus."
    ].join("\n");

    const resp = await openai.responses.create({
      model,
      input: prompt
    });

    const rawText = resp.output_text || "";
    const lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);

    const createdAt = nowIso();

    for (const line of lines) {
      const m = line.match(/^[-*]\s*([a-z_]+)\s*:\s*(.+)$/i);
      if (!m) continue;

      const slot = normalizeSlotKey(m[1]);
      const title = normalizeTitle(m[2]);
      if (!slot || !title) continue;

      if (!slots.includes(slot)) continue;

      if (overwrite) {
        data.menu_proposals[slot] = [];
      } else if (!data.menu_proposals[slot]) {
        data.menu_proposals[slot] = [];
      }

      const existingTitles = new Set(
        (data.menu_proposals[slot] || []).map((p) =>
          String(p?.title || "").trim().toLowerCase()
        )
      );
      const titleKey = title.toLowerCase();
      if (existingTitles.has(titleKey)) continue;

      data.menu_proposals[slot].push({
        proposal_id: newProposalId(),
        title,
        source: "CHAT_GENERATED",
        status: "PROPOSED",
        to_save: false,
        created_at: createdAt
      });
    }

    data.updated_at = nowIso();
    await writeJson(p, data);

    res.json({
      ok: true,
      week_id: weekId,
      menu_proposals: data.menu_proposals,
      raw_text: rawText
    });
  } catch (e) {
    res.status(500).json({ error: "proposals_generate_failed", details: e.message });
  }
});

/**
 * POST /api/chat/proposals/preview
 * body: { week_id, slot, proposal_id, title }
 * Returns preview and stores it on the proposal.
 */
router.post("/proposals/preview", async (req, res) => {
  const weekId = String(req.body?.week_id || "");
  const slot = String(req.body?.slot || "");
  const proposalId = String(req.body?.proposal_id || "");
  const title = String(req.body?.title || "");
  const people = req.body?.people || null;

  if (!weekId) return res.status(400).json({ error: "missing_week_id" });
  if (!slot) return res.status(400).json({ error: "missing_slot" });
  if (!proposalId) return res.status(400).json({ error: "missing_proposal_id" });
  if (!title) return res.status(400).json({ error: "missing_title" });

  try {
    const { path: p, data } = await ensureChatFile(weekId);
    const list = data.menu_proposals?.[slot] || [];
    const idx = list.findIndex((x) => x?.proposal_id === proposalId);
    if (idx === -1) return res.status(404).json({ error: "proposal_not_found" });

    const signature = peopleSignature(people);

    // Return cached preview if present and people match
    if (list[idx].preview && list[idx].preview_people_signature === signature) {
      return res.json({ ok: true, preview: list[idx].preview });
    }

    const openai = getOpenAIClient();
    if (!openai) {
      return res.status(500).json({ error: "openai_not_configured" });
    }

    const model = getModel();
    const peopleLine = people
      ? `Personnes: ${people.adults || 0} adulte(s), ${people.children || 0} enfant(s) (${(people.child_birth_months || []).join(", ") || "n/a"}).`
      : "";

    const prompt = [
      `Génère une fiche courte de recette pour : "${title}".`,
      peopleLine,
      "Réponds STRICTEMENT en JSON avec ces clés:",
      '{"description_courte":"...", "ingredients":[{"item":"...","qty":"...","unit":"..."}], "preparation_steps":["...","..."]}',
      "IMPORTANT: preparation_steps doit contenir au moins 3 étapes."
    ].join("\n");

    const resp = await openai.responses.create({
      model,
      input: prompt
    });

    const raw = resp.output_text || "";
    let preview = null;
    try {
      preview = JSON.parse(raw);
    } catch (_e) {
      return res.status(500).json({ error: "preview_parse_failed", raw_text: raw });
    }

    list[idx].preview = preview;
    list[idx].preview_people_signature = signature;
    data.menu_proposals[slot] = list;
    data.updated_at = nowIso();
    await writeJson(p, data);

    return res.json({ ok: true, preview });
  } catch (e) {
    return res.status(500).json({ error: "preview_failed", details: e.message });
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
// ------------------------------------------------------------------
const redirectToUsageAll = (_req, res) => {
  res.redirect(302, "/api/chat/usage/all");
};

router.get("", redirectToUsageAll);
router.get("/", redirectToUsageAll);
router.get("/tokens", redirectToUsageAll);
router.get("/usage/tokens", redirectToUsageAll);

export default router;
