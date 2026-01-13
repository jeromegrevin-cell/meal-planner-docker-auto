import express from "express";
import pkg from "pg";
const { Pool } = pkg;

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Récupérer toutes les recettes
router.get("/", async (_req, res) => {
  try {
    const result = await pool.query("SELECT * FROM recettes ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/// Ajouter une nouvelle recette (avec PDF)
router.post("/", async (req, res) => {
  const { titre, description, ingredients, instructions, duree_minutes, pdf_path } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO recettes (titre, description, ingredients, instructions, duree_minutes, pdf_path)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [titre, description, ingredients, instructions, duree_minutes, pdf_path || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de l’ajout de la recette" });
  }
});


// Modifier une recette (avec PDF)
router.put("/:id", async (req, res) => {
  const { titre, description, ingredients, instructions, duree_minutes, pdf_path } = req.body;
  try {
    const result = await pool.query(
      `UPDATE recettes
         SET titre=$1,
             description=$2,
             ingredients=$3,
             instructions=$4,
             duree_minutes=$5,
             pdf_path=$6
       WHERE id=$7
       RETURNING *`,
      [titre, description, ingredients, instructions, duree_minutes, pdf_path || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Recette introuvable" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de la modification" });
  }
});


// Supprimer une recette
router.delete("/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM recettes WHERE id=$1", [req.params.id]);
    res.json({ message: "Recette supprimée" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de la suppression" });
  }
});

export default router;
