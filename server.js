import express from "express";
import multer from "multer";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import path from "path";
import fs from "fs";

// File upload storage config
const upload = multer({
  dest: "uploads/", // resumes stored here
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
});

const app = express();
app.use(cors());
app.use(express.json());
app.use("/uploads", express.static("uploads")); // serve resume files

// DB setup
let db;
(async () => {
  db = await open({
    filename: "applicants.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS applicants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      firstName TEXT,
      lastName TEXT,
      email TEXT,
      phone TEXT,
      position TEXT,
      coverLetter TEXT,
      resumePath TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
})();

// Route: Submit application
app.post("/apply", upload.single("resume"), async (req, res) => {
  try {
    const { firstName, lastName, email, phone, position, coverLetter } = req.body;
    const resumePath = req.file ? req.file.path : null;

    await db.run(
      `INSERT INTO applicants (firstName, lastName, email, phone, position, coverLetter, resumePath)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [firstName, lastName, email, phone, position, coverLetter, resumePath]
    );

    res.json({ success: true, message: "Application submitted successfully!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to save application" });
  }
});

// Route: View all applications
app.get("/applicants", async (req, res) => {
  const applicants = await db.all(`SELECT * FROM applicants ORDER BY createdAt DESC`);
  res.json(applicants);
});

// Route: Get single applicant
app.get("/applicants/:id", async (req, res) => {
  const applicant = await db.get(`SELECT * FROM applicants WHERE id = ?`, [req.params.id]);
  if (!applicant) return res.status(404).json({ message: "Not found" });
  res.json(applicant);
});

// Route: Download resume
app.get("/resume/:id", async (req, res) => {
  const applicant = await db.get(`SELECT * FROM applicants WHERE id = ?`, [req.params.id]);
  if (!applicant || !applicant.resumePath) return res.status(404).json({ message: "Resume not found" });

  res.download(path.resolve(applicant.resumePath));
});

// Start server
const PORT = 5000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
