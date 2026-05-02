import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import mysql from "mysql2/promise";
import multer from "multer";
import path from "path";
import fs from "fs";
import { sendEmail } from "./mailer/index.js";
import crypto from "crypto";
import { lookupIp } from "./geo/index.js";
import http from "http";
import { attachSocket } from "./socket.js";



dotenv.config();

const app = express();

const allowedOrigins = String(process.env.CORS_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173,http://192.168.137.1:5173")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

app.use("/uploads", express.static(uploadsDir));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const safe = String(file.originalname || "file").replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

const videoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const safe = String(file.originalname || "video").replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `video_${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 250 * 1024 * 1024 }, // 250MB
});

const postMediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const safe = String(file.originalname || "media").replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `post_${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

//username

function slugBase(displayName) {
  const base =
    String(displayName || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 10) || "user";
  return base;
}

async function generateUniqueUsername(pool, displayName) {
  const base = slugBase(displayName);

  // Try a few random suffixes first (fast path)
  for (let i = 0; i < 10; i++) {
    const suffix = Math.floor(1000 + Math.random() * 9000);
    const candidate = `${base}${suffix}`;

    const [rows] = await pool.query(
      "SELECT id FROM users WHERE username = ? LIMIT 1",
      [candidate]
    );

    if (rows.length === 0) return candidate;
  }

  // Fallback: append timestamp chunk (extremely unlikely to collide)
  return `${base}${Date.now().toString().slice(-6)}`;
}

//geo

function getClientIp(req) {
  // If you deploy behind a trusted proxy later, use Express trust proxy + req.ip (recommended).
  // Express docs: behind proxies uses trust proxy to decide what to trust. :contentReference[oaicite:2]{index=2}
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();

  const ra = req.socket?.remoteAddress || "";
  return ra.replace("::ffff:", "");
}

//

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ message: "Unauthorized" });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}

async function requireAdmin(req, res, next) {
  const callerId = Number(req.user?.sub || 0);
  if (!callerId) return res.status(401).json({ message: "Unauthorized" });

  try {
    const [rows] = await pool.query(
      `SELECT role
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [callerId]
    );
    const role = String(rows?.[0]?.role || "").toLowerCase();
    if (role !== "admin") {
      return res.status(403).json({ code: "ADMIN_ONLY", message: "Admin access required." });
    }
    return next();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to verify admin access." });
  }
}

//

app.post("/billing/start-trial", requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub;

    const [rows] = await pool.query(
      "SELECT id, email, username, role, plan, trial_used, trial_ends_at, pro_ends_at FROM users WHERE id = ? LIMIT 1",
      [userId]
    );
    const user = rows?.[0];
    if (!user) return res.status(404).json({ message: "User not found" });

    // Admins don't need trial
    if (user.role === "admin") {
      return res.status(400).json({ message: "Admins already have access." });
    }

    // If already pro (active), no trial needed
    if (user.plan === "pro") {
      // if you use pro_ends_at, you can check expiry here; keeping simple:
      return res.status(400).json({ message: "You already have Pro." });
    }

    // If active trial already
    if (user.plan === "trial" && user.trial_ends_at && new Date(user.trial_ends_at).getTime() > Date.now()) {
      return res.status(400).json({ message: "Trial already active." });
    }

    // Trial only once
    if (Number(user.trial_used) === 1) {
      return res.status(400).json({ message: "Trial already used." });
    }

    // Start 7-day trial
    const trialDays = 7;
    await pool.query(
      `UPDATE users
       SET plan='trial',
           trial_used=1,
           trial_started_at=NOW(),
           trial_ends_at=DATE_ADD(NOW(), INTERVAL ? DAY)
       WHERE id=?`,
      [trialDays, userId]
    );

    // Issue new token with updated plan
    const capability = await resolveUserVideoCapabilityById(user.id);
    const token = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        username: user.username,
        role: "user",
        plan: "trial",
        canPublishVideo: capability.canPublishVideo,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      ok: true,
      token,
      trialEndsAt: new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000).toISOString(),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to start trial." });
  }
});

//code
function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

app.post("/auth/send-code", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: "Email is required." });

    const normalized = String(email).trim().toLowerCase();
    const code = generateCode();
    const codeHash = await bcrypt.hash(code, 10);

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query("DELETE FROM email_verifications WHERE email = ?", [normalized]);

    await pool.query(
      "INSERT INTO email_verifications (email, code_hash, expires_at) VALUES (?, ?, ?)",
      [normalized, codeHash, expiresAt]
    );

    const subject = `Talkflix verification code: ${code}`;

    await sendEmail({
      to: normalized,
      subject,
      text: `Talkflix verification code: ${code}\n\nThis code expires in 10 minutes.\n\nIf you did not request this code, you can ignore this email.`,
      html: `
        <div style="margin:0;padding:16px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0f172a;">
          <div style="max-width:360px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:20px;text-align:center;">
            <div style="font-size:13px;line-height:1.5;color:#475569;margin-bottom:8px;">Your Talkflix verification code</div>
            <div style="display:inline-block;margin-bottom:12px;padding:12px 16px;border-radius:12px;background:#0f172a;color:#ffffff;font-size:28px;font-weight:800;letter-spacing:0.16em;">
              ${code}
            </div>
            <div style="font-size:13px;line-height:1.5;color:#475569;margin-bottom:10px;">
              Expires in 10 minutes.
            </div>
            <div style="font-size:12px;line-height:1.5;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:10px;">Talkflix</div>
          </div>
        </div>
      `,
    });

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to send verification code." });
  }
});

app.post("/auth/verify-code", async (req, res) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !code) return res.status(400).json({ message: "Email and code are required." });

    const normalized = String(email).trim().toLowerCase();

    const [rows] = await pool.query(
      `SELECT id, code_hash, expires_at, verified_at
       FROM email_verifications
       WHERE email = ?
       ORDER BY id DESC
       LIMIT 1`,
      [normalized]
    );

    const row = rows?.[0];
    if (!row) return res.status(400).json({ message: "No code found. Please request a new code." });

    if (row.verified_at) return res.status(400).json({ message: "Code already verified." });

    if (new Date(row.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ message: "Code expired. Please request a new code." });
    }

    const ok = await bcrypt.compare(String(code).trim(), row.code_hash);
    if (!ok) return res.status(400).json({ message: "Invalid code." });

    await pool.query("UPDATE email_verifications SET verified_at = NOW() WHERE id = ?", [row.id]);

    const emailVerificationToken = jwt.sign(
      { purpose: "email_verify", email: normalized, jti: row.id },
      process.env.JWT_SECRET,
      { expiresIn: "15m" }
    );

    res.json({ ok: true, emailVerificationToken });
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: "Failed to verify code." });
  }
});

// roles

function computeEffectivePlan(userRow) {
  const role = userRow.role || "user";
  const now = Date.now();

  // Admins typically get full access, but we keep role for moderation logic.
  if (role === "admin") {
    return { role, plan: "pro" };
  }

  const plan = userRow.plan || "free";

  if (plan === "trial") {
    const ends = userRow.trial_ends_at ? new Date(userRow.trial_ends_at).getTime() : 0;
    if (ends && ends > now) return { role, plan: "trial" };
    return { role, plan: "free" };
  }

  if (plan === "pro") {
    const ends = userRow.pro_ends_at ? new Date(userRow.pro_ends_at).getTime() : 0;
    // If pro_ends_at is null → treat as active pro
    if (!userRow.pro_ends_at) return { role, plan: "pro" };
    if (ends > now) return { role, plan: "pro" };
    return { role, plan: "free" };
  }

  return { role, plan: "free" };
}

async function resolveUserVideoCapabilityById(userId) {
  try {
    const [rows] = await pool.query(
      `SELECT id, role, can_publish_video
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [userId]
    );
    const row = rows?.[0];
    if (!row) return { ok: false, canPublishVideo: false };
    const canPublishVideo =
      Number(row.can_publish_video || 0) === 1 || row.role === "admin";
    return { ok: true, canPublishVideo };
  } catch (e) {
    if (e?.code === "ER_BAD_FIELD_ERROR") {
      const [rows] = await pool.query(
        `SELECT id, role
         FROM users
         WHERE id = ?
         LIMIT 1`,
        [userId]
      );
      const row = rows?.[0];
      if (!row) return { ok: false, canPublishVideo: false };
      return { ok: true, canPublishVideo: row.role === "admin" };
    }
    throw e;
  }
}

async function resolveUserVideoCapabilityByEmail(email) {
  try {
    const [rows] = await pool.query(
      `SELECT id, role, can_publish_video
       FROM users
       WHERE email = ?
       LIMIT 1`,
      [String(email).trim().toLowerCase()]
    );
    const row = rows?.[0];
    if (!row) return { ok: false, canPublishVideo: false };
    const canPublishVideo =
      Number(row.can_publish_video || 0) === 1 || row.role === "admin";
    return { ok: true, canPublishVideo };
  } catch (e) {
    if (e?.code === "ER_BAD_FIELD_ERROR") {
      const [rows] = await pool.query(
        `SELECT id, role
         FROM users
         WHERE email = ?
         LIMIT 1`,
        [String(email).trim().toLowerCase()]
      );
      const row = rows?.[0];
      if (!row) return { ok: false, canPublishVideo: false };
      return { ok: true, canPublishVideo: row.role === "admin" };
    }
    throw e;
  }
}

// reset password

app.post("/auth/reset-password", async (req, res) => {
    try {
      const { token, password } = req.body || {};
      if (!token || !password) {
        return res.status(400).json({ message: "Token and new password are required." });
      }
      if (String(password).length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters." });
      }
  
      const tokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");
  
      const [rows] = await pool.query(
        `SELECT id, email, expires_at, used_at
         FROM password_resets
         WHERE token_hash = ?
         ORDER BY id DESC
         LIMIT 1`,
        [tokenHash]
      );
  
      const reset = rows?.[0];
      if (!reset) return res.status(400).json({ message: "Invalid reset token." });
      if (reset.used_at) return res.status(400).json({ message: "Reset token already used." });
      if (new Date(reset.expires_at).getTime() < Date.now()) {
        return res.status(400).json({ message: "Reset token expired." });
      }
  
      const passwordHash = await bcrypt.hash(String(password), 10);
  
      await pool.query("UPDATE users SET password_hash = ? WHERE email = ?", [passwordHash, reset.email]);
      await pool.query("UPDATE password_resets SET used_at = NOW() WHERE id = ?", [reset.id]);
  
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: "Failed to reset password." });
    }
  });


// forgot password

app.post("/auth/forgot-password", async (req, res) => {
    try {
      const { email } = req.body || {};
      if (!email) return res.status(400).json({ message: "Email is required." });
  
      const normalized = String(email).trim().toLowerCase();
  
      // Always respond ok (prevents email enumeration)
      const okResponse = () => res.json({ ok: true });
  
      // Check if user exists
      const [rows] = await pool.query("SELECT id FROM users WHERE email = ? LIMIT 1", [normalized]);
      const user = rows?.[0];
      if (!user) return okResponse();
  
      // Create token (store only hash in DB)
      const token = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
  
      await pool.query("INSERT INTO password_resets (email, token_hash, expires_at) VALUES (?, ?, ?)", [
        normalized,
        tokenHash,
        expiresAt,
      ]);
  
      const requestOrigin = req.get("origin");
      const forwardedProto = req.get("x-forwarded-proto");
      const forwardedHost = req.get("x-forwarded-host");
      const inferredOrigin =
        requestOrigin ||
        (forwardedProto && forwardedHost ? `${forwardedProto}://${forwardedHost}` : null) ||
        `${req.protocol}://${req.get("host")}`;
      const appUrl = process.env.APP_URL || inferredOrigin || "http://localhost:5173";
      const resetLink = `${appUrl.replace(/\/$/, "")}/reset-password?token=${token}`;
  
      await sendEmail({
        to: normalized,
        subject: "Reset your Talkflix password",
        text: `Reset your password using this link (valid for 30 minutes): ${resetLink}`,
        html: `<p>Reset your password (valid for 30 minutes):</p><p><a href="${resetLink}">Reset password</a></p>`,
      });
  
      return okResponse();
    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: "Failed to start password reset." });
    }
  });

// MySQL pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});



async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS follows (
      follower_id INT NOT NULL,
      following_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (follower_id, following_id),
      KEY idx_follows_following_id (following_id),
      CONSTRAINT fk_follows_follower FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_follows_following FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS direct_messages (
      id BIGINT NOT NULL AUTO_INCREMENT,
      thread_id VARCHAR(255) NOT NULL,
      sender_id INT NOT NULL,
      receiver_id INT NOT NULL,
      message_type VARCHAR(20) NOT NULL DEFAULT 'text',
      message_text LONGTEXT NULL,
      image_url LONGTEXT NULL,
      audio_url LONGTEXT NULL,
      audio_duration INT NULL,
      mime_type VARCHAR(120) NULL,
      reply_to_message_id BIGINT NULL,
      message_status VARCHAR(20) NOT NULL DEFAULT 'sent',
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_dm_thread_created (thread_id, created_at),
      KEY idx_dm_reply_to_message_id (reply_to_message_id),
      KEY idx_dm_sender (sender_id),
      KEY idx_dm_receiver (receiver_id),
      CONSTRAINT fk_dm_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_dm_receiver FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_blocks (
      blocker_id INT NOT NULL,
      blocked_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (blocker_id, blocked_id),
      KEY idx_user_blocks_blocked_id (blocked_id),
      CONSTRAINT fk_user_blocks_blocker FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_user_blocks_blocked FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_reports (
      id BIGINT NOT NULL AUTO_INCREMENT,
      reporter_id INT NOT NULL,
      reported_user_id INT NOT NULL,
      reason VARCHAR(80) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_user_reports_reporter_id (reporter_id),
      KEY idx_user_reports_reported_user_id (reported_user_id),
      CONSTRAINT fk_user_reports_reporter FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_user_reports_reported_user FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS direct_message_reports (
      id BIGINT NOT NULL AUTO_INCREMENT,
      reporter_id INT NOT NULL,
      reported_user_id INT NOT NULL,
      message_id BIGINT NOT NULL,
      thread_id VARCHAR(255) NOT NULL,
      reason VARCHAR(80) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_direct_message_reports_reporter_id (reporter_id),
      KEY idx_direct_message_reports_reported_user_id (reported_user_id),
      KEY idx_direct_message_reports_message_id (message_id),
      CONSTRAINT fk_direct_message_reports_reporter FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_direct_message_reports_reported_user FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_direct_message_reports_message FOREIGN KEY (message_id) REFERENCES direct_messages(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const alterStatements = [
    "ALTER TABLE direct_messages ADD COLUMN message_type VARCHAR(20) NOT NULL DEFAULT 'text' AFTER receiver_id",
    "ALTER TABLE direct_messages MODIFY COLUMN message_text LONGTEXT NULL",
    "ALTER TABLE direct_messages ADD COLUMN image_url LONGTEXT NULL AFTER message_text",
    "ALTER TABLE direct_messages ADD COLUMN audio_url LONGTEXT NULL AFTER image_url",
    "ALTER TABLE direct_messages ADD COLUMN audio_duration INT NULL AFTER audio_url",
    "ALTER TABLE direct_messages ADD COLUMN mime_type VARCHAR(120) NULL AFTER audio_duration",
    "ALTER TABLE direct_messages ADD COLUMN reply_to_message_id BIGINT NULL AFTER mime_type",
    "ALTER TABLE direct_messages ADD KEY idx_dm_reply_to_message_id (reply_to_message_id)",
  ];
  for (const sql of alterStatements) {
    try {
      await pool.query(sql);
    } catch (e) {
      if (
        e?.code !== "ER_DUP_FIELDNAME" &&
        e?.code !== "ER_BAD_FIELD_ERROR" &&
        e?.code !== "ER_DUP_KEYNAME"
      ) {
        console.error(e);
      }
    }
  }

  const userAlterStatements = [
    "ALTER TABLE users ADD COLUMN bio_text VARCHAR(150) NULL AFTER profile_photo_url",
    "ALTER TABLE users ADD COLUMN bio_audio_url LONGTEXT NULL AFTER bio_text",
    "ALTER TABLE users ADD COLUMN bio_audio_duration INT NULL AFTER bio_audio_url",
    "ALTER TABLE users ADD COLUMN can_publish_video TINYINT(1) NOT NULL DEFAULT 0 AFTER role",
    "ALTER TABLE users ADD KEY idx_users_can_publish_video (can_publish_video)",
  ];
  for (const sql of userAlterStatements) {
    try {
      await pool.query(sql);
    } catch (e) {
      if (
        e?.code !== "ER_DUP_FIELDNAME" &&
        e?.code !== "ER_BAD_FIELD_ERROR" &&
        e?.code !== "ER_NO_SUCH_TABLE"
      ) {
        console.error(e);
      }
    }
  }
}
ensureTables().catch((e) => console.error("ensureTables failed", e));
app.get("/health", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 as ok");
    res.json({ ok: true, db: rows?.[0]?.ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, message: "DB connection failed" });
  }
});

//meet

app.get("/me", requireAuth, async (req, res) => {
  const userId = req.user.sub;

  const [rows] = await pool.query(
    `SELECT id, email, display_name, username,
            first_language, learn_language,
            city, country, country_code, from_country, profile_photo_url,
            bio_text, bio_audio_url, bio_audio_duration,
            plan, role, trial_ends_at, pro_ends_at,
            trial_used,
            meet_languages_json
     FROM users WHERE id = ? LIMIT 1`,
    [userId]
  );

  const u = rows?.[0];
  if (!u) return res.status(404).json({ message: "User not found" });

  const effective = computeEffectivePlan(u);
  const capability = await resolveUserVideoCapabilityById(userId);
  let meetLangs = [];
  try {
    meetLangs = u.meet_languages_json ? JSON.parse(u.meet_languages_json) : [];
  } catch {
    meetLangs = [];
  }

  return res.json({
    ok: true,
    user: {
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      username: u.username,
      firstLanguage: u.first_language,
      learnLanguage: u.learn_language,
      role: effective.role,
      plan: effective.plan,
      canPublishVideo: capability.canPublishVideo,
      trialUsed: Boolean(u.trial_used),
      trialEndsAt: u.trial_ends_at,
      proEndsAt: u.pro_ends_at,
      meetLanguages: meetLangs,
      city: u.city,
      country: u.country,
      countryCode: u.country_code,
      nationalityCode: u.from_country,
      nationalityName: u.from_country,
      profilePhotoUrl: u.profile_photo_url,
      bioText: u.bio_text || "",
      bioAudioUrl: u.bio_audio_url || "",
      bioAudioDuration: Number(u.bio_audio_duration || 0),
      postsCount: 0,
    },
  });
});

function parseContentKind(rawKind) {
  const normalized = String(rawKind || "text").trim().toLowerCase();
  if (["text", "audio", "image", "video"].includes(normalized)) {
    return normalized;
  }
  return "";
}

function parseTranslationTargets(rawTargets) {
  if (!Array.isArray(rawTargets)) return [];
  const normalized = rawTargets
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  return Array.from(new Set(normalized)).slice(0, 5);
}

app.post("/content/posts", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const kind = parseContentKind(req.body?.kind);
    if (!kind) {
      return res.status(400).json({ code: "INVALID_KIND", message: "Invalid content kind." });
    }

    if (kind === "video") {
      const capability = await resolveUserVideoCapabilityById(userId);
      if (!capability.ok) {
        return res.status(404).json({ code: "USER_NOT_FOUND", message: "User not found." });
      }
      if (!capability.canPublishVideo) {
        return res.status(403).json({
          code: "VIDEO_CREATOR_ONLY",
          message: "Only creators can post videos.",
        });
      }
    }

    const title = String(req.body?.title || "").trim().slice(0, 512);
    const summary = String(req.body?.summary || "").trim() || null;
    const body = String(req.body?.body || "").trim() || null;
    const sourceLocale = String(req.body?.sourceLocale || "und").trim().slice(0, 16) || "und";
    const translationTargets = parseTranslationTargets(req.body?.translationTargets);
    const visibility = String(req.body?.visibility || "public").trim() === "unlisted"
      ? "unlisted"
      : "public";
    const initialStatus = kind === "video" ? "draft" : "published";

    if (!title) {
      return res.status(400).json({ code: "TITLE_REQUIRED", message: "Title is required." });
    }

    const [result] = await pool.query(
      `INSERT INTO content_items
       (user_id, kind, status, title, summary, body, visibility, source_locale, translation_targets_json, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        kind,
        initialStatus,
        title,
        summary,
        body,
        visibility,
        sourceLocale,
        JSON.stringify(translationTargets),
        initialStatus === "published" ? new Date() : null,
      ]
    );

    return res.status(201).json({
      ok: true,
      content: {
        id: String(result.insertId),
        kind,
        status: initialStatus,
        title,
        summary: summary || "",
        sourceLocale,
        translationTargets,
      },
    });
  } catch (e) {
    if (e?.code === "ER_NO_SUCH_TABLE") {
      return res.status(503).json({
        code: "CONTENT_SCHEMA_MISSING",
        message: "Content tables are not ready. Run the content migration.",
      });
    }
    console.error(e);
    return res.status(500).json({ message: "Failed to create content post." });
  }
});

app.post(
  "/content/posts/:id/upload-media",
  requireAuth,
  postMediaUpload.single("media"),
  async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      const contentId = Number(req.params.id);
      if (!contentId) {
        return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid post id." });
      }
      if (!req.file) {
        return res.status(400).json({ code: "MEDIA_FILE_REQUIRED", message: "Media file is required." });
      }

      const [rows] = await pool.query(
        `SELECT id, user_id, kind, status
         FROM content_items
         WHERE id = ?
         LIMIT 1`,
        [contentId]
      );
      const content = rows?.[0];
      if (!content) {
        return res.status(404).json({ code: "POST_NOT_FOUND", message: "Post not found." });
      }
      if (Number(content.user_id) !== userId) {
        return res.status(403).json({ code: "NOT_OWNER", message: "Only the owner can upload media." });
      }
      const kind = String(content.kind || "");
      if (!["audio", "image"].includes(kind)) {
        return res.status(400).json({ code: "MEDIA_NOT_SUPPORTED", message: "This post kind does not accept media." });
      }
      const expectedPrefix = `${kind}/`;
      if (!String(req.file.mimetype || "").startsWith(expectedPrefix)) {
        return res.status(400).json({
          code: "INVALID_MEDIA_TYPE",
          message: `Expected ${kind} file type.`,
        });
      }

      const role = kind === "audio" ? "audio_track" : "image";
      const publicUrl = `/uploads/${req.file.filename}`;
      await pool.query(
        `INSERT INTO content_assets
         (content_item_id, role, storage_provider, storage_key, public_url, mime_type, byte_size)
         VALUES (?, ?, 'local', ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           storage_key = VALUES(storage_key),
           public_url = VALUES(public_url),
           mime_type = VALUES(mime_type),
           byte_size = VALUES(byte_size)`,
        [contentId, role, req.file.path, publicUrl, req.file.mimetype, Number(req.file.size || 0)]
      );

      await pool.query(
        `UPDATE content_items
         SET status='published',
             published_at = COALESCE(published_at, NOW())
         WHERE id = ?
         LIMIT 1`,
        [contentId]
      );

      return res.json({
        ok: true,
        content: { id: String(contentId), status: "published" },
        asset: {
          role,
          url: publicUrl,
          mimeType: req.file.mimetype,
          byteSize: Number(req.file.size || 0),
        },
      });
    } catch (e) {
      if (e?.code === "ER_NO_SUCH_TABLE") {
        return res.status(503).json({
          code: "CONTENT_SCHEMA_MISSING",
          message: "Content tables are not ready. Run the content migration.",
        });
      }
      console.error(e);
      return res.status(500).json({ message: "Failed to upload post media." });
    }
  }
);

app.get("/content/posts", async (req, res) => {
  try {
    const limitRaw = Number(req.query?.limit || 20);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20;
    const [rows] = await pool.query(
      `SELECT c.id, c.user_id, c.kind, c.title, c.summary, c.body, c.source_locale, c.created_at, c.published_at,
              u.display_name,
              a.public_url AS media_url,
              a.mime_type AS media_mime_type
       FROM content_items c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN content_assets a
         ON a.content_item_id = c.id
        AND ((c.kind = 'audio' AND a.role = 'audio_track') OR (c.kind = 'image' AND a.role = 'image'))
       WHERE c.kind IN ('text', 'audio', 'image')
         AND c.status = 'published'
         AND c.deleted_at IS NULL
       ORDER BY c.published_at DESC, c.id DESC
       LIMIT ?`,
      [limit]
    );
    return res.json({
      ok: true,
      items: rows.map((row) => ({
        id: String(row.id),
        userId: String(row.user_id),
        authorName: row.display_name || "User",
        kind: row.kind || "text",
        title: row.title || "",
        summary: row.summary || "",
        body: row.body || "",
        sourceLocale: row.source_locale || "und",
        mediaUrl: row.media_url || "",
        mediaMimeType: row.media_mime_type || "",
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
      })),
    });
  } catch (e) {
    if (e?.code === "ER_NO_SUCH_TABLE") {
      return res.status(503).json({
        code: "CONTENT_SCHEMA_MISSING",
        message: "Content tables are not ready. Run the content migration.",
      });
    }
    console.error(e);
    return res.status(500).json({ message: "Failed to load posts." });
  }
});

app.post("/content/videos", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const capability = await resolveUserVideoCapabilityById(userId);
    if (!capability.ok) {
      return res.status(404).json({ code: "USER_NOT_FOUND", message: "User not found." });
    }
    if (!capability.canPublishVideo) {
      return res.status(403).json({
        code: "VIDEO_CREATOR_ONLY",
        message: "Only creators can create video content.",
      });
    }

    const title = String(req.body?.title || "").trim().slice(0, 512);
    if (!title) {
      return res.status(400).json({ code: "TITLE_REQUIRED", message: "Title is required." });
    }
    const summary = String(req.body?.summary || "").trim() || null;
    const body = String(req.body?.body || "").trim() || null;
    const sourceLocale = String(req.body?.sourceLocale || "und").trim().slice(0, 16) || "und";
    const translationTargets = parseTranslationTargets(req.body?.translationTargets);
    const visibility = String(req.body?.visibility || "public").trim() === "unlisted"
      ? "unlisted"
      : "public";

    const [result] = await pool.query(
      `INSERT INTO content_items
       (user_id, kind, status, title, summary, body, visibility, source_locale, translation_targets_json)
       VALUES (?, 'video', 'draft', ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        title,
        summary,
        body,
        visibility,
        sourceLocale,
        JSON.stringify(translationTargets),
      ]
    );

    return res.status(201).json({
      ok: true,
      content: {
        id: String(result.insertId),
        kind: "video",
        status: "draft",
        title,
        summary: summary || "",
        sourceLocale,
        translationTargets,
      },
    });
  } catch (e) {
    if (e?.code === "ER_NO_SUCH_TABLE") {
      return res.status(503).json({
        code: "CONTENT_SCHEMA_MISSING",
        message: "Content tables are not ready. Run the content migration.",
      });
    }
    console.error(e);
    return res.status(500).json({ message: "Failed to create video draft." });
  }
});

app.get("/content/videos", async (req, res) => {
  try {
    const limitRaw = Number(req.query?.limit || 20);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20;
    const [rows] = await pool.query(
      `SELECT id, title, summary, source_locale, created_at, published_at
       FROM content_items
       WHERE kind = 'video' AND status = 'published' AND deleted_at IS NULL
       ORDER BY published_at DESC, id DESC
       LIMIT ?`,
      [limit]
    );
    return res.json({
      ok: true,
      items: rows.map((row) => ({
        id: String(row.id),
        title: row.title || "",
        summary: row.summary || "",
        sourceLocale: row.source_locale || "und",
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
      })),
    });
  } catch (e) {
    if (e?.code === "ER_NO_SUCH_TABLE") {
      return res.status(503).json({
        code: "CONTENT_SCHEMA_MISSING",
        message: "Content tables are not ready. Run the content migration.",
      });
    }
    console.error(e);
    return res.status(500).json({ message: "Failed to load video content." });
  }
});

app.post("/content/videos/:id/upload", requireAuth, videoUpload.single("video"), async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid video id." });
    }
    if (!req.file) {
      return res.status(400).json({ code: "VIDEO_FILE_REQUIRED", message: "Video file is required." });
    }
    if (!String(req.file.mimetype || "").startsWith("video/")) {
      return res.status(400).json({ code: "INVALID_VIDEO_FILE", message: "Uploaded file must be a video." });
    }

    const capability = await resolveUserVideoCapabilityById(userId);
    if (!capability.ok) {
      return res.status(404).json({ code: "USER_NOT_FOUND", message: "User not found." });
    }
    if (!capability.canPublishVideo) {
      return res.status(403).json({
        code: "VIDEO_CREATOR_ONLY",
        message: "Only creators can upload videos.",
      });
    }

    const [rows] = await pool.query(
      `SELECT id, user_id, kind, status
       FROM content_items
       WHERE id = ?
       LIMIT 1`,
      [contentId]
    );
    const content = rows?.[0];
    if (!content || String(content.kind) !== "video") {
      return res.status(404).json({ code: "VIDEO_NOT_FOUND", message: "Video draft not found." });
    }
    if (Number(content.user_id) !== userId) {
      return res.status(403).json({ code: "NOT_OWNER", message: "Only the owner can upload this video." });
    }

    const publicUrl = `/uploads/${req.file.filename}`;
    const [assetRows] = await pool.query(
      `SELECT id
       FROM content_assets
       WHERE content_item_id = ? AND role = 'video_original'
       LIMIT 1`,
      [contentId]
    );
    if (assetRows?.[0]?.id) {
      await pool.query(
        `UPDATE content_assets
         SET storage_provider='local',
             storage_key=?,
             public_url=?,
             mime_type=?,
             byte_size=?
         WHERE id=?`,
        [req.file.path, publicUrl, req.file.mimetype, Number(req.file.size || 0), assetRows[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO content_assets
         (content_item_id, role, storage_provider, storage_key, public_url, mime_type, byte_size)
         VALUES (?, 'video_original', 'local', ?, ?, ?, ?)`,
        [contentId, req.file.path, publicUrl, req.file.mimetype, Number(req.file.size || 0)]
      );
    }

    await pool.query(
      `UPDATE content_items
       SET status='ready'
       WHERE id = ?
       LIMIT 1`,
      [contentId]
    );

    return res.json({
      ok: true,
      content: {
        id: String(contentId),
        status: "ready",
      },
      asset: {
        url: publicUrl,
        mimeType: req.file.mimetype,
        byteSize: Number(req.file.size || 0),
      },
    });
  } catch (e) {
    if (e?.code === "ER_NO_SUCH_TABLE") {
      return res.status(503).json({
        code: "CONTENT_SCHEMA_MISSING",
        message: "Content tables are not ready. Run the content migration.",
      });
    }
    console.error(e);
    return res.status(500).json({ message: "Failed to upload video." });
  }
});

app.post("/content/videos/:id/publish", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid video id." });
    }

    const [rows] = await pool.query(
      `SELECT id, user_id, kind, status
       FROM content_items
       WHERE id = ?
       LIMIT 1`,
      [contentId]
    );
    const content = rows?.[0];
    if (!content || String(content.kind) !== "video") {
      return res.status(404).json({ code: "VIDEO_NOT_FOUND", message: "Video draft not found." });
    }
    if (Number(content.user_id) !== userId) {
      return res.status(403).json({ code: "NOT_OWNER", message: "Only the owner can publish this video." });
    }

    const [assetRows] = await pool.query(
      `SELECT id
       FROM content_assets
       WHERE content_item_id = ? AND role = 'video_original'
       LIMIT 1`,
      [contentId]
    );
    if (!assetRows?.[0]?.id) {
      return res.status(409).json({
        code: "VIDEO_UPLOAD_REQUIRED",
        message: "Upload a video file before publishing.",
      });
    }

    await pool.query(
      `UPDATE content_items
       SET status='published',
           published_at = COALESCE(published_at, NOW())
       WHERE id = ?
       LIMIT 1`,
      [contentId]
    );

    return res.json({
      ok: true,
      content: {
        id: String(contentId),
        status: "published",
      },
    });
  } catch (e) {
    if (e?.code === "ER_NO_SUCH_TABLE") {
      return res.status(503).json({
        code: "CONTENT_SCHEMA_MISSING",
        message: "Content tables are not ready. Run the content migration.",
      });
    }
    console.error(e);
    return res.status(500).json({ message: "Failed to publish video." });
  }
});

app.get("/content/videos/:id", async (req, res) => {
  try {
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid video id." });
    }
    const [rows] = await pool.query(
      `SELECT id, title, summary, body, source_locale, status, published_at, created_at
       FROM content_items
       WHERE id = ? AND kind = 'video' AND deleted_at IS NULL
       LIMIT 1`,
      [contentId]
    );
    const row = rows?.[0];
    if (!row || String(row.status) !== "published") {
      return res.status(404).json({ code: "VIDEO_NOT_FOUND", message: "Video not found." });
    }
    const [assetRows] = await pool.query(
      `SELECT public_url, mime_type, byte_size
       FROM content_assets
       WHERE content_item_id = ? AND role = 'video_original'
       LIMIT 1`,
      [contentId]
    );
    const asset = assetRows?.[0] || null;
    return res.json({
      ok: true,
      item: {
        id: String(row.id),
        title: row.title || "",
        summary: row.summary || "",
        body: row.body || "",
        sourceLocale: row.source_locale || "und",
        status: row.status || "published",
        videoUrl: asset?.public_url || "",
        mimeType: asset?.mime_type || "",
        byteSize: Number(asset?.byte_size || 0),
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
      },
    });
  } catch (e) {
    if (e?.code === "ER_NO_SUCH_TABLE") {
      return res.status(503).json({
        code: "CONTENT_SCHEMA_MISSING",
        message: "Content tables are not ready. Run the content migration.",
      });
    }
    console.error(e);
    return res.status(500).json({ message: "Failed to load video." });
  }
});

app.patch("/admin/users/:id/creator", requireAuth, requireAdmin, async (req, res) => {
  try {
    const targetUserId = Number(req.params.id);
    if (!targetUserId) {
      return res.status(400).json({ code: "INVALID_USER_ID", message: "Invalid user id." });
    }

    const raw = req.body?.canPublishVideo;
    if (typeof raw !== "boolean") {
      return res.status(400).json({
        code: "INVALID_CAN_PUBLISH_VIDEO",
        message: "canPublishVideo must be a boolean.",
      });
    }
    const canPublishVideo = raw === true;

    const [result] = await pool.query(
      `UPDATE users
       SET can_publish_video = ?
       WHERE id = ?
       LIMIT 1`,
      [canPublishVideo ? 1 : 0, targetUserId]
    );
    if (!result?.affectedRows) {
      return res.status(404).json({ code: "USER_NOT_FOUND", message: "User not found." });
    }

    const [rows] = await pool.query(
      `SELECT id, email, username, role, can_publish_video
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [targetUserId]
    );
    const row = rows?.[0];
    const actorUserId = Number(req.user?.sub || 0);
    try {
      if (canPublishVideo) {
        await pool.query(
          `INSERT INTO creator_entitlements (user_id, granted_by_user_id, granted_at, revoked_at, note)
           VALUES (?, ?, NOW(), NULL, ?)
           ON DUPLICATE KEY UPDATE
             granted_by_user_id = VALUES(granted_by_user_id),
             granted_at = NOW(),
             revoked_at = NULL,
             note = VALUES(note)`,
          [targetUserId, actorUserId || null, "Granted from admin API"]
        );
      } else {
        await pool.query(
          `INSERT INTO creator_entitlements (user_id, granted_by_user_id, granted_at, revoked_at, note)
           VALUES (?, ?, NOW(), NOW(), ?)
           ON DUPLICATE KEY UPDATE
             granted_by_user_id = VALUES(granted_by_user_id),
             revoked_at = NOW(),
             note = VALUES(note)`,
          [targetUserId, actorUserId || null, "Revoked from admin API"]
        );
      }
    } catch (auditErr) {
      if (
        auditErr?.code !== "ER_NO_SUCH_TABLE" &&
        auditErr?.code !== "ER_BAD_FIELD_ERROR"
      ) {
        console.error(auditErr);
      }
    }

    return res.json({
      ok: true,
      user: {
        id: String(row.id),
        email: row.email || "",
        username: row.username || "",
        role: row.role || "user",
        canPublishVideo:
          Number(row.can_publish_video || 0) === 1 || String(row.role || "") === "admin",
      },
    });
  } catch (e) {
    if (e?.code === "ER_BAD_FIELD_ERROR") {
      return res.status(503).json({
        code: "CREATOR_COLUMN_MISSING",
        message: "users.can_publish_video is missing. Restart API or run migration.",
      });
    }
    console.error(e);
    return res.status(500).json({ message: "Failed to update creator access." });
  }
});

app.get("/admin/creators", requireAuth, requireAdmin, async (req, res) => {
  try {
    const includeDisabled = String(req.query?.includeDisabled || "").trim().toLowerCase() === "true";
    const [rows] = await pool.query(
      `SELECT u.id, u.email, u.username, u.display_name, u.role, u.can_publish_video
       FROM users u
       ${includeDisabled ? "" : "WHERE u.can_publish_video = 1 OR u.role = 'admin'"}
       ORDER BY (u.can_publish_video = 1 OR u.role = 'admin') DESC, u.id DESC`
    );

    return res.json({
      ok: true,
      users: rows.map((row) => ({
        id: String(row.id),
        email: row.email || "",
        username: row.username || "",
        displayName: row.display_name || "",
        role: row.role || "user",
        canPublishVideo:
          Number(row.can_publish_video || 0) === 1 || String(row.role || "") === "admin",
      })),
    });
  } catch (e) {
    if (e?.code === "ER_BAD_FIELD_ERROR") {
      return res.status(503).json({
        code: "CREATOR_COLUMN_MISSING",
        message: "users.can_publish_video is missing. Restart API or run migration.",
      });
    }
    console.error(e);
    return res.status(500).json({ message: "Failed to load creators list." });
  }
});

app.patch("/me/profile-bio", requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const rawText = req.body?.bioText == null ? "" : String(req.body.bioText);
    const rawAudio = req.body?.bioAudioUrl == null
      ? ""
      : String(req.body.bioAudioUrl).trim();
    const hasAudio = rawAudio.length > 0;
    const parsedDuration = Number(req.body?.bioAudioDuration || 0);
    const bioAudioDuration = Number.isFinite(parsedDuration)
      ? Math.floor(parsedDuration)
      : 0;
    const bioText = rawText.trim();

    if (bioText.length > 150) {
      return res.status(400).json({ message: "Bio text must be 150 characters or less." });
    }

    if (hasAudio) {
      if (!rawAudio.startsWith("data:audio/")) {
        return res.status(400).json({ message: "Voice bio must be an audio recording." });
      }
      if (bioAudioDuration < 1 || bioAudioDuration > 60) {
        return res.status(400).json({ message: "Voice bio must be 60 seconds or less." });
      }
      if (rawAudio.length > 8 * 1024 * 1024) {
        return res.status(400).json({ message: "Voice bio is too large. Keep it under 60 seconds." });
      }
    }

    const normalizedText = bioText.length === 0 ? null : bioText;
    const normalizedAudio = hasAudio ? rawAudio : null;
    const normalizedDuration = hasAudio ? bioAudioDuration : null;

    await pool.query(
      `UPDATE users
       SET bio_text = ?, bio_audio_url = ?, bio_audio_duration = ?
       WHERE id = ?
       LIMIT 1`,
      [normalizedText, normalizedAudio, normalizedDuration, userId]
    );

    return res.json({
      ok: true,
      bioText: normalizedText || "",
      bioAudioUrl: normalizedAudio || "",
      bioAudioDuration: Number(normalizedDuration || 0),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to update profile bio." });
  }
});

app.patch("/me/meet-languages", requireAuth, async (req, res) => {
  const userId = req.user.sub;
  const { languages } = req.body || {};
  if (!Array.isArray(languages)) return res.status(400).json({ message: "languages must be an array" });

  const [rows] = await pool.query(
    `SELECT id, learn_language, plan, role, trial_ends_at, pro_ends_at
     FROM users WHERE id=? LIMIT 1`,
    [userId]
  );
  const u = rows?.[0];
  if (!u) return res.status(404).json({ message: "User not found" });

  const effective = computeEffectivePlan(u);
  const isProLike = effective.role === "admin" || effective.plan === "pro" || effective.plan === "trial";
  if (!isProLike) return res.status(403).json({ message: "Pro required" });

  const base = String(u.learn_language || "").trim();
  if (!base) return res.status(400).json({ message: "Missing learn language on profile" });

  const cleaned = languages.map((x) => String(x || "").trim()).filter(Boolean);
  const final = Array.from(new Set([base, ...cleaned])).slice(0, 3);

  await pool.query("UPDATE users SET meet_languages_json=? WHERE id=?", [JSON.stringify(final), userId]);
  return res.json({ ok: true, meetLanguages: final });
});

app.get("/meet/users", requireAuth, async (req, res) => {
  const lang = String(req.query.lang || "").trim();
  const learn = String(req.query.learn || "").trim();
  const country = String(req.query.country || "").trim();
  const city = String(req.query.city || "").trim();
  const gender = String(req.query.gender || "").trim().toLowerCase();
  const minAge = Math.max(Number(req.query.minAge || 18), 18);
  const maxAge = Math.min(Number(req.query.maxAge || 90), 90);
  const newUsers = String(req.query.newUsers || "").trim().toLowerCase() === "true";
  const nearby = String(req.query.nearby || "").trim().toLowerCase() === "true";
  const limit = Math.min(Number(req.query.limit || 20), 50);
  const offset = Math.max(Number(req.query.offset || 0), 0);
  const where = ["id <> ?"];
  const params = [req.user.sub];

  const [viewerRows] = await pool.query(
    `SELECT city, country, lat, lon
     FROM users
     WHERE id = ?
     LIMIT 1`,
    [req.user.sub]
  );
  const viewer = viewerRows?.[0] || {};

  if (lang) {
    where.push("first_language = ?");
    params.push(lang);
  }
  if (learn) {
    where.push("learn_language = ?");
    params.push(learn);
  }
  if (country) {
    where.push("country = ?");
    params.push(country);
  }
  if (city) {
    where.push("city = ?");
    params.push(city);
  }
  if (gender === "male" || gender === "female") {
    where.push("LOWER(gender) = ?");
    params.push(gender);
  }
  where.push("TIMESTAMPDIFF(YEAR, dob, CURDATE()) BETWEEN ? AND ?");
  params.push(Math.min(minAge, maxAge), Math.max(minAge, maxAge));
  if (newUsers) {
    where.push("created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)");
  }

  params.push(limit, offset);

  const orderBy = nearby
    ? `ORDER BY
         CASE
           WHEN ? <> '' AND city = ? THEN 0
           WHEN ? <> '' AND country = ? THEN 1
           ELSE 2
         END ASC,
         id DESC`
    : `ORDER BY id DESC`;
  const orderParams = nearby
    ? [
        String(viewer.city || ""),
        String(viewer.city || ""),
        String(viewer.country || ""),
        String(viewer.country || ""),
      ]
    : [];

  const [rows] = await pool.query(
    `SELECT id, display_name, username, first_language, learn_language, city, country, country_code, from_country, plan, role, profile_photo_url
     FROM users
     WHERE ${where.join(" AND ")}
     ${orderBy}
     LIMIT ? OFFSET ?`,
    [...params.slice(0, -2), ...orderParams, ...params.slice(-2)]
  );

  return res.json({
    ok: true,
    users: rows.map((u) => ({
      id: u.id,
      displayName: u.display_name,
      username: u.username,
      firstLanguage: u.first_language,
      learnLanguage: u.learn_language,
      city: u.city,
      country: u.country,
      countryCode: u.country_code,
      nationalityCode: u.from_country,
      nationalityName: u.from_country,
      plan: u.plan,
      role: u.role,
      profilePhotoUrl: u.profile_photo_url,
    })),
  });
});

app.get("/meta/cities", requireAuth, async (req, res) => {
  try {
    const country = String(req.query.country || "").trim();
    if (!country) return res.json({ ok: true, cities: [] });

    const [rows] = await pool.query(
      `SELECT DISTINCT city
       FROM users
       WHERE country = ? AND city IS NOT NULL AND city <> ''
       ORDER BY city ASC`,
      [country]
    );

    return res.json({
      ok: true,
      cities: rows.map((row) => String(row.city || "").trim()).filter(Boolean),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load cities" });
  }
});

app.get("/users/:id", requireAuth, async (req, res) => {
  try {
    const targetId = req.params.id;
    const viewerId = req.user.sub;

    const [rows] = await pool.query(
      `SELECT id, display_name, username, city, country, country_code, from_country, first_language, learn_language, profile_photo_url, bio_text, bio_audio_url, bio_audio_duration
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [targetId]
    );

    const u = rows?.[0];
    if (!u) return res.status(404).json({ message: "User not found" });

    const [[followersRow]] = await pool.query(`SELECT COUNT(*) AS count FROM follows WHERE following_id = ?`, [targetId]);
    const [[followingRow]] = await pool.query(`SELECT COUNT(*) AS count FROM follows WHERE follower_id = ?`, [targetId]);
    const [[followingMeRow]] = await pool.query(`SELECT COUNT(*) AS count FROM follows WHERE follower_id = ? AND following_id = ?`, [viewerId, targetId]);

    return res.json({
      ok: true,
      user: {
        id: u.id,
        displayName: u.display_name,
        username: u.username,
        city: u.city,
        country: u.country,
        countryCode: u.country_code,
        nationalityCode: u.from_country,
        nationalityName: u.from_country,
        firstLanguage: u.first_language,
        learnLanguage: u.learn_language,
        profilePhotoUrl: u.profile_photo_url,
        bioText: u.bio_text || "",
        bioAudioUrl: u.bio_audio_url || "",
        bioAudioDuration: Number(u.bio_audio_duration || 0),
        followersCount: Number(followersRow?.count || 0),
        followingCount: Number(followingRow?.count || 0),
        postsCount: 0,
        isFollowing: Number(followingMeRow?.count || 0) > 0,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load user" });
  }
});



async function fetchFollowList(targetId, type, search = "") {
  const whereJoin = type === "following"
    ? "INNER JOIN follows f ON f.following_id = u.id"
    : "INNER JOIN follows f ON f.follower_id = u.id";
  const whereTarget = type === "following" ? "f.follower_id = ?" : "f.following_id = ?";
  const like = `%${String(search || "").trim()}%`;
  const [rows] = await pool.query(
    `SELECT u.id, u.display_name, u.username, u.country, u.country_code, u.from_country, u.profile_photo_url
     FROM users u
     ${whereJoin}
     WHERE ${whereTarget}
       AND (u.display_name LIKE ? OR u.username LIKE ?)
     ORDER BY u.display_name ASC, u.id DESC`,
    [targetId, like, like]
  );
  return rows.map((u) => ({
    id: String(u.id),
    displayName: u.display_name || "User",
    username: u.username || "user",
    country: u.country || "",
    countryCode: u.country_code || "",
    nationalityCode: u.from_country || "",
    nationalityName: u.from_country || "",
    profilePhotoUrl: u.profile_photo_url || "",
  }));
}

app.get("/users/:id/followers", requireAuth, async (req, res) => {
  try {
    const items = await fetchFollowList(Number(req.params.id), "followers", req.query.q || "");
    return res.json({ ok: true, items });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load followers" });
  }
});

app.get("/users/:id/following", requireAuth, async (req, res) => {
  try {
    const items = await fetchFollowList(Number(req.params.id), "following", req.query.q || "");
    return res.json({ ok: true, items });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load following" });
  }
});

app.post("/users/:id/follow", requireAuth, async (req, res) => {
  try {
    const followerId = req.user.sub;
    const followingId = Number(req.params.id);
    if (!followingId || Number(followerId) === followingId) return res.status(400).json({ message: "Invalid follow target" });

    const [[row]] = await pool.query(`SELECT COUNT(*) AS count FROM follows WHERE follower_id=? AND following_id=?`, [followerId, followingId]);

    let following = false;
    if (Number(row?.count || 0) > 0) {
      await pool.query(`DELETE FROM follows WHERE follower_id=? AND following_id=?`, [followerId, followingId]);
    } else {
      await pool.query(`INSERT INTO follows (follower_id, following_id) VALUES (?, ?)`, [followerId, followingId]);
      following = true;
    }

    const [[followersRow]] = await pool.query(`SELECT COUNT(*) AS count FROM follows WHERE following_id=?`, [followingId]);
    const [[followingRow]] = await pool.query(`SELECT COUNT(*) AS count FROM follows WHERE follower_id=?`, [followingId]);

    return res.json({ ok: true, following, followersCount: Number(followersRow?.count || 0), followingCount: Number(followingRow?.count || 0) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to update follow" });
  }
});

function getThreadIdForUsers(a, b) {
  return [String(a), String(b)].sort().join("__");
}

function buildDirectMessagePreview(type, text) {
  const normalizedType = String(type || "text").trim().toLowerCase();
  const trimmedText = String(text || "").trim();
  if (trimmedText.length > 0) return trimmedText;
  if (normalizedType === "image") return "📷 Photo";
  if (normalizedType === "audio") return "🎤 Voice note";
  return "";
}

async function getDirectBlockState(viewerId, otherId) {
  const [rows] = await pool.query(
    `SELECT blocker_id, blocked_id
     FROM user_blocks
     WHERE (blocker_id = ? AND blocked_id = ?)
        OR (blocker_id = ? AND blocked_id = ?)`,
    [viewerId, otherId, otherId, viewerId]
  );

  let youBlockedUser = false;
  let blockedByUser = false;
  for (const row of rows) {
    if (Number(row.blocker_id) === Number(viewerId) && Number(row.blocked_id) === Number(otherId)) {
      youBlockedUser = true;
    }
    if (Number(row.blocker_id) === Number(otherId) && Number(row.blocked_id) === Number(viewerId)) {
      blockedByUser = true;
    }
  }

  return {
    blocked: youBlockedUser || blockedByUser,
    youBlockedUser,
    blockedByUser,
  };
}

function buildBlockedActionMessage({ action, youBlockedUser, blockedByUser }) {
  if (youBlockedUser) {
    return `Unblock this user before ${action}.`;
  }
  if (blockedByUser) {
    return `This user is unavailable for ${action}.`;
  }
  return `This chat is unavailable for ${action}.`;
}


async function buildRecentThreadMetaForUser(ownerId, partnerId, threadId, lastMessageText, lastMessageAt) {
  const [rows] = await pool.query(
    `SELECT id, display_name, username, city, country, country_code, from_country, profile_photo_url
     FROM users
     WHERE id = ?
     LIMIT 1`,
    [partnerId]
  );
  const u = rows?.[0];
  return {
    threadId,
    partnerId: String(partnerId),
    displayName: u?.display_name || "User",
    profilePhotoUrl: u?.profile_photo_url || "",
    city: u?.city || "",
    country: u?.country || "",
    countryCode: u?.country_code || "",
    nationalityCode: u?.from_country || "",
    nationalityName: u?.from_country || "",
    username: u?.username || "",
    lastMessageAt,
    lastMessageText,
  };
}

app.get("/me/recent-chats", requireAuth, async (req, res) => {
  try {
    const meId = Number(req.user.sub);
    const [rows] = await pool.query(
      `SELECT dm.thread_id, dm.sender_id, dm.receiver_id, dm.message_type, dm.message_text, dm.created_at,
              u.id AS partner_id, u.display_name, u.username, u.city, u.country, u.country_code, u.from_country, u.profile_photo_url,
              COALESCE(unread.unread_count, 0) AS unread_count
       FROM direct_messages dm
       INNER JOIN (
         SELECT thread_id, MAX(id) AS max_id
         FROM direct_messages
         WHERE sender_id = ? OR receiver_id = ?
         GROUP BY thread_id
       ) latest ON latest.max_id = dm.id
       INNER JOIN users u ON u.id = CASE WHEN dm.sender_id = ? THEN dm.receiver_id ELSE dm.sender_id END
       LEFT JOIN (
         SELECT thread_id, COUNT(*) AS unread_count
         FROM direct_messages
         WHERE receiver_id = ? AND message_status <> 'read'
         GROUP BY thread_id
       ) unread ON unread.thread_id = dm.thread_id
       ORDER BY dm.created_at DESC, dm.id DESC`,
      [meId, meId, meId, meId]
    );

    return res.json({
      ok: true,
      threads: rows.map((row) => ({
        threadId: row.thread_id,
        partnerId: String(row.partner_id),
        displayName: row.display_name || "User",
        profilePhotoUrl: row.profile_photo_url || "",
        city: row.city || "",
        country: row.country || "",
        countryCode: row.country_code || "",
        nationalityCode: row.from_country || "",
        nationalityName: row.from_country || "",
        username: row.username || "",
        lastMessageAt: new Date(row.created_at).getTime(),
        lastMessageText: buildDirectMessagePreview(row.message_type, row.message_text),
        unreadCount: Number(row.unread_count || 0),
      })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load recent chats" });
  }
});

app.get("/users/:id/messages", requireAuth, async (req, res) => {
  try {
    const meId = Number(req.user.sub);
    const otherId = Number(req.params.id);
    if (!otherId) return res.status(400).json({ message: "Invalid user id" });
    const threadId = getThreadIdForUsers(meId, otherId);
    const blockState = await getDirectBlockState(meId, otherId);
    const [rows] = await pool.query(
      `SELECT id, thread_id, sender_id, receiver_id, message_type, message_text, image_url, audio_url, audio_duration, mime_type, reply_to_message_id, message_status, created_at
       FROM direct_messages
       WHERE thread_id=?
       ORDER BY created_at ASC, id ASC`,
      [threadId]
    );
    return res.json({
      ok: true,
      threadId,
      blocked: blockState.blocked,
      youBlockedUser: blockState.youBlockedUser,
      blockedByUser: blockState.blockedByUser,
      supportsTranslation: false,
      supportsCorrection: false,
      messages: rows.map((m) => ({
        id: String(m.id),
        threadId: m.thread_id,
        fromUserId: String(m.sender_id),
        toUserId: String(m.receiver_id),
        type: m.message_type || (m.audio_url ? "audio" : m.image_url ? "image" : "text"),
        text: m.message_text || "",
        imageUrl: m.image_url || "",
        audioUrl: m.audio_url || "",
        audioDuration: m.audio_duration || 0,
        mimeType: m.mime_type || "",
        replyToMessageId: m.reply_to_message_id ? String(m.reply_to_message_id) : "",
        status: m.message_status,
        createdAt: new Date(m.created_at).getTime(),
      })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load messages" });
  }
});

app.patch("/users/:id/messages/read", requireAuth, async (req, res) => {
  try {
    const meId = Number(req.user.sub);
    const otherId = Number(req.params.id);
    if (!otherId) return res.status(400).json({ message: "Invalid user id" });
    const threadId = getThreadIdForUsers(meId, otherId);
    const [rows] = await pool.query(
      `SELECT id
       FROM direct_messages
       WHERE thread_id=? AND sender_id=? AND receiver_id=? AND message_status <> 'read'
       ORDER BY id ASC`,
      [threadId, otherId, meId]
    );
    const ids = rows.map((row) => String(row.id)).filter(Boolean);
    if (ids.length > 0) {
      const placeholders = ids.map(() => "?").join(", ");
      await pool.query(
        `UPDATE direct_messages
         SET message_status='read'
         WHERE id IN (${placeholders})`,
        ids
      );
      if (io) {
        io.to(`dm:${threadId}`).emit("dm:message:status", {
          threadId,
          messageIds: ids,
          status: "read",
          byUserId: String(meId),
          updatedAt: Date.now(),
        });
      }
    }
    return res.json({ ok: true, threadId, messageIds: ids });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to update read status" });
  }
});

app.post("/users/:id/block", requireAuth, async (req, res) => {
  try {
    const blockerId = Number(req.user.sub);
    const blockedId = Number(req.params.id);
    if (!blockedId || blockerId === blockedId) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    await pool.query(
      `INSERT INTO user_blocks (blocker_id, blocked_id)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE created_at = CURRENT_TIMESTAMP`,
      [blockerId, blockedId]
    );
    return res.json({ ok: true, blockerId: String(blockerId), blockedId: String(blockedId) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to block user" });
  }
});

app.delete("/users/:id/block", requireAuth, async (req, res) => {
  try {
    const blockerId = Number(req.user.sub);
    const blockedId = Number(req.params.id);
    if (!blockedId || blockerId === blockedId) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    await pool.query(
      `DELETE FROM user_blocks
       WHERE blocker_id = ? AND blocked_id = ?`,
      [blockerId, blockedId]
    );
    return res.json({ ok: true, blockerId: String(blockerId), blockedId: String(blockedId) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to unblock user" });
  }
});

app.post("/users/:id/report", requireAuth, async (req, res) => {
  try {
    const reporterId = Number(req.user.sub);
    const reportedUserId = Number(req.params.id);
    const reason = String(req.body?.reason || "").trim().slice(0, 80);
    if (!reportedUserId || reporterId === reportedUserId) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    if (!reason) {
      return res.status(400).json({ message: "A report reason is required" });
    }
    await pool.query(
      `INSERT INTO user_reports (reporter_id, reported_user_id, reason)
       VALUES (?, ?, ?)`,
      [reporterId, reportedUserId, reason]
    );
    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to submit user report" });
  }
});

app.post("/users/:id/messages/:messageId/report", requireAuth, async (req, res) => {
  try {
    const reporterId = Number(req.user.sub);
    const otherId = Number(req.params.id);
    const messageId = Number(req.params.messageId);
    const reason = String(req.body?.reason || "").trim().slice(0, 80);
    if (!otherId || !messageId) {
      return res.status(400).json({ message: "Invalid message report target" });
    }
    if (!reason) {
      return res.status(400).json({ message: "A report reason is required" });
    }

    const threadId = getThreadIdForUsers(reporterId, otherId);
    const [rows] = await pool.query(
      `SELECT id, thread_id, sender_id
       FROM direct_messages
       WHERE id = ? AND thread_id = ?
       LIMIT 1`,
      [messageId, threadId]
    );
    const message = rows?.[0];
    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }
    if (Number(message.sender_id) === reporterId) {
      return res.status(400).json({ message: "You can only report the other user's messages." });
    }

    await pool.query(
      `INSERT INTO direct_message_reports (reporter_id, reported_user_id, message_id, thread_id, reason)
       VALUES (?, ?, ?, ?, ?)`,
      [reporterId, Number(message.sender_id), messageId, threadId, reason]
    );
    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to submit message report" });
  }
});

app.post("/users/:id/messages/:messageId/translate", requireAuth, async (req, res) => {
  return res.status(403).json({ message: "Translation is not enabled for direct chat." });
});

app.post("/users/:id/messages/:messageId/correct", requireAuth, async (req, res) => {
  return res.status(403).json({ message: "Correction is not enabled for direct chat." });
});

app.post("/users/:id/messages", requireAuth, async (req, res) => {
  try {
    const senderId = Number(req.user.sub);
    const receiverId = Number(req.params.id);
    const type = String(req.body?.type || (req.body?.audioUrl ? "audio" : req.body?.imageUrl ? "image" : "text")).trim().toLowerCase();
    const textBody = String(req.body?.text || "").trim();
    const imageUrl = req.body?.imageUrl ? String(req.body.imageUrl) : null;
    const audioUrl = req.body?.audioUrl ? String(req.body.audioUrl) : null;
    const audioDuration = Number(req.body?.audioDuration || 0) || null;
    const mimeType = req.body?.mimeType ? String(req.body.mimeType) : null;
    const clientMessageId = req.body?.clientMessageId ? String(req.body.clientMessageId) : null;
    const replyToMessageId = req.body?.replyToMessageId ? Number(req.body.replyToMessageId) : null;
    if (!receiverId) return res.status(400).json({ message: "Invalid user id" });
    if (senderId === receiverId) return res.status(400).json({ message: "Invalid user id" });
    if (type === "text" && !textBody) return res.status(400).json({ message: "Message text is required" });
    if (type === "image" && !imageUrl) return res.status(400).json({ message: "Image is required" });
    if (type === "audio" && !audioUrl) return res.status(400).json({ message: "Audio is required" });

    const threadId = getThreadIdForUsers(senderId, receiverId);
    const blockState = await getDirectBlockState(senderId, receiverId);
    if (blockState.blocked) {
      return res.status(403).json({
        message: buildBlockedActionMessage({
          action: "messaging",
          youBlockedUser: blockState.youBlockedUser,
          blockedByUser: blockState.blockedByUser,
        }),
      });
    }
    if (replyToMessageId && !Number.isFinite(replyToMessageId)) {
      return res.status(400).json({ message: "Invalid reply target" });
    }
    if (replyToMessageId) {
      const [replyRows] = await pool.query(
        `SELECT id
         FROM direct_messages
         WHERE id = ? AND thread_id = ?
         LIMIT 1`,
        [replyToMessageId, threadId]
      );
      if (!replyRows?.[0]) {
        return res.status(400).json({ message: "Reply target is not available in this chat." });
      }
    }
    let messageStatus = "sent";
    if (io) {
      const room = io.sockets.adapter.rooms.get(`dm:${threadId}`);
      if (room && room.size > 0) {
        for (const socketId of room) {
          const roomSocket = io.sockets.sockets.get(socketId);
          if (String(roomSocket?.user?.userId || "") === String(receiverId)) {
            messageStatus = "delivered";
            break;
          }
        }
      }
    }
    const [result] = await pool.query(
      `INSERT INTO direct_messages (thread_id, sender_id, receiver_id, message_type, message_text, image_url, audio_url, audio_duration, mime_type, reply_to_message_id, message_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent')`,
      [threadId, senderId, receiverId, type, textBody || null, imageUrl, audioUrl, audioDuration, mimeType, replyToMessageId]
    );
    if (messageStatus !== "sent") {
      await pool.query(
        `UPDATE direct_messages SET message_status=? WHERE id=?`,
        [messageStatus, result.insertId]
      );
    }
    const createdAt = Date.now();
    const message = {
      id: String(result.insertId),
      threadId,
      fromUserId: String(senderId),
      toUserId: String(receiverId),
      type,
      text: textBody || "",
      imageUrl: imageUrl || "",
      audioUrl: audioUrl || "",
      audioDuration: audioDuration || 0,
      mimeType: mimeType || "",
      replyToMessageId: replyToMessageId ? String(replyToMessageId) : "",
      status: messageStatus,
      clientMessageId: clientMessageId || "",
      createdAt,
    };

    if (io) {
      try {
        const fallbackText = buildDirectMessagePreview(type, textBody);
        const [senderMeta, receiverMeta] = await Promise.all([
          buildRecentThreadMetaForUser(senderId, receiverId, threadId, fallbackText, createdAt),
          buildRecentThreadMetaForUser(receiverId, senderId, threadId, fallbackText, createdAt),
        ]);
        io.to(`dm:${threadId}`).emit("dm:message", message);
        io.to(`user:${senderId}`).emit("dm:inbox-update", senderMeta);
        io.to(`user:${receiverId}`).emit("dm:inbox-update", receiverMeta);
      } catch (emitErr) {
        console.error(emitErr);
      }
    }

    return res.status(201).json({ ok: true, message });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to save message" });
  }
});

// SIGNUP
app.post("/auth/signup", upload.single("profilePhoto"), async (req, res) => {
    try {
      const body = req.body || {};
  
      const {
        email,
        password,
        displayName,
        //username,
        fromCountry,
        firstLanguage,
        learnLanguage,
        dob,
        gender,
        emailVerificationToken,
      } = body;
  
      if (!emailVerificationToken) {
        return res.status(400).json({ message: "Email verification required." });
      }
  
      let payload;
      try {
        payload = jwt.verify(emailVerificationToken, process.env.JWT_SECRET);
      } catch {
        return res.status(400).json({ message: "Invalid/expired email verification token." });
      }
  
      if (payload?.purpose !== "email_verify") {
        return res.status(400).json({ message: "Invalid verification token purpose." });
      }
  
      const normalizedEmail = String(email).trim().toLowerCase();
      if (payload.email !== normalizedEmail) {
        return res.status(400).json({ message: "Verification does not match this email." });
      }
  
      // Basic validations
      if (!normalizedEmail || !password) return res.status(400).json({ message: "Email and password are required." });
      if (String(password).length < 6) return res.status(400).json({ message: "Password must be at least 6 characters." });
  
      if (!displayName) return res.status(400).json({ message: "Display name is required." });
      if (!fromCountry || !firstLanguage || !learnLanguage || !dob || !gender) {
        return res.status(400).json({ message: "All required fields must be provided." });
      }
  
      // Only male/female
      if (!["male", "female"].includes(String(gender))) {
        return res.status(400).json({ message: "Gender must be male or female." });
      }

      //age
      function isOldEnough(dob) {
        const birth = new Date(dob);
        const today = new Date();
      
        const age =
          today.getFullYear() -
          birth.getFullYear() -
          (today < new Date(today.getFullYear(), birth.getMonth(), birth.getDate())
            ? 1
            : 0);
      
        return age >= 13;
      }

      if (!isOldEnough(dob)) {
        return res.status(400).json({
          message: "You must be at least 13 years old to register.",
        });
      }
  
      const passwordHash = await bcrypt.hash(password, 10);
  
      const profilePhotoUrl = req.file ? `/uploads/${req.file.filename}` : null;

      const username = await generateUniqueUsername(pool, displayName);
  
      try {
        await pool.query(
          `INSERT INTO users
            (email, password_hash, display_name, username, from_country, first_language, learn_language, dob, gender, profile_photo_url, country_code)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            normalizedEmail,
            passwordHash,
            String(displayName).trim(),
            String(username).trim().toLowerCase(),
            String(fromCountry).trim(),
            String(firstLanguage).trim(),
            String(learnLanguage).trim(),
            dob,
            String(gender),
            profilePhotoUrl,
            String(fromCountry).trim().toUpperCase(),
          ]
        );
      } catch (err) {
        if (err && err.code === "ER_DUP_ENTRY") {
          return res.status(409).json({ message: "Email already exists." });
        }
        throw err;
      }

      const [idRows] = await pool.query("SELECT id, email, username FROM users WHERE email = ? LIMIT 1", [
        normalizedEmail,
      ]);
      
      const created = idRows?.[0];
      
      const token = jwt.sign(
        {
          sub: created.id,
          email: created.email,
          username: created.username,
          role: "user",
          plan: "free",
          canPublishVideo: false,
        },
        process.env.JWT_SECRET,
        { expiresIn: "7d" }
      );

      //
      const ip = getClientIp(req);

      try {
        console.log("client ip:", getClientIp(req));
        const loc = await lookupIp(ip);
      
        await pool.query(
          `UPDATE users
           SET city=?, region=?, country=?, country_code=?, lat=?, lon=?, location_source=?, location_updated_at=NOW()
           WHERE email=?`,
          [
            loc.city,
            loc.region,
            loc.country,
            loc.countryCode,
            loc.lat,
            loc.lon,
            "ip",
            normalizedEmail,
          ]
        );
      } catch (e) {
        console.log("IP geo lookup failed:", e.message);
      }
      
      return res.status(201).json({ ok: true, token });
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: "Server error during signup." });
    }
  });

// LOGIN
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }

    const [rows] = await pool.query(
      "SELECT id, email, password_hash, display_name, username, role, plan, trial_ends_at, pro_ends_at, location_updated_at FROM users WHERE email = ? LIMIT 1",
      [String(email).trim().toLowerCase()]
    );

    const user = rows?.[0];
    if (!user) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    const stale =
      !user.location_updated_at ||
      Date.now() - new Date(user.location_updated_at).getTime() > 7 * 24 * 60 * 60 * 1000;

    if (stale) {
      const ip = getClientIp(req);
      try {
        const loc = await lookupIp(ip);
        await pool.query(
          `UPDATE users
           SET city=?, region=?, country=?, country_code=?, lat=?, lon=?, location_source=?, location_updated_at=NOW()
           WHERE id=?`,
          [loc.city, loc.region, loc.country, loc.countryCode, loc.lat, loc.lon, "ip", user.id]
        );
      } catch (e) {
        console.log("IP geo refresh failed:", e.message);
      }
    }

    const effective = computeEffectivePlan(user);
    const capability = await resolveUserVideoCapabilityByEmail(user.email);

    const token = jwt.sign(
      {
        sub: user.id,
        email: user.email,
        username: user.username,
        role: effective.role,
        plan: effective.plan,
        canPublishVideo: capability.canPublishVideo,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        username: user.username,
        role: effective.role,
        plan: effective.plan,
        canPublishVideo: capability.canPublishVideo,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error during login." });
  }
});

const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || "0.0.0.0";

const server = http.createServer(app);

const io = attachSocket(server, pool, { allowedOrigins });

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `[startup] Refusing to start talkflix-api: ${host}:${port} is already in use.`
    );
    process.exit(1);
  }
  console.error("[startup] Unhandled server error", error);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`Talkflix API running on http://${host}:${port}`);
});
