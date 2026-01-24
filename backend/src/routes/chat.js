import express from "express";
import path from "path";
import fs from "fs/promises";
import fsSync from "fs";
import { DATA_DIR, PROJECT_ROOT } from "../lib/dataPaths.js";
import OpenAI from "openai";
import { readJson, writeJson } from "../lib/jsonStore.js";

const router = express.Router();

const CHAT_DIR = path.join(DATA_DIR, "chat_sessions");
const RECIPES_DIR = path.join(DATA_DIR, "recipes");
const CHAT_PERSIST = process.env.CHAT_PERSIST !== "0";
const CHAT_RETENTION_DAYS = Number(process.env.CHAT_RETENTION_DAYS || 0);

// ---------- OpenAI lazy client ----------
let cachedClient = null;
let cachedKey = null;

function readOpenAIKeyFromSecretsDir() {
  const secretsDir = (process.env.MEAL_PLANNER_SECRETS_DIR || "").trim();
  if (!secretsDir) return "";
  const keyPath = path.join(secretsDir, "openai_api_key.txt");
  if (!fsSync.existsSync(keyPath)) return "";
  try {
    const raw = fsSync.readFileSync(keyPath, "utf8");
    return String(raw || "").trim();
  } catch {
    return "";
  }
}

function getOpenAIClient() {
  const key = (process.env.OPENAI_API_KEY || "").trim() || readOpenAIKeyFromSecretsDir();
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

async function listLocalRecipes() {
  await ensureDir(RECIPES_DIR);
  const files = await fs.readdir(RECIPES_DIR);
  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  const recipes = [];
  for (const f of jsonFiles) {
    try {
      const p = path.join(RECIPES_DIR, f);
      const r = await readJson(p);
      if (!r || typeof r !== "object") continue;
      const title = String(r.title || "").trim();
      if (!title || title.toLowerCase().includes("placeholder")) continue;
      recipes.push({
        recipe_id: r.recipe_id || f.replace(".json", ""),
        title
      });
    } catch {
      // ignore unreadable recipes
    }
  }
  return recipes;
}

function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function pruneChatSessions() {
  if (!CHAT_PERSIST || !CHAT_RETENTION_DAYS || CHAT_RETENTION_DAYS < 1) return;

  await ensureDir(CHAT_DIR);
  const cutoff = Date.now() - CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const files = await fs.readdir(CHAT_DIR);
  await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => {
        const p = path.join(CHAT_DIR, f);
        try {
          const st = await fs.stat(p);
          if (st.mtimeMs < cutoff) {
            await fs.unlink(p);
          }
        } catch {
          // Ignore per-file errors (best-effort cleanup)
        }
      })
  );
}

if (CHAT_PERSIST && CHAT_RETENTION_DAYS > 0) {
  // Best-effort cleanup at startup + daily
  pruneChatSessions().catch(() => {});
  setInterval(() => {
    pruneChatSessions().catch(() => {});
  }, 24 * 60 * 60 * 1000);
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

function parseProposalLines(lines, slots, existingTitles = null) {
  const slotSet = new Set(slots);
  const titles = new Set();
  const map = new Map();

  for (const line of lines) {
    const m = line.match(/^[-*]\s*([a-z_]+)\s*:\s*(.+)$/i);
    if (!m) continue;
    const slot = normalizeSlotKey(m[1]);
    const title = normalizeTitle(m[2]);
    if (!slot || !title) continue;
    if (!slotSet.has(slot)) continue;
    if (map.has(slot)) continue;
    const key = title.toLowerCase();
    if (titles.has(key)) continue;
    if (existingTitles && existingTitles.has(key)) continue;
    map.set(slot, title);
    titles.add(key);
  }

  return { map, titles };
}

function normalizeDriveTitle(raw) {
  const t = String(raw || "").trim();
  if (!t) return "";
  return t.replace(/\.pdf$/i, "").trim();
}

async function listDriveIndexTitles() {
  const csvPath = path.join(PROJECT_ROOT, "recipes_list.csv");
  if (!fsSync.existsSync(csvPath)) return [];
  const raw = fsSync.readFileSync(csvPath, "utf8");
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return [];
  const titles = [];
  for (let i = 1; i < lines.length; i += 1) {
    const parts = lines[i].split(";");
    const title = normalizeDriveTitle(parts[0] || "");
    if (title) titles.push(title);
  }
  return titles;
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
    if (CHAT_PERSIST) {
      await writeJson(p, fresh);
    }
    return { path: p, data: fresh };
  }
}

async function safeWriteChat(filePath, data) {
  if (!CHAT_PERSIST) return;
  await writeJson(filePath, data);
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

    let openai = getOpenAIClient();
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
    await safeWriteChat(p, data);

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
    const usedTitles = new Set();

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
    await safeWriteChat(p, data);

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
    const model = getModel();

    const slotsSet = new Set(slots);
    if (overwrite) {
      for (const slot of slots) {
        data.menu_proposals[slot] = [];
      }
    }

    const previousTitlesBySlot = {};
    for (const slot of slots) {
      const list = data.menu_proposals?.[slot] || [];
      previousTitlesBySlot[slot] = list
        .map((p) => String(p?.title || "").trim())
        .filter(Boolean);
    }

    const avoidLines = slots
      .map((s) => {
        const titles = previousTitlesBySlot[s] || [];
        if (titles.length === 0) return null;
        return `Ne propose pas pour ${s}: ${titles.join(" | ")}`;
      })
      .filter(Boolean);

    const usedTitlesForPrompt = Array.from(
      Object.entries(data.menu_proposals || {})
        .filter(([slot]) => !slotsSet.has(slot))
        .flatMap(([, list]) => list || [])
        .map((p) => String(p?.title || "").trim())
        .filter(Boolean)
    );
    const avoidGlobalLine =
      usedTitlesForPrompt.length > 0
        ? `Ne propose pas ces titres (déjà utilisés cette semaine): ${usedTitlesForPrompt.join(
            " | "
          )}`
        : null;

    let rawText = "";
    let lines = [];
    let parsedMap = null;
    let fallbackRecipeBySlot = null;
    let openaiAvailable = !!openai;
    let sourceType = openaiAvailable ? "CHAT_GENERATED" : "LOCAL_POOL";
    const sourceBySlot = {};

    const usedTitlesForUniq = new Set(
      Object.entries(data.menu_proposals || {})
        .filter(([slot]) => (overwrite ? !slotsSet.has(slot) : true))
        .flatMap(([, list]) => list || [])
        .map((p) => String(p?.title || "").trim().toLowerCase())
        .filter(Boolean)
    );

    const driveTitles = await listDriveIndexTitles();
    const driveCandidates = shuffle(
      driveTitles.filter((t) => {
        const key = t.toLowerCase();
        return key && !usedTitlesForUniq.has(key);
      })
    );

    if (driveCandidates.length > 0) {
      const driveMap = new Map();
      for (const slot of slots) {
        if (driveCandidates.length === 0) break;
        const title = driveCandidates.shift();
        const key = title.toLowerCase();
        if (usedTitlesForUniq.has(key)) continue;
        driveMap.set(slot, title);
        usedTitlesForUniq.add(key);
        sourceBySlot[slot] = "DRIVE_INDEX";
      }
      if (driveMap.size > 0) {
        parsedMap = driveMap;
      }
    }

    if (openaiAvailable && parsedMap?.size !== slots.length) {
      try {
        let attempts = 0;
        while (attempts < 3) {
          attempts += 1;
          const remainingSlots = slots.filter((s) => !parsedMap?.has(s));
          const resp = await openai.responses.create({
            model,
            input: [
              "Tu proposes des idées de plats pour un menu hebdomadaire (brouillon).",
              "Règles PRIORITAIRES:",
              "1) Format: une ligne par slot, format strict: '- slot: <titre>'.",
              "2) Aucune recette/ingrédient/liste de courses avant validation du tableau.",
              "3) Si ambiguïté/information manquante: STOP et réponds uniquement: 'QUESTION: ...'.",
              "4) Personnes: 2 adultes + 1 enfant de 9 ans (adapter les portions, pas un x3 aveugle).",
              "5) Nutrition: ~500 kcal/adulte, pas de menu vide.",
              "6) Saison: légumes de saison, courgette interdite hors saison.",
              "7) Équivalences cru/cuit: pâtes x2,5 ; riz x3 ; semoule x2 ; légumineuses x3 ; pommes de terre x1 ; patate douce x1.",
              "8) Répétitions: ingrédient principal max 2 fois/semaine, si 2 fois -> 2 jours d’écart.",
              "9) Sources: mixer recettes générées + Drive si possible; demander rescan si index Drive non à jour.",
              "Donne un menu au format strict suivant (une ligne par slot):",
              ...remainingSlots.map((s) => `- ${s}: <titre>`),
              ...avoidLines,
              ...(avoidGlobalLine ? [avoidGlobalLine] : []),
              "Aucun texte en plus."
            ].join("\n")
          });
          rawText = resp.output_text || "";
          lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);
          const parsed = parseProposalLines(lines, remainingSlots, usedTitlesForUniq);
          if (parsed.map.size === remainingSlots.length) {
            parsedMap = parsedMap || new Map();
            for (const [slot, title] of parsed.map.entries()) {
              parsedMap.set(slot, title);
              sourceBySlot[slot] = "CHAT_GENERATED";
              usedTitlesForUniq.add(title.toLowerCase());
            }
            break;
          }
          rawText = "";
          lines = [];
        }
      } catch (_e) {
        openaiAvailable = false;
        openai = null;
        sourceType = "LOCAL_POOL";
        rawText = "";
        lines = [];
      }
    }

    if (!openaiAvailable || !parsedMap || parsedMap.size !== slots.length) {
      const localRecipes = await listLocalRecipes();
      if (localRecipes.length === 0) {
        return res.status(500).json({ error: "no_local_recipes" });
      }
      const candidates = shuffle(
        localRecipes.filter((r) => {
          const key = String(r?.title || "").trim().toLowerCase();
          return key && !usedTitlesForUniq.has(key);
        })
      );
      fallbackRecipeBySlot = {};
      for (const slot of slots) {
        if (parsedMap?.has(slot)) continue;
        const pick = candidates.shift();
        if (!pick) break;
        fallbackRecipeBySlot[slot] = pick.recipe_id;
        if (!parsedMap) parsedMap = new Map();
        parsedMap.set(slot, pick.title);
        sourceBySlot[slot] = "LOCAL_FALLBACK";
        usedTitlesForUniq.add(String(pick.title || "").trim().toLowerCase());
      }
    }

    const createdAt = nowIso();
    const usedTitles = new Set(
      Object.entries(data.menu_proposals || {})
        .filter(([slot]) => (overwrite ? !slotsSet.has(slot) : true))
        .flatMap(([, list]) => list || [])
        .map((p) => String(p?.title || "").trim().toLowerCase())
        .filter(Boolean)
    );

    for (const slot of slots) {
      const title = parsedMap?.get(slot);
      if (!title) continue;
      if (!data.menu_proposals[slot]) {
        data.menu_proposals[slot] = [];
      }

      const titleKey = title.toLowerCase();
      if (usedTitles.has(titleKey)) continue;

      data.menu_proposals[slot].push({
        proposal_id: newProposalId(),
        title,
        recipe_id: fallbackRecipeBySlot?.[slot] || null,
        source: sourceBySlot[slot] || sourceType,
        status: "PROPOSED",
        to_save: false,
        created_at: createdAt
      });
      usedTitles.add(titleKey);
    }

    // Enforce zero-duplicate titles across all requested slots
    const seenTitles = new Set();
    for (const slot of slots) {
      const list = Array.isArray(data.menu_proposals?.[slot])
        ? data.menu_proposals[slot]
        : [];
      const unique = [];
      for (const p of list) {
        const key = String(p?.title || "").trim().toLowerCase();
        if (!key || seenTitles.has(key)) continue;
        seenTitles.add(key);
        unique.push(p);
      }
      data.menu_proposals[slot] = unique;
    }

    // Fallback if model output didn't parse or created no proposals for some slots
    const needsFallback = slots.some((slot) => {
      const list = data.menu_proposals?.[slot] || [];
      return list.length === 0;
    });

    if (needsFallback) {
      const localRecipes = await listLocalRecipes();
      if (localRecipes.length === 0) {
        return res.status(500).json({ error: "no_local_recipes" });
      }
      const candidates = localRecipes.filter((r) => {
        const key = String(r?.title || "").trim().toLowerCase();
        return key && !usedTitles.has(key) && !seenTitles.has(key);
      });
      if (candidates.length === 0) {
        return res.status(409).json({ error: "no_unique_recipes_left" });
      }
      const shuffled = shuffle(candidates);
      let idx = 0;
      for (const slot of slots) {
        const list = data.menu_proposals?.[slot] || [];
        if (list.length > 0) continue;
        const pick = shuffled[idx % shuffled.length];
        idx += 1;
        if (!data.menu_proposals[slot]) data.menu_proposals[slot] = [];
        data.menu_proposals[slot].push({
          proposal_id: newProposalId(),
          title: pick.title,
          recipe_id: pick.recipe_id,
          source: "LOCAL_FALLBACK",
          status: "PROPOSED",
          to_save: false,
          created_at: createdAt
        });
        usedTitles.add(String(pick.title || "").trim().toLowerCase());
      }
    }

    // Final global de-duplication across all slots (including existing ones)
    const orderedSlots = [
      ...slots,
      ...Object.keys(data.menu_proposals || {}).filter((s) => !slotsSet.has(s))
    ];
    const seenGlobal = new Set();
    for (const slot of orderedSlots) {
      const list = Array.isArray(data.menu_proposals?.[slot])
        ? data.menu_proposals[slot]
        : [];
      const unique = [];
      for (const p of list) {
        const key = String(p?.title || "").trim().toLowerCase();
        if (!key || seenGlobal.has(key)) continue;
        seenGlobal.add(key);
        unique.push(p);
      }
      data.menu_proposals[slot] = unique;
    }

    data.updated_at = nowIso();
    await safeWriteChat(p, data);

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
    await safeWriteChat(p, data);

    return res.json({ ok: true, preview });
  } catch (e) {
    return res.status(500).json({ error: "preview_failed", details: e.message });
  }
});

/**
 * POST /api/chat/preview-title
 * body: { title, people }
 * Returns preview without storing.
 */
router.post("/preview-title", async (req, res) => {
  const title = String(req.body?.title || "");
  const people = req.body?.people || null;

  if (!title) return res.status(400).json({ error: "missing_title" });

  try {
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
