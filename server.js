import express from "express";
import multer from "multer";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import path from "path";
import fs from "fs";

// make sure uploads dir exists
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// multer config — keep original extension
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    const safeName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only PDF / DOC / DOCX files are allowed"));
  },
});

const app = express();
app.use(cors());
app.use(express.json());

// serve uploaded files at /uploads/<filename>
app.use("/uploads", express.static(UPLOAD_DIR));

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

// ---- Routes ----

// Submit application
app.post("/apply", upload.single("resume"), async (req, res) => {
  try {
    const { firstName, lastName, email, phone, position, coverLetter } = req.body;
    const resumePath = req.file ? req.file.filename : null; // ✅ store only filename

    await db.run(
      `INSERT INTO applicants (firstName, lastName, email, phone, position, coverLetter, resumePath)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [firstName, lastName, email, phone, position, coverLetter, resumePath]
    );

    res.json({ success: true, message: "Application submitted successfully!" });
  } catch (err) {
    console.error("❌ Apply error:", err.message);
    res.status(500).json({ success: false, message: "Failed to save application" });
  }
});

// Get all applicants
app.get("/applicants", async (req, res) => {
  try {
    const rows = await db.all(`SELECT * FROM applicants ORDER BY createdAt DESC`);
    const host = `${req.protocol}://${req.get("host")}`;

    const mapped = rows.map((r) => ({
      ...r,
      resumeUrl: r.resumePath ? `${host}/uploads/${r.resumePath}` : null,
    }));

    res.json(mapped);
  } catch (err) {
    console.error("❌ Applicants error:", err.message);
    res.status(500).json({ message: "Failed to fetch applicants" });
  }
});

// Get single applicant
app.get("/applicants/:id", async (req, res) => {
  try {
    const applicant = await db.get(`SELECT * FROM applicants WHERE id = ?`, [req.params.id]);
    if (!applicant) return res.status(404).json({ message: "Not found" });

    const host = `${req.protocol}://${req.get("host")}`;
    applicant.resumeUrl = applicant.resumePath ? `${host}/uploads/${applicant.resumePath}` : null;

    res.json(applicant);
  } catch (err) {
    console.error("❌ Applicant error:", err.message);
    res.status(500).json({ message: "Failed to fetch applicant" });
  }
});

// Download resume
app.get("/resume/:id", async (req, res) => {
  try {
    const applicant = await db.get(`SELECT * FROM applicants WHERE id = ?`, [req.params.id]);
    if (!applicant || !applicant.resumePath)
      return res.status(404).json({ message: "Resume not found" });

    const fullPath = path.join(UPLOAD_DIR, applicant.resumePath);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ message: "File missing" });

    res.download(fullPath, `${applicant.firstName || "resume"}${path.extname(fullPath)}`);
  } catch (err) {
    console.error("❌ Resume error:", err.message);
    res.status(500).json({ message: "Failed to download resume" });
  }
});

// ---- Start ----
const PORT = 5000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
