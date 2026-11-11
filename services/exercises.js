'use strict';

const { db } = require('../db/db');

// Lista de etiquetas con cuántos ejercicios las usan.
function listTags() {
  return db.prepare(`
    SELECT t.id, t.name, COUNT(l.exercise_id) AS exercise_count
    FROM exercise_tags t
    LEFT JOIN exercise_tag_links l ON l.tag_id = t.id
    GROUP BY t.id, t.name
    ORDER BY t.name COLLATE NOCASE
  `).all();
}

// Añade a cada ejercicio su array de etiquetas [{ id, name }].
function attachTags(exercises) {
  const rows = db.prepare(`
    SELECT l.exercise_id, t.id, t.name
    FROM exercise_tag_links l
    JOIN exercise_tags t ON t.id = l.tag_id
    ORDER BY t.name COLLATE NOCASE
  `).all();
  const byExercise = new Map();
  for (const row of rows) {
    if (!byExercise.has(row.exercise_id)) byExercise.set(row.exercise_id, []);
    byExercise.get(row.exercise_id).push({ id: row.id, name: row.name });
  }
  return exercises.map((exercise) => ({ ...exercise, tags: byExercise.get(exercise.id) || [] }));
}

function listExercisesWithTags() {
  const exercises = db.prepare('SELECT * FROM exercises ORDER BY name COLLATE NOCASE').all();
  return attachTags(exercises);
}

// Sustituye las etiquetas asignadas a un ejercicio.
function syncExerciseTags(exerciseId, tagIds) {
  db.prepare('DELETE FROM exercise_tag_links WHERE exercise_id = ?').run(exerciseId);
  if (!Array.isArray(tagIds)) return;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO exercise_tag_links (exercise_id, tag_id)
     SELECT ?, id FROM exercise_tags WHERE id = ?`
  );
  const unique = [...new Set(tagIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  for (const tagId of unique) insert.run(exerciseId, tagId);
}

module.exports = { listTags, listExercisesWithTags, syncExerciseTags };
