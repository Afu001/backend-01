// server.js
import express from "express";
import multer from "multer";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import path from "path";
import fs from "fs";
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 5000;
const UPLOAD_DIR = path.join(process.cwd(), process.env.UPLOAD_DIR || "uploads");

// Ensure upload dir exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Multer config — keep original extension, but use safe generated name
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
app.use("/uploads", express.static(UPLOAD_DIR));

// --- Database ---
let db;
(async () => {
  db = await open({
    filename: process.env.DB_FILE || "applicants.db",
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
})().catch((err) => {
  console.error("DB init error:", err);
  process.exit(1);
});

// --- Nodemailer transporter ---
if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
  console.warn("⚠️ EMAIL_USER or EMAIL_PASS not set in .env. Email will fail until configured.");
}

const transporter = nodemailer.createTransport({
  host: "smtp.zoho.com",
  port: 465, // SSL
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    // 👇 allow self-signed / unverified certs
    rejectUnauthorized: false,
  },
});



// verify transporter at startup
transporter.verify().then(() => {
  console.log("✅ Mail transporter ready");
}).catch((err) => {
  console.warn("⚠️ Mail transporter verification failed:", err.message);
});

// ---- Routes ----

// Submit application
app.post("/apply", upload.single("resume"), async (req, res) => {
  try {
    const { firstName, lastName, email, phone, position, coverLetter } = req.body;
    const resumePath = req.file ? req.file.filename : null;

    const result = await db.run(
      `INSERT INTO applicants (firstName, lastName, email, phone, position, coverLetter, resumePath)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [firstName, lastName, email, phone, position, coverLetter, resumePath]
    );

    const insertedId = result.lastID;

    // Build email
    const applicantName = (firstName || "") + (lastName ? ` ${lastName}` : "");
    const subject = `Application received — ${position || "Application"}`;
    const host = `${req.protocol}://${req.get("host")}`;
    const resumeUrl = resumePath ? `${host}/uploads/${resumePath}` : null;

    // Compose base message (plain + html)
    const text = `Hello ${firstName || "Applicant"},\n\nThank you for applying for the position of ${position || "the role"}.
We have received your application and will review it. If we need more information, we will contact you at ${email}.\n\nBest regards,\nHR Team`;

    const html = `
      <p>Hello <strong>${firstName || "Applicant"}</strong>,</p>
      <p>Thank you for applying for the <strong>${position || "role"}</strong>. We have received your application and will review it. If we need more information, we will contact you at <a href="mailto:${email}">${email}</a>.</p>
      ${resumeUrl ? `<p>Your uploaded resume: <a href="${resumeUrl}">Download</a></p>` : ""}
      <p>Best regards,<br/>HR Team</p>
    `;

    // Attach resume to email if you want to send it back to the applicant
    const attachments = [];
    if (req.file) {
      attachments.push({
        filename: req.file.originalname || `resume${path.extname(req.file.filename)}`,
        path: path.join(UPLOAD_DIR, req.file.filename),
      });
    }

    // Send confirmation email
    const mailOptions = {
      from: `"HR Team" <${process.env.EMAIL_USER}>`,
      to: email,
      subject,
      text,
      html,
      attachments,
      // optionally BCC HR/internal
      bcc: process.env.HR_EMAIL || undefined,
    };

    await transporter.sendMail(mailOptions);

    res.json({ success: true, message: "Application submitted & confirmation email sent!", id: insertedId });
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

    res.download(fullPath, `${(applicant.firstName || "resume")}${path.extname(fullPath)}`);
  } catch (err) {
    console.error("❌ Resume error:", err.message);
    res.status(500).json({ message: "Failed to download resume" });
  }
});

// Start
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
