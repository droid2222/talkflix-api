import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import mysql from "mysql2/promise";
import multer from "multer";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import sharp from "sharp";
import { sendEmail } from "./mailer/index.js";
import crypto from "crypto";
import { lookupIp } from "./geo/index.js";
import http from "http";
import http2 from "http2";
import {
  attachSocket,
  createSyntheticLiveBroadcast,
  endSyntheticLiveBroadcast,
  listSyntheticLiveBroadcasts,
  resetAnonymousMatchHistory,
} from "./socket.js";
import {
  FREE_USAGE_LIMIT_KEYS,
  assertDailyUsageAvailable,
  consumeDailyUsage,
  ensureEntitlementTables,
  freeUsageSettingKey,
  getDailyUsageState,
  loadUserPlanIdentity,
  normalizeFreeUsageLimitUpdate,
  readFreeUsageLimits,
  serializeFreeUsageLimits,
} from "./entitlements.js";



dotenv.config();

const isProduction =
  String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
const mailProvider = String(process.env.MAIL_PROVIDER || "ethereal")
  .trim()
  .toLowerCase();
const exposeHealthDetails =
  String(process.env.EXPOSE_HEALTH_DETAILS || "").trim() === "1";
const ANONYMOUS_MATCH_ZERO_COOLDOWN_SETTING_KEY = "anonymous_match_zero_cooldown";
const ANONYMOUS_MATCH_TEST_COOLDOWNS = Object.freeze({
  rematchMs: 0,
  skipMs: 0,
});
const ANONYMOUS_MATCH_PRODUCTION_COOLDOWNS = Object.freeze({
  rematchMs: 2 * 60 * 60 * 1000,
  skipMs: 30 * 60 * 1000,
});

if (isProduction && mailProvider === "ethereal") {
  throw new Error("MAIL_PROVIDER=ethereal is not allowed in production.");
}

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
const coverThumbsDir = path.join(uploadsDir, "cover-thumbs");
if (!fs.existsSync(coverThumbsDir)) fs.mkdirSync(coverThumbsDir, { recursive: true });
const videoStreamsDir = path.join(uploadsDir, "video-streams");
if (!fs.existsSync(videoStreamsDir)) fs.mkdirSync(videoStreamsDir, { recursive: true });
const videoPostersDir = path.join(uploadsDir, "video-posters");
if (!fs.existsSync(videoPostersDir)) fs.mkdirSync(videoPostersDir, { recursive: true });
const videoTeasersDir = path.join(uploadsDir, "video-teasers");
if (!fs.existsSync(videoTeasersDir)) fs.mkdirSync(videoTeasersDir, { recursive: true });
const transcriptAudioDir = path.join(uploadsDir, "transcript-audio");
if (!fs.existsSync(transcriptAudioDir)) fs.mkdirSync(transcriptAudioDir, { recursive: true });
const audioTeasersDir = path.join(uploadsDir, "audio-teasers");
if (!fs.existsSync(audioTeasersDir)) fs.mkdirSync(audioTeasersDir, { recursive: true });
const ffmpegBinary = String(process.env.FFMPEG_BIN || "ffmpeg").trim() || "ffmpeg";
let ffmpegAvailablePromise = null;
const publicShareBaseUrl =
  String(process.env.PUBLIC_SHARE_BASE_URL || "https://www.talkflix.cc")
    .trim()
    .replace(/\/$/, "") || "https://www.talkflix.cc";
const publicSharePreviewSeconds = parseBoundedInt(
  process.env.PUBLIC_SHARE_PREVIEW_SECONDS,
  8,
  3,
  30
);
const iosAssociatedDomainAppIds = ["VPZ2LX24TZ.cc.talkflix.app"];
const androidAppLinkTargets = [
  {
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: "cc.talkflix.app",
      sha256_cert_fingerprints: [
        "86:4C:25:5D:4E:E6:78:12:C9:7B:58:17:24:5F:B5:46:1F:12:74:85:E9:FF:6A:F3:BC:AC:91:AE:5F:7A:40:B0",
      ],
    },
  },
];
const defaultIapProProductIds = [
  "talkflix_pro_monthly_v2",
  "talkflix_pro_6_months",
  "talkflix_pro_yearly",
];
const iapProProductIds = new Set(
  String(process.env.IAP_PRO_PRODUCT_IDS || defaultIapProProductIds.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);
const iapAppleBundleId =
  String(process.env.IAP_APPLE_BUNDLE_ID || process.env.IOS_BUNDLE_ID || "cc.talkflix.app")
    .trim() || "cc.talkflix.app";
const iapGooglePackageName =
  String(process.env.IAP_GOOGLE_PACKAGE_NAME || process.env.ANDROID_PACKAGE_NAME || "cc.talkflix.app")
    .trim() || "cc.talkflix.app";

app.use("/uploads", express.static(uploadsDir));

app.get(/^\/\.well-known\/apple-app-site-association$/, (req, res) => {
  return res.type("application/json").send(
    JSON.stringify({
      applinks: {
        apps: [],
        details: iosAssociatedDomainAppIds.map((appID) => ({
          appID,
          paths: ["/s/*", "/app/live*"],
        })),
      },
    })
  );
});

app.get(/^\/\.well-known\/assetlinks\.json$/, (req, res) => {
  return res.type("application/json").send(JSON.stringify(androidAppLinkTargets));
});

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

const profileMediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const safe = String(file.originalname || "profile_media").replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `profile_${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

const podcastAudioUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const safe = String(file.originalname || "podcast").replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `podcast_${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 512 * 1024 * 1024 }, // 512MB
});

const voiceBioUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const safe = String(file.originalname || "voice_bio").replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `voicebio_${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
});

const directMessageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const safe = String(file.originalname || "attachment").replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `dm_${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
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

const reservedUsernames = new Set([
  "admin",
  "api",
  "app",
  "content",
  "help",
  "login",
  "meet",
  "notifications",
  "profile",
  "settings",
  "signup",
  "support",
  "system",
  "talk",
  "talkflix",
  "upgrade",
  "user",
  "users",
]);

function normalizeUsernameValue(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidUsernameValue(value) {
  const normalized = normalizeUsernameValue(value);
  if (!/^[a-z0-9._]{3,20}$/.test(normalized)) return false;
  if (normalized.startsWith(".") || normalized.endsWith(".")) return false;
  if (normalized.startsWith("_") || normalized.endsWith("_")) return false;
  if (normalized.includes("..") || normalized.includes("__")) return false;
  return !reservedUsernames.has(normalized);
}

function computeAgeFromDob(dobValue) {
  if (!dobValue) return null;
  const birth = new Date(dobValue);
  if (Number.isNaN(birth.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const beforeBirthday =
    today.getMonth() < birth.getMonth() ||
    (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate());
  if (beforeBirthday) {
    age -= 1;
  }
  return age >= 0 ? age : null;
}

function isOldEnoughDate(dobValue) {
  const age = computeAgeFromDob(dobValue);
  return age != null && age >= 13;
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

function optionalAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    req.user = null;
    next();
    return;
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    req.user = null;
  }
  next();
}

function createSessionId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function issueSessionToken({
  userId,
  email,
  username,
  role,
  plan,
  canPublishVideo,
}) {
  const sessionId = createSessionId();
  const token = jwt.sign(
    {
      sub: userId,
      email,
      username,
      role,
      plan,
      canPublishVideo,
      sid: sessionId,
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" }
  );
  return { token, sessionId };
}

const DEFAULT_DIRECT_CALL_ICE_SERVERS = Object.freeze([
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
]);

function isTurnRelayUrl(url) {
  const value = String(url || "").toLowerCase();
  return value.startsWith("turn:") || value.startsWith("turns:");
}

function parseDirectCallIceServers() {
  const rawJson = String(process.env.RTC_ICE_SERVERS_JSON || "").trim();
  if (rawJson) {
    try {
      const decoded = JSON.parse(rawJson);
      if (Array.isArray(decoded)) {
        const parsed = decoded
          .filter((item) => item && typeof item === "object" && item.urls)
          .map((item) => ({
            urls: item.urls,
            username: item.username || undefined,
            credential: item.credential || undefined,
          }));
        if (parsed.length > 0) return parsed;
      }
    } catch (error) {
      console.error("[direct-call] Failed to parse RTC_ICE_SERVERS_JSON", error);
    }
  }

  const turnUrl = String(process.env.RTC_TURN_URL || "").trim();
  const turnUsername = String(process.env.RTC_TURN_USERNAME || "").trim();
  const turnCredential = String(process.env.RTC_TURN_CREDENTIAL || "").trim();
  if (turnUrl && turnUsername && turnCredential) {
    return [
      ...DEFAULT_DIRECT_CALL_ICE_SERVERS,
      {
        urls: turnUrl,
        username: turnUsername,
        credential: turnCredential,
      },
    ];
  }
  return [...DEFAULT_DIRECT_CALL_ICE_SERVERS];
}

function buildDirectCallRtcConfig() {
  const iceServers = parseDirectCallIceServers();
  const hasRelay = iceServers.some((server) =>
    (Array.isArray(server?.urls) ? server.urls : [server?.urls]).some((url) =>
      isTurnRelayUrl(url)
    )
  );
  return {
    iceServers,
    hasRelay,
    rtcConfig: {
      iceServers,
      sdpSemantics: "unified-plan",
      iceCandidatePoolSize: hasRelay ? 8 : 4,
    },
  };
}

const DIRECT_CALL_DEVICE_VERIFIED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const DIRECT_CALL_MAX_CONSECUTIVE_FAILURES = 3;

function parseTimestampMs(value) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function supportsDirectCallBackgroundDevice(row) {
  const channel = String(row?.push_provider || row?.pushProvider || "")
    .trim()
    .toLowerCase();
  return channel === "voip_apns" || channel === "fcm";
}

function isHealthyDirectCallDevice(row) {
  if (Number(row?.enabled || 0) !== 1) return false;
  if (!supportsDirectCallBackgroundDevice(row)) return false;
  const verifiedMs = parseTimestampMs(row?.last_verified_at || row?.lastVerifiedAt || row?.last_seen_at || row?.lastSeenAt);
  if (!verifiedMs) return false;
  if (Date.now() - verifiedMs > DIRECT_CALL_DEVICE_VERIFIED_WINDOW_MS) {
    return false;
  }
  const failureMs = parseTimestampMs(row?.last_push_failure_at || row?.lastPushFailureAt);
  const successMs = parseTimestampMs(row?.last_push_success_at || row?.lastPushSuccessAt);
  const failures = Number(row?.consecutive_failures || row?.consecutiveFailures || 0);
  const verifiedAfterFailure = failureMs > 0 && verifiedMs >= failureMs;
  const successAfterFailure = failureMs > 0 && successMs >= failureMs;
  if (
    failures >= DIRECT_CALL_MAX_CONSECUTIVE_FAILURES &&
    !verifiedAfterFailure &&
    !successAfterFailure
  ) {
    return false;
  }
  return true;
}

function parseDirectThreadMemberIds(threadId) {
  const ids = String(threadId || "")
    .split("__")
    .map((value) => value.trim())
    .filter(Boolean);
  return ids.length === 2 ? ids : [];
}

function isDirectThreadMember(threadId, userId) {
  const ids = parseDirectThreadMemberIds(threadId);
  return ids.includes(String(userId));
}

const ADMIN_ACCOUNT_ROLES = new Set(["superadmin", "moderator", "editor", "support", "viewer"]);

function normalizeAdminAccountRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return ADMIN_ACCOUNT_ROLES.has(role) ? role : "";
}

function hashAdminInviteToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function createAdminSetupToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function getAdminActor(req) {
  const admin = req.admin || {};
  return {
    adminId: admin.kind === "app_user" ? Number(admin.userId || 0) || null : null,
    adminAccountId: admin.kind === "admin_account" ? Number(admin.id || 0) || null : null,
  };
}

function getAdminActorUserId(req) {
  return req.admin?.kind === "app_user" ? Number(req.admin.userId || 0) : 0;
}

async function resolveAdminActor(req) {
  const adminAccountId = Number(req.user?.adminAccountId || req.user?.admin_account_id || 0);
  if (adminAccountId) {
    const [rows] = await pool.query(
      `SELECT id, email, display_name, role, status
       FROM admin_accounts
       WHERE id = ?
       LIMIT 1`,
      [adminAccountId]
    );
    const account = rows?.[0];
    const role = normalizeAdminAccountRole(account?.role);
    const status = String(account?.status || "").toLowerCase();
    if (!account || status !== "active" || !role) return null;
    return {
      kind: "admin_account",
      id: Number(account.id),
      email: account.email || "",
      displayName: account.display_name || "",
      role,
    };
  }

  const callerId = Number(req.user?.sub || 0);
  if (!callerId) return null;
  const [rows] = await pool.query(
    `SELECT id, email, display_name, username, role
     FROM users
     WHERE id = ?
     LIMIT 1`,
    [callerId]
  );
  const user = rows?.[0];
  const role = String(user?.role || "").toLowerCase();
  if (role !== "admin" && role !== "superadmin") return null;
  return {
    kind: "app_user",
    userId: Number(user.id),
    email: user.email || "",
    displayName: user.display_name || "",
    username: user.username || "",
    role,
  };
}

async function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });

  try {
    const admin = await resolveAdminActor(req);
    if (!admin) {
      return res.status(403).json({ code: "ADMIN_ONLY", message: "Admin access required." });
    }
    req.admin = admin;
    return next();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to verify admin access." });
  }
}

async function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });

  try {
    const admin = req.admin || await resolveAdminActor(req);
    if (!admin || admin.role !== "superadmin") {
      return res
        .status(403)
        .json({ code: "SUPERADMIN_ONLY", message: "Super admin access required." });
    }
    req.admin = admin;
    return next();
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to verify super admin access." });
  }
}

function issueAdminSessionToken({ userId = null, adminAccountId = null, email, username = "", displayName = "", role }) {
  const sessionId = createSessionId();
  const token = jwt.sign(
    {
      sub: userId || `admin_account:${adminAccountId}`,
      adminAccountId: adminAccountId || undefined,
      adminKind: adminAccountId ? "admin_account" : "app_user",
      email,
      username,
      displayName,
      role,
      scope: "admin",
      sid: sessionId,
    },
    process.env.JWT_SECRET,
    { expiresIn: "12h" }
  );
  return { token, sessionId };
}

function parseJsonObject(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function parseJsonArray(value, fallback = []) {
  const parsed = parseJsonObject(value, fallback);
  return Array.isArray(parsed) ? parsed : fallback;
}

function normalizeBlogStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (status === "published" || status === "archived") return status;
  return "draft";
}

function normalizeBlogSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function normalizeBlogText(value, maxLength = 10000) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeBlogStringArray(value, maxItems = 12, maxLength = 80) {
  const source = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((item) => item.trim());
  return source
    .map((item) => normalizeBlogText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeBlogSections(value) {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((section) => ({
      heading: normalizeBlogText(section?.heading, 180),
      body: normalizeBlogText(section?.body, 25000),
    }))
    .filter((section) => section.heading || section.body)
    .slice(0, 30);
}

function normalizeBlogTips(value) {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((tip) => ({
      title: normalizeBlogText(tip?.title, 120),
      body: normalizeBlogText(tip?.body, 1000),
    }))
    .filter((tip) => tip.title || tip.body)
    .slice(0, 10);
}

function normalizeBlogReferences(value) {
  const source = Array.isArray(value) ? value : [];
  return source
    .map((reference) => ({
      label: normalizeBlogText(reference?.label, 220),
      url: normalizeBlogText(reference?.url, 600),
    }))
    .filter((reference) => reference.label || reference.url)
    .slice(0, 30);
}

function serializeBlogPostRow(row) {
  return {
    id: Number(row.id || 0),
    slug: row.slug || "",
    status: normalizeBlogStatus(row.status),
    title: row.title || "",
    deck: row.deck || "",
    category: row.category || "",
    tags: parseJsonArray(row.tags_json, []),
    authorName: row.author_name || "",
    reviewerName: row.reviewer_name || "",
    heroImageUrl: row.hero_image_url || "",
    heroAlt: row.hero_alt || "",
    seoTitle: row.seo_title || "",
    seoDescription: row.seo_description || "",
    sections: parseJsonArray(row.sections_json, []),
    tips: parseJsonArray(row.tips_json, []),
    references: parseJsonArray(row.references_json, []),
    relatedSlugs: parseJsonArray(row.related_slugs_json, []),
    correctionNote: row.correction_note || "",
    createdBy: Number(row.created_by || 0),
    updatedBy: Number(row.updated_by || 0),
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function createUniqueBlogSlug({ requestedSlug, title, existingId = null }) {
  const base = normalizeBlogSlug(requestedSlug) || normalizeBlogSlug(title) || `post-${Date.now()}`;
  let candidate = base;
  for (let i = 1; i <= 50; i += 1) {
    const params = [candidate];
    let where = "slug = ?";
    if (existingId) {
      where += " AND id <> ?";
      params.push(Number(existingId));
    }
    const [rows] = await pool.query(
      `SELECT id FROM blog_posts WHERE ${where} LIMIT 1`,
      params
    );
    if (!rows?.length) return candidate;
    candidate = `${base}-${i + 1}`.slice(0, 140);
  }
  return `${base}-${Date.now()}`.slice(0, 140);
}

function normalizeBlogPayload(body) {
  const status = normalizeBlogStatus(body?.status);
  const sections = normalizeBlogSections(body?.sections);
  return {
    status,
    title: normalizeBlogText(body?.title, 220),
    slug: normalizeBlogSlug(body?.slug),
    deck: normalizeBlogText(body?.deck, 800),
    category: normalizeBlogText(body?.category, 80),
    tags: normalizeBlogStringArray(body?.tags, 16, 60),
    authorName: normalizeBlogText(body?.authorName, 120),
    reviewerName: normalizeBlogText(body?.reviewerName, 120),
    heroImageUrl: normalizeBlogText(body?.heroImageUrl, 800),
    heroAlt: normalizeBlogText(body?.heroAlt, 220),
    seoTitle: normalizeBlogText(body?.seoTitle, 220),
    seoDescription: normalizeBlogText(body?.seoDescription, 320),
    sections,
    tips: normalizeBlogTips(body?.tips),
    references: normalizeBlogReferences(body?.references),
    relatedSlugs: normalizeBlogStringArray(body?.relatedSlugs, 8, 140).map(normalizeBlogSlug).filter(Boolean),
    correctionNote: normalizeBlogText(body?.correctionNote, 1200),
  };
}

function normalizeAdminTargetRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (role === "user" || role === "admin" || role === "superadmin") return role;
  return "";
}

function deriveAdminContentType(kind, previewMimeType) {
  const normalizedKind = String(kind || "").trim().toLowerCase();
  if (normalizedKind === "podcast" || normalizedKind === "audio") return "audio";
  if (normalizedKind === "video") return "video";
  if (normalizedKind === "image") return "image";
  if (normalizedKind === "text") return "text";
  const lowerMime = String(previewMimeType || "").trim().toLowerCase();
  if (lowerMime.startsWith("video/")) return "video";
  if (lowerMime.startsWith("image/")) return "image";
  if (lowerMime.startsWith("audio/")) return "audio";
  return "text";
}

function serializeAnonymousMatchCooldownSettings(zeroCooldownEnabled) {
  const enabled = Boolean(zeroCooldownEnabled);
  return {
    zeroCooldownEnabled: enabled,
    active: enabled ? ANONYMOUS_MATCH_TEST_COOLDOWNS : ANONYMOUS_MATCH_PRODUCTION_COOLDOWNS,
    test: ANONYMOUS_MATCH_TEST_COOLDOWNS,
    production: ANONYMOUS_MATCH_PRODUCTION_COOLDOWNS,
  };
}

function defaultAnonymousMatchZeroCooldownEnabled() {
  return !isProduction;
}

async function readAnonymousMatchZeroCooldownSetting() {
  try {
    const [rows] = await pool.query(
      `SELECT setting_value
       FROM app_settings
       WHERE setting_key = ?
       LIMIT 1`,
      [ANONYMOUS_MATCH_ZERO_COOLDOWN_SETTING_KEY]
    );
    const fallback = defaultAnonymousMatchZeroCooldownEnabled();
    if (!rows?.length) return fallback;
    const raw = String(rows[0].setting_value || "").trim().toLowerCase();
    if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
    if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") return true;
    return fallback;
  } catch (error) {
    if (
      error?.code !== "ER_NO_SUCH_TABLE" &&
      error?.code !== "ER_BAD_FIELD_ERROR"
    ) {
      console.error(error);
    }
    return defaultAnonymousMatchZeroCooldownEnabled();
  }
}

async function insertAdminAuditLog({ adminId, adminAccountId = null, action, targetType = null, targetId = null, details = null }) {
  try {
    await pool.query(
      `INSERT INTO admin_audit_log (admin_id, admin_account_id, action, target_type, target_id, details)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        adminId || null,
        adminAccountId || null,
        String(action || "").trim().slice(0, 80),
        targetType ? String(targetType).trim().slice(0, 40) : null,
        targetId != null ? Number(targetId) || null : null,
        details == null ? null : JSON.stringify(details),
      ]
    );
  } catch (error) {
    if (
      error?.code !== "ER_NO_SUCH_TABLE" &&
      error?.code !== "ER_BAD_FIELD_ERROR"
    ) {
      console.error(error);
    }
  }
}

async function countSuperAdmins() {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count
     FROM users
     WHERE LOWER(COALESCE(role, '')) = 'superadmin'`
  );
  return Number(rows?.[0]?.count || 0);
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
    const { token, sessionId } = issueSessionToken({
      userId: user.id,
      email: user.email,
      username: user.username,
      role: "user",
      plan: "trial",
      canPublishVideo: capability.canPublishVideo,
    });

    return res.json({
      ok: true,
      token,
      sessionId,
      trialEndsAt: new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000).toISOString(),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to start trial." });
  }
});

app.post("/billing/iap/verify", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const verifiedPurchase = await verifyIapPurchase(req.body || {});
    await persistVerifiedIapPurchase(userId, verifiedPurchase);
    const { token, sessionId } = await issueBillingSessionToken(userId);

    return res.json({
      ok: true,
      token,
      sessionId,
      productId: verifiedPurchase.productId,
      platform: verifiedPurchase.platform,
      expiresAt: verifiedPurchase.expiresAt.toISOString(),
    });
  } catch (error) {
    const statusCode = Number(error?.statusCode || 500);
    if (statusCode >= 500) {
      console.error("[billing] IAP verification failed", {
        message: error?.message || String(error),
        statusCode,
        storePayload: error?.storePayload || undefined,
      });
    }
    return res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
      ok: false,
      message: error?.message || "Purchase verification failed.",
    });
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

function normalizeIapPlatform(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["ios", "apple", "app_store", "appstore"].includes(normalized)) return "ios";
  if (["android", "google", "google_play", "play"].includes(normalized)) return "android";
  return "";
}

function isAllowedIapProductId(productId) {
  return iapProProductIds.has(String(productId || "").trim());
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function parseStoreTimestampMs(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function decodeBase64UrlJson(value) {
  try {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/").padEnd(
      Math.ceil(raw.length / 4) * 4,
      "="
    );
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function decodeJwsPayload(value) {
  const parts = String(value || "").trim().split(".");
  if (parts.length < 2) return null;
  return decodeBase64UrlJson(parts[1]);
}

function getAppleIapConfig() {
  const issuerId = String(process.env.APPLE_IAP_ISSUER_ID || "").trim();
  const keyId = String(process.env.APPLE_IAP_KEY_ID || "").trim();
  const privateKey = normalizePemValue(process.env.APPLE_IAP_PRIVATE_KEY || "");
  const environment = String(process.env.APPLE_IAP_ENVIRONMENT || "auto")
    .trim()
    .toLowerCase();
  if (!issuerId || !keyId || !privateKey || !iapAppleBundleId) return null;
  return { issuerId, keyId, privateKey, bundleId: iapAppleBundleId, environment };
}

function createAppleIapJwt(config) {
  return jwt.sign(
    { bid: config.bundleId },
    config.privateKey,
    {
      algorithm: "ES256",
      audience: "appstoreconnect-v1",
      expiresIn: "10m",
      header: { kid: config.keyId, typ: "JWT" },
      issuer: config.issuerId,
    }
  );
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchAppleTransactionInfo(config, transactionId) {
  const authorities = config.environment === "sandbox"
    ? ["https://api.storekit-sandbox.itunes.apple.com"]
    : config.environment === "production"
      ? ["https://api.storekit.itunes.apple.com"]
      : [
          "https://api.storekit.itunes.apple.com",
          "https://api.storekit-sandbox.itunes.apple.com",
        ];
  let lastError = null;
  for (const authority of authorities) {
    const response = await fetch(
      `${authority}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`,
      {
        headers: {
          authorization: `Bearer ${createAppleIapJwt(config)}`,
          accept: "application/json",
        },
      }
    );
    const payload = await readJsonResponse(response);
    if (response.ok) {
      return { payload, authority };
    }
    lastError = { statusCode: response.status, payload };
    if (config.environment !== "auto" || ![400, 404].includes(response.status)) {
      break;
    }
  }
  const error = new Error("Apple could not verify this purchase.");
  error.statusCode = lastError?.statusCode || 502;
  error.storePayload = lastError?.payload || {};
  throw error;
}

async function verifyAppleIapPurchase({ productId, purchaseId, verificationData }) {
  const config = getAppleIapConfig();
  if (!config) {
    const error = new Error("Apple purchase verification is not configured.");
    error.statusCode = 503;
    throw error;
  }

  const serverVerificationData = String(
    verificationData?.serverVerificationData || ""
  ).trim();
  const localPayload = decodeJwsPayload(serverVerificationData);
  const transactionId = String(
    purchaseId || localPayload?.transactionId || localPayload?.originalTransactionId || ""
  ).trim();
  if (!transactionId) {
    const error = new Error("Apple transaction id is missing.");
    error.statusCode = 400;
    throw error;
  }

  const { payload, authority } = await fetchAppleTransactionInfo(config, transactionId);
  const transaction = decodeJwsPayload(payload?.signedTransactionInfo);
  if (!transaction) {
    const error = new Error("Apple returned an unreadable transaction.");
    error.statusCode = 502;
    throw error;
  }
  if (String(transaction.bundleId || "") !== config.bundleId) {
    const error = new Error("Apple transaction bundle id does not match this app.");
    error.statusCode = 400;
    throw error;
  }
  if (String(transaction.productId || "") !== productId) {
    const error = new Error("Apple transaction product does not match this Pro plan.");
    error.statusCode = 400;
    throw error;
  }
  if (transaction.revocationDate) {
    const error = new Error("This Apple purchase has been revoked.");
    error.statusCode = 400;
    throw error;
  }
  const expiresAtMs = parseStoreTimestampMs(transaction.expiresDate);
  if (!expiresAtMs || expiresAtMs <= Date.now()) {
    const error = new Error("This Apple subscription is not active.");
    error.statusCode = 400;
    throw error;
  }

  return {
    platform: "ios",
    productId,
    transactionId: String(transaction.transactionId || transactionId),
    originalTransactionId: String(transaction.originalTransactionId || transactionId),
    purchaseToken: serverVerificationData || transactionId,
    storeStatus: "active",
    expiresAt: new Date(expiresAtMs),
    rawResponse: {
      authority,
      environment: transaction.environment || "",
      transactionId: transaction.transactionId || "",
      originalTransactionId: transaction.originalTransactionId || "",
      productId: transaction.productId || "",
      expiresDate: transaction.expiresDate || null,
      purchaseDate: transaction.purchaseDate || null,
      type: transaction.type || "",
    },
  };
}

function getGooglePlayServiceAccountConfig() {
  const serviceAccountJson = String(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || "").trim();
  if (serviceAccountJson) {
    try {
      const parsed = JSON.parse(serviceAccountJson);
      if (parsed.client_email && parsed.private_key) {
        return {
          clientEmail: String(parsed.client_email),
          privateKey: normalizePemValue(parsed.private_key),
        };
      }
    } catch (error) {
      console.error("[billing] Failed to parse GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", error);
    }
  }
  const serviceAccountFile = String(process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE || "").trim();
  if (serviceAccountFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(serviceAccountFile, "utf8"));
      if (parsed.client_email && parsed.private_key) {
        return {
          clientEmail: String(parsed.client_email),
          privateKey: normalizePemValue(parsed.private_key),
        };
      }
    } catch (error) {
      console.error("[billing] Failed to read GOOGLE_PLAY_SERVICE_ACCOUNT_FILE", error);
    }
  }
  const clientEmail = String(process.env.GOOGLE_PLAY_CLIENT_EMAIL || "").trim();
  const privateKey = normalizePemValue(process.env.GOOGLE_PLAY_PRIVATE_KEY || "");
  if (!clientEmail || !privateKey) return null;
  return { clientEmail, privateKey };
}

let cachedGooglePlayAccessToken = "";
let cachedGooglePlayAccessTokenExpiresAt = 0;

async function getGooglePlayAccessToken() {
  const config = getGooglePlayServiceAccountConfig();
  if (!config) return null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    cachedGooglePlayAccessToken &&
    cachedGooglePlayAccessTokenExpiresAt - 60 > nowSeconds
  ) {
    return cachedGooglePlayAccessToken;
  }
  const assertion = jwt.sign(
    {
      scope: "https://www.googleapis.com/auth/androidpublisher",
    },
    config.privateKey,
    {
      algorithm: "RS256",
      audience: "https://oauth2.googleapis.com/token",
      expiresIn: "55m",
      issuer: config.clientEmail,
    }
  );
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const payload = await readJsonResponse(response);
  if (!response.ok || !payload?.access_token) {
    const error = new Error("Google Play authorization failed.");
    error.statusCode = response.status || 502;
    error.storePayload = payload;
    throw error;
  }
  cachedGooglePlayAccessToken = String(payload.access_token);
  cachedGooglePlayAccessTokenExpiresAt =
    nowSeconds + Number(payload.expires_in || 3600);
  return cachedGooglePlayAccessToken;
}

function sanitizeGoogleSubscriptionPayload(payload) {
  return {
    subscriptionState: payload?.subscriptionState || "",
    acknowledgementState: payload?.acknowledgementState || "",
    regionCode: payload?.regionCode || "",
    latestOrderId: payload?.latestOrderId || "",
    lineItems: (Array.isArray(payload?.lineItems) ? payload.lineItems : []).map(
      (lineItem) => ({
        productId: lineItem?.productId || "",
        expiryTime: lineItem?.expiryTime || null,
        autoRenewingPlan: lineItem?.autoRenewingPlan ? { autoRenewEnabled: lineItem.autoRenewingPlan.autoRenewEnabled } : null,
      })
    ),
  };
}

async function verifyGoogleIapPurchase({ productId, purchaseId, verificationData }) {
  const accessToken = await getGooglePlayAccessToken();
  if (!accessToken) {
    const error = new Error("Google Play purchase verification is not configured.");
    error.statusCode = 503;
    throw error;
  }
  const purchaseToken = String(
    verificationData?.serverVerificationData || verificationData?.localVerificationData || ""
  ).trim();
  if (!purchaseToken) {
    const error = new Error("Google Play purchase token is missing.");
    error.statusCode = 400;
    throw error;
  }
  const response = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(iapGooglePackageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    }
  );
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const error = new Error("Google Play could not verify this purchase.");
    error.statusCode = response.status || 502;
    error.storePayload = payload;
    throw error;
  }
  const lineItems = Array.isArray(payload?.lineItems) ? payload.lineItems : [];
  const matchingLineItems = lineItems.filter(
    (lineItem) => String(lineItem?.productId || "") === productId
  );
  const expiresAtMs = Math.max(
    ...matchingLineItems.map((lineItem) => parseStoreTimestampMs(lineItem?.expiryTime)),
    0
  );
  const inactiveStates = new Set([
    "SUBSCRIPTION_STATE_EXPIRED",
    "SUBSCRIPTION_STATE_PENDING",
    "SUBSCRIPTION_STATE_REVOKED",
    "SUBSCRIPTION_STATE_ON_HOLD",
  ]);
  if (matchingLineItems.length === 0) {
    const error = new Error("Google Play purchase product does not match this Pro plan.");
    error.statusCode = 400;
    throw error;
  }
  if (inactiveStates.has(String(payload?.subscriptionState || "")) || !expiresAtMs || expiresAtMs <= Date.now()) {
    const error = new Error("This Google Play subscription is not active.");
    error.statusCode = 400;
    throw error;
  }

  return {
    platform: "android",
    productId,
    transactionId: String(purchaseId || payload?.latestOrderId || sha256Hex(purchaseToken)),
    originalTransactionId: "",
    purchaseToken,
    storeStatus: String(payload?.subscriptionState || "active"),
    expiresAt: new Date(expiresAtMs),
    rawResponse: sanitizeGoogleSubscriptionPayload(payload),
  };
}

async function verifyIapPurchase(payload) {
  const platform = normalizeIapPlatform(payload?.platform);
  const productId = String(payload?.productId || "").trim();
  const purchaseId = String(payload?.purchaseId || "").trim();
  const verificationData = payload?.verificationData || {};
  if (!platform) {
    const error = new Error("Unsupported purchase platform.");
    error.statusCode = 400;
    throw error;
  }
  if (!isAllowedIapProductId(productId)) {
    const error = new Error("Unknown Talkflix Pro product id.");
    error.statusCode = 400;
    throw error;
  }
  if (platform === "ios") {
    return verifyAppleIapPurchase({ productId, purchaseId, verificationData });
  }
  return verifyGoogleIapPurchase({ productId, purchaseId, verificationData });
}

async function persistVerifiedIapPurchase(userId, verifiedPurchase) {
  const purchaseTokenHash = sha256Hex(verifiedPurchase.purchaseToken);
  const [existingRows] = await pool.query(
    `SELECT id, user_id
       FROM iap_purchases
      WHERE platform = ?
        AND (transaction_id = ? OR purchase_token_hash = ?)
      LIMIT 1`,
    [verifiedPurchase.platform, verifiedPurchase.transactionId, purchaseTokenHash]
  );
  const existing = existingRows?.[0];
  if (existing && Number(existing.user_id) !== Number(userId)) {
    const error = new Error("This store purchase is already linked to another Talkflix account.");
    error.statusCode = 409;
    throw error;
  }

  await pool.query(
    `INSERT INTO iap_purchases
       (user_id, platform, product_id, transaction_id, original_transaction_id,
        purchase_token_hash, purchase_token_tail, store_status, expires_at,
        last_verified_at, raw_response_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE
       user_id = VALUES(user_id),
       product_id = VALUES(product_id),
       original_transaction_id = VALUES(original_transaction_id),
       store_status = VALUES(store_status),
       expires_at = VALUES(expires_at),
       last_verified_at = NOW(),
       raw_response_json = VALUES(raw_response_json),
       updated_at = CURRENT_TIMESTAMP`,
    [
      userId,
      verifiedPurchase.platform,
      verifiedPurchase.productId,
      verifiedPurchase.transactionId,
      verifiedPurchase.originalTransactionId || null,
      purchaseTokenHash,
      String(verifiedPurchase.purchaseToken || "").slice(-16) || null,
      verifiedPurchase.storeStatus,
      verifiedPurchase.expiresAt,
      JSON.stringify(verifiedPurchase.rawResponse || {}),
    ]
  );

  await pool.query(
    `UPDATE users
        SET plan = 'pro',
            pro_ends_at = ?
      WHERE id = ?`,
    [verifiedPurchase.expiresAt, userId]
  );
}

async function issueBillingSessionToken(userId) {
  const [rows] = await pool.query(
    `SELECT id, email, username, role, plan, trial_ends_at, pro_ends_at
       FROM users
      WHERE id = ? AND deleted_at IS NULL
      LIMIT 1`,
    [userId]
  );
  const user = rows?.[0];
  if (!user) {
    const error = new Error("User not found.");
    error.statusCode = 404;
    throw error;
  }
  const effective = computeEffectivePlan(user);
  const capability = await resolveUserVideoCapabilityById(user.id);
  return issueSessionToken({
    userId: user.id,
    email: user.email,
    username: user.username,
    role: effective.role,
    plan: effective.plan,
    canPublishVideo: capability.canPublishVideo,
  });
}

function parseCoverPhotoUrls(rawValue) {
  if (!rawValue) return [];
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 2);
  } catch {
    return [];
  }
}

function parseCoverPhotoThumbUrls(rawValue) {
  if (!rawValue) return [];
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 2);
  } catch {
    return [];
  }
}

const relationshipStatusMap = new Map(
  ["Married", "Single", "Divorced", "Searching", "Widowed"].map((value) => [
    value.toLowerCase(),
    value,
  ])
);

function normalizeRelationshipStatus(rawValue) {
  const normalized = String(rawValue || "").trim().toLowerCase();
  if (!normalized) return "";
  return relationshipStatusMap.get(normalized) || "";
}

function serializeCoverPhotoUrls(urls) {
  return JSON.stringify(
    (Array.isArray(urls) ? urls : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 2)
  );
}

function serializeCoverPhotoThumbUrls(urls) {
  return JSON.stringify(
    (Array.isArray(urls) ? urls : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 2)
  );
}

function uploadPathFromPublicUrl(publicUrl) {
  const normalized = String(publicUrl || "").trim();
  if (!normalized.startsWith("/uploads/")) return null;
  const relative = normalized.slice("/uploads/".length);
  if (!relative || relative.includes("..")) return null;
  return path.join(uploadsDir, relative);
}

function removeUploadByPublicUrl(publicUrl) {
  try {
    const filePath = uploadPathFromPublicUrl(publicUrl);
    if (!filePath || !fs.existsSync(filePath)) return;
    fs.unlinkSync(filePath);
  } catch {}
}

async function generateCoverPhotoThumbnail(reqFile) {
  const ext = path.extname(String(reqFile.filename || "")).replace(/[^a-zA-Z0-9.]/g, "") || ".jpg";
  const thumbBase = `${path.basename(reqFile.filename, path.extname(reqFile.filename))}_thumb.jpg`;
  const thumbFilename = ext.toLowerCase() === ".jpg" || ext.toLowerCase() === ".jpeg"
    ? thumbBase
    : thumbBase;
  const thumbPath = path.join(coverThumbsDir, thumbFilename);
  await sharp(reqFile.path)
    .rotate()
    .resize({ width: 480, withoutEnlargement: true, fit: "inside" })
    .jpeg({ quality: 60, mozjpeg: true })
    .toFile(thumbPath);
  return `/uploads/cover-thumbs/${thumbFilename}`;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function hasFfmpeg() {
  if (!ffmpegAvailablePromise) {
    ffmpegAvailablePromise = runCommand(ffmpegBinary, ["-version"])
      .then(() => true)
      .catch(() => false);
  }
  return ffmpegAvailablePromise;
}

async function removeUploadByPublicUrlAsync(publicUrl) {
  try {
    const filePath = uploadPathFromPublicUrl(publicUrl);
    if (!filePath) return;
    await fs.promises.unlink(filePath);
  } catch {}
}

async function upsertContentAsset({
  contentId,
  role,
  assetOrder = 0,
  storageKey,
  publicUrl,
  mimeType,
  byteSize,
}) {
  const numericAssetOrder = Number.isFinite(Number(assetOrder))
    ? Math.max(0, Math.min(Math.trunc(Number(assetOrder)), 99))
    : 0;
  const [rows] = await pool.query(
    `SELECT id, public_url
     FROM content_assets
     WHERE content_item_id = ?
       AND role = ?
       AND asset_order = ?
     LIMIT 1`,
    [contentId, role, numericAssetOrder]
  );
  const previous = rows?.[0]?.public_url ? String(rows[0].public_url) : "";
  await pool.query(
    `INSERT INTO content_assets
     (content_item_id, role, asset_order, storage_provider, storage_key, public_url, mime_type, byte_size)
     VALUES (?, ?, ?, 'local', ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       storage_provider = VALUES(storage_provider),
       storage_key = VALUES(storage_key),
       public_url = VALUES(public_url),
       mime_type = VALUES(mime_type),
       byte_size = VALUES(byte_size)`,
    [
      contentId,
      role,
      numericAssetOrder,
      storageKey,
      publicUrl,
      mimeType,
      byteSize,
    ]
  );
  if (previous && previous !== publicUrl) {
    await removeUploadByPublicUrlAsync(previous);
  }
}

async function buildVideoDerivatives(reqFile, { assetOrder = 0 } = {}) {
  if (!(await hasFfmpeg())) {
    return null;
  }
  const baseStem = `${path.basename(String(reqFile.filename || "video"), path.extname(String(reqFile.filename || "")))}_${assetOrder}`;
  const streamFilename = `${baseStem}_stream.mp4`;
  const posterFilename = `${baseStem}_poster.jpg`;
  const teaserFilename = `${baseStem}_teaser.mp4`;
  const streamPath = path.join(videoStreamsDir, streamFilename);
  const posterPath = path.join(videoPostersDir, posterFilename);
  const teaserPath = path.join(videoTeasersDir, teaserFilename);
  await fs.promises.mkdir(videoStreamsDir, { recursive: true });
  await fs.promises.mkdir(videoPostersDir, { recursive: true });
  await fs.promises.mkdir(videoTeasersDir, { recursive: true });

  await runCommand(ffmpegBinary, [
    "-y",
    "-i",
    reqFile.path,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-movflags",
    "+faststart",
    "-pix_fmt",
    "yuv420p",
    "-vf",
    "scale=min(1080\\,iw):-2:force_original_aspect_ratio=decrease",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    streamPath,
  ]);

  try {
    await runCommand(ffmpegBinary, [
      "-y",
      "-ss",
      "0.5",
      "-i",
      reqFile.path,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      "-vf",
      "scale=min(720\\,iw):-2:force_original_aspect_ratio=decrease",
      posterPath,
    ]);
  } catch {
    await runCommand(ffmpegBinary, [
      "-y",
      "-i",
      reqFile.path,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      "-vf",
      "scale=min(720\\,iw):-2:force_original_aspect_ratio=decrease",
      posterPath,
    ]);
  }

  await runCommand(ffmpegBinary, [
    "-y",
    "-ss",
    "0",
    "-t",
    `${publicSharePreviewSeconds}`,
    "-i",
    reqFile.path,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "24",
    "-movflags",
    "+faststart",
    "-pix_fmt",
    "yuv420p",
    "-vf",
    "scale=min(1080\\,iw):-2:force_original_aspect_ratio=decrease",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    teaserPath,
  ]);

  const streamStat = await fs.promises.stat(streamPath);
  const posterStat = await fs.promises.stat(posterPath);
  const teaserStat = await fs.promises.stat(teaserPath);
  return {
    streamPath,
    streamPublicUrl: `/uploads/video-streams/${streamFilename}`,
    streamMimeType: "video/mp4",
    streamByteSize: Number(streamStat.size || 0),
    posterPath,
    posterPublicUrl: `/uploads/video-posters/${posterFilename}`,
    posterMimeType: "image/jpeg",
    posterByteSize: Number(posterStat.size || 0),
    teaserPath,
    teaserPublicUrl: `/uploads/video-teasers/${teaserFilename}`,
    teaserMimeType: "video/mp4",
    teaserByteSize: Number(teaserStat.size || 0),
  };
}

async function buildTranscriptAudioDerivative(filePath) {
  if (!(await hasFfmpeg())) {
    return null;
  }
  const baseStem = `${path.basename(String(filePath || "media"), path.extname(String(filePath || "")))}_${Date.now()}`;
  const audioFilename = `${baseStem}_transcript.m4a`;
  const audioPath = path.join(transcriptAudioDir, audioFilename);
  await fs.promises.mkdir(transcriptAudioDir, { recursive: true });
  await runCommand(ffmpegBinary, [
    "-y",
    "-i",
    filePath,
    "-vn",
    "-map",
    "0:a:0?",
    "-ac",
    "1",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    audioPath,
  ]);
  return {
    filePath: audioPath,
    mimeType: "audio/mp4",
    cleanup: async () => {
      try {
        await fs.promises.unlink(audioPath);
      } catch {}
    },
  };
}

async function buildAudioTeaserDerivative(filePath, { seconds = publicSharePreviewSeconds } = {}) {
  if (!(await hasFfmpeg())) {
    return null;
  }
  const baseStem = `${path.basename(String(filePath || "audio"), path.extname(String(filePath || "")))}_${Date.now()}`;
  const teaserFilename = `${baseStem}_teaser.m4a`;
  const teaserPath = path.join(audioTeasersDir, teaserFilename);
  await fs.promises.mkdir(audioTeasersDir, { recursive: true });
  await runCommand(ffmpegBinary, [
    "-y",
    "-ss",
    "0",
    "-t",
    `${seconds}`,
    "-i",
    filePath,
    "-vn",
    "-map",
    "0:a:0?",
    "-ac",
    "1",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    teaserPath,
  ]);
  const stat = await fs.promises.stat(teaserPath);
  return {
    filePath: teaserPath,
    publicUrl: `/uploads/audio-teasers/${teaserFilename}`,
    mimeType: "audio/mp4",
    byteSize: Number(stat.size || 0),
  };
}

function buildCoverPhotoVisibility(userRow, viewerId, targetId) {
  const coverPhotoUrls = parseCoverPhotoUrls(userRow.cover_photo_urls_json);
  const coverPhotoThumbUrls = parseCoverPhotoThumbUrls(userRow.cover_photo_thumb_urls_json);
  const sameUser = String(viewerId || "") === String(targetId || "");
  if (sameUser) {
    return { coverPhotoUrls, coverPhotoThumbUrls, coverPhotosLocked: false };
  }
  const effective = computeEffectivePlan(userRow);
  const canExpose =
    effective.role === "admin" ||
    effective.plan === "pro" ||
    effective.plan === "trial";
  return {
    coverPhotoUrls: canExpose ? coverPhotoUrls : [],
    coverPhotoThumbUrls: canExpose ? coverPhotoThumbUrls : [],
    coverPhotosLocked: !canExpose && coverPhotoUrls.length > 0,
  };
}

function isContentCreatorRow(row) {
  const role = String(row?.role || "").trim().toLowerCase();
  return Number(row?.can_publish_video || 0) === 1 || role === "creator";
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
    return { ok: true, canPublishVideo: isContentCreatorRow(row) };
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
      return {
        ok: true,
        canPublishVideo:
          String(row.role || "").trim().toLowerCase() === "creator",
      };
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
    return { ok: true, canPublishVideo: isContentCreatorRow(row) };
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
      return {
        ok: true,
        canPublishVideo:
          String(row.role || "").trim().toLowerCase() === "creator",
      };
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
  
      await pool.query("UPDATE users SET password_hash = ? WHERE email = ? AND deleted_at IS NULL", [passwordHash, reset.email]);
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
      const [rows] = await pool.query("SELECT id FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1", [normalized]);
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
  await ensureEntitlementTables(pool);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_items (
      id BIGINT NOT NULL AUTO_INCREMENT,
      user_id INT NOT NULL,
      kind VARCHAR(20) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      title VARCHAR(512) NOT NULL,
      summary TEXT NULL,
      body LONGTEXT NULL,
      visibility VARCHAR(20) NOT NULL DEFAULT 'public',
      source_locale VARCHAR(16) NOT NULL DEFAULT 'und',
      translation_targets_json LONGTEXT NULL,
      published_at TIMESTAMP NULL DEFAULT NULL,
      deleted_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_content_items_user_created (user_id, created_at),
      KEY idx_content_items_kind_status_published (kind, status, published_at),
      CONSTRAINT fk_content_items_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_assets (
      id BIGINT NOT NULL AUTO_INCREMENT,
      content_item_id BIGINT NOT NULL,
      role VARCHAR(40) NOT NULL,
      asset_order INT NOT NULL DEFAULT 0,
      storage_provider VARCHAR(20) NOT NULL DEFAULT 'local',
      storage_key LONGTEXT NULL,
      public_url LONGTEXT NULL,
      mime_type VARCHAR(120) NULL,
      byte_size BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_content_assets_item_role_order (content_item_id, role, asset_order),
      KEY idx_content_assets_item_id (content_item_id),
      CONSTRAINT fk_content_assets_item FOREIGN KEY (content_item_id) REFERENCES content_items(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_likes (
      content_item_id BIGINT NOT NULL,
      user_id INT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (content_item_id, user_id),
      KEY idx_content_likes_user_id (user_id),
      CONSTRAINT fk_content_likes_item FOREIGN KEY (content_item_id) REFERENCES content_items(id) ON DELETE CASCADE,
      CONSTRAINT fk_content_likes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_views (
      content_item_id BIGINT NOT NULL,
      user_id INT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (content_item_id, user_id),
      KEY idx_content_views_user_id (user_id),
      CONSTRAINT fk_content_views_item FOREIGN KEY (content_item_id) REFERENCES content_items(id) ON DELETE CASCADE,
      CONSTRAINT fk_content_views_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS synthetic_metric_adjustments (
      id BIGINT NOT NULL AUTO_INCREMENT,
      target_type VARCHAR(20) NOT NULL,
      target_id BIGINT NOT NULL,
      metric VARCHAR(20) NOT NULL,
      count_value BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      updated_by_admin_id INT NULL,
      updated_by_admin_account_id BIGINT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_synthetic_metric_target (target_type, target_id, metric),
      KEY idx_synthetic_metric_lookup (target_type, metric, target_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_hides (
      content_item_id BIGINT NOT NULL,
      user_id INT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (content_item_id, user_id),
      KEY idx_content_hides_user_id (user_id),
      CONSTRAINT fk_content_hides_item FOREIGN KEY (content_item_id) REFERENCES content_items(id) ON DELETE CASCADE,
      CONSTRAINT fk_content_hides_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_saves (
      content_item_id BIGINT NOT NULL,
      user_id INT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (content_item_id, user_id),
      KEY idx_content_saves_user_created (user_id, created_at),
      CONSTRAINT fk_content_saves_item FOREIGN KEY (content_item_id) REFERENCES content_items(id) ON DELETE CASCADE,
      CONSTRAINT fk_content_saves_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_share_links (
      id BIGINT NOT NULL AUTO_INCREMENT,
      content_item_id BIGINT NOT NULL,
      public_token VARCHAR(32) NOT NULL,
      created_by_user_id INT NULL,
      preview_seconds INT NOT NULL DEFAULT 8,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_content_share_links_item (content_item_id),
      UNIQUE KEY uniq_content_share_links_token (public_token),
      KEY idx_content_share_links_active_token (is_active, public_token),
      CONSTRAINT fk_content_share_links_item FOREIGN KEY (content_item_id) REFERENCES content_items(id) ON DELETE CASCADE,
      CONSTRAINT fk_content_share_links_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS share_links (
      id BIGINT NOT NULL AUTO_INCREMENT,
      entity_type VARCHAR(32) NOT NULL,
      entity_id VARCHAR(120) NOT NULL,
      public_token VARCHAR(32) NOT NULL,
      created_by_user_id INT NULL,
      preview_seconds INT NOT NULL DEFAULT 8,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      expires_at TIMESTAMP NULL DEFAULT NULL,
      metadata_json LONGTEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_share_links_token (public_token),
      KEY idx_share_links_entity (entity_type, entity_id, is_active),
      KEY idx_share_links_active_token (is_active, public_token),
      KEY idx_share_links_expires_at (expires_at),
      CONSTRAINT fk_share_links_user FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_comments (
      id BIGINT NOT NULL AUTO_INCREMENT,
      content_item_id BIGINT NOT NULL,
      user_id INT NOT NULL,
      parent_comment_id BIGINT NULL,
      body TEXT NOT NULL,
      deleted_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_content_comments_item_created (content_item_id, created_at),
      KEY idx_content_comments_parent_id (parent_comment_id),
      KEY idx_content_comments_user_id (user_id),
      CONSTRAINT fk_content_comments_item FOREIGN KEY (content_item_id) REFERENCES content_items(id) ON DELETE CASCADE,
      CONSTRAINT fk_content_comments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_comment_likes (
      comment_id BIGINT NOT NULL,
      user_id INT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (comment_id, user_id),
      KEY idx_content_comment_likes_user_id (user_id),
      CONSTRAINT fk_content_comment_likes_comment FOREIGN KEY (comment_id) REFERENCES content_comments(id) ON DELETE CASCADE,
      CONSTRAINT fk_content_comment_likes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_transcripts (
      id BIGINT NOT NULL AUTO_INCREMENT,
      content_item_id BIGINT NOT NULL,
      kind VARCHAR(20) NOT NULL DEFAULT 'source',
      language_code VARCHAR(16) NOT NULL,
      source_language_code VARCHAR(16) NOT NULL DEFAULT 'und',
      status VARCHAR(20) NOT NULL DEFAULT 'ready',
      segments_json LONGTEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_content_transcripts_item_kind_lang (content_item_id, kind, language_code),
      KEY idx_content_transcripts_item_created (content_item_id, created_at),
      CONSTRAINT fk_content_transcripts_item FOREIGN KEY (content_item_id) REFERENCES content_items(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
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
      file_url LONGTEXT NULL,
      file_name VARCHAR(255) NULL,
      file_size BIGINT NULL,
      mime_type VARCHAR(120) NULL,
      link_preview_json LONGTEXT NULL,
      edited_at TIMESTAMP NULL DEFAULT NULL,
      deleted_for_everyone_at TIMESTAMP NULL DEFAULT NULL,
      deleted_for_sender_at TIMESTAMP NULL DEFAULT NULL,
      deleted_for_receiver_at TIMESTAMP NULL DEFAULT NULL,
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
    CREATE TABLE IF NOT EXISTS direct_message_reactions (
      message_id BIGINT NOT NULL,
      user_id INT NOT NULL,
      emoji VARCHAR(32) NOT NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id, user_id),
      KEY idx_dmr_user_id (user_id),
      CONSTRAINT fk_dmr_message FOREIGN KEY (message_id) REFERENCES direct_messages(id) ON DELETE CASCADE,
      CONSTRAINT fk_dmr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS direct_message_pins (
      message_id BIGINT NOT NULL,
      user_id INT NOT NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id, user_id),
      KEY idx_dmp_user_id (user_id),
      CONSTRAINT fk_dmp_message FOREIGN KEY (message_id) REFERENCES direct_messages(id) ON DELETE CASCADE,
      CONSTRAINT fk_dmp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS direct_call_sessions (
      id BIGINT NOT NULL AUTO_INCREMENT,
      call_id VARCHAR(64) NOT NULL,
      thread_id VARCHAR(255) NOT NULL,
      caller_id INT NOT NULL,
      callee_id INT NOT NULL,
      wants_video TINYINT(1) NOT NULL DEFAULT 0,
      state VARCHAR(20) NOT NULL DEFAULT 'ringing',
      session_version INT NOT NULL DEFAULT 1,
      metadata_json LONGTEXT NULL,
      initiated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      answered_at TIMESTAMP NULL DEFAULT NULL,
      started_at TIMESTAMP NULL DEFAULT NULL,
      ended_at TIMESTAMP NULL DEFAULT NULL,
      ended_by_user_id INT NULL,
      last_offer_at TIMESTAMP NULL DEFAULT NULL,
      last_answer_at TIMESTAMP NULL DEFAULT NULL,
      last_ice_at TIMESTAMP NULL DEFAULT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_direct_call_sessions_call_id (call_id),
      KEY idx_direct_call_sessions_thread_state (thread_id, state, initiated_at),
      KEY idx_direct_call_sessions_callee_state (callee_id, state, initiated_at),
      KEY idx_direct_call_sessions_caller_state (caller_id, state, initiated_at),
      CONSTRAINT fk_direct_call_sessions_caller FOREIGN KEY (caller_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_direct_call_sessions_callee FOREIGN KEY (callee_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS direct_call_devices (
      id BIGINT NOT NULL AUTO_INCREMENT,
      user_id INT NOT NULL,
      platform VARCHAR(20) NOT NULL,
      push_provider VARCHAR(20) NOT NULL,
      device_token VARCHAR(512) NOT NULL,
      app_bundle VARCHAR(160) NULL,
      device_label VARCHAR(120) NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_verified_at TIMESTAMP NULL DEFAULT NULL,
      last_push_success_at TIMESTAMP NULL DEFAULT NULL,
      last_push_failure_at TIMESTAMP NULL DEFAULT NULL,
      last_push_error VARCHAR(512) NULL,
      consecutive_failures INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_direct_call_devices_provider_token (push_provider, device_token),
      KEY idx_direct_call_devices_user_enabled (user_id, enabled),
      CONSTRAINT fk_direct_call_devices_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_devices (
      id BIGINT NOT NULL AUTO_INCREMENT,
      user_id INT NOT NULL,
      platform VARCHAR(20) NOT NULL,
      push_provider VARCHAR(20) NOT NULL,
      device_token VARCHAR(512) NOT NULL,
      app_bundle VARCHAR(160) NULL,
      device_label VARCHAR(120) NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_push_success_at TIMESTAMP NULL DEFAULT NULL,
      last_push_failure_at TIMESTAMP NULL DEFAULT NULL,
      last_push_error VARCHAR(512) NULL,
      consecutive_failures INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_notification_devices_provider_token (push_provider, device_token),
      KEY idx_notification_devices_user_enabled (user_id, enabled),
      CONSTRAINT fk_notification_devices_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id INT NOT NULL,
      messages_enabled TINYINT(1) NOT NULL DEFAULT 1,
      message_sound_enabled TINYINT(1) NOT NULL DEFAULT 1,
      followers_enabled TINYINT(1) NOT NULL DEFAULT 1,
      follower_sound_enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id),
      CONSTRAINT fk_notification_preferences_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id BIGINT NOT NULL AUTO_INCREMENT,
      user_id INT NOT NULL,
      type VARCHAR(40) NOT NULL,
      title VARCHAR(220) NOT NULL,
      body TEXT NULL,
      from_user_id INT NULL,
      from_display_name VARCHAR(160) NULL,
      from_photo_url LONGTEXT NULL,
      target_id VARCHAR(255) NULL,
      is_read TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      read_at TIMESTAMP NULL DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_notifications_user_read_created (user_id, is_read, created_at),
      KEY idx_notifications_user_created (user_id, created_at),
      KEY idx_notifications_from_user (from_user_id),
      CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_notifications_from_user FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS direct_call_log_deletions (
      id BIGINT NOT NULL AUTO_INCREMENT,
      user_id INT NOT NULL,
      call_id VARCHAR(64) NOT NULL,
      deleted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_direct_call_log_deletions_user_call (user_id, call_id),
      KEY idx_direct_call_log_deletions_user_deleted (user_id, deleted_at),
      CONSTRAINT fk_direct_call_log_deletions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS direct_call_events (
      id BIGINT NOT NULL AUTO_INCREMENT,
      call_id VARCHAR(64) NOT NULL,
      thread_id VARCHAR(255) NOT NULL,
      event_type VARCHAR(40) NOT NULL,
      user_id INT NULL,
      actor_user_id INT NULL,
      delivery_channel VARCHAR(32) NULL,
      success TINYINT(1) NOT NULL DEFAULT 1,
      error_message VARCHAR(512) NULL,
      payload_json LONGTEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_direct_call_events_call_created (call_id, created_at),
      KEY idx_direct_call_events_thread_created (thread_id, created_at),
      KEY idx_direct_call_events_event_created (event_type, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS direct_call_permissions (
      id BIGINT NOT NULL AUTO_INCREMENT,
      owner_user_id INT NOT NULL,
      peer_user_id INT NOT NULL,
      allow_voice_calls TINYINT(1) NULL DEFAULT NULL,
      allow_video_calls TINYINT(1) NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_direct_call_permissions_owner_peer (owner_user_id, peer_user_id),
      KEY idx_direct_call_permissions_peer_owner (peer_user_id, owner_user_id),
      CONSTRAINT fk_direct_call_permissions_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_direct_call_permissions_peer FOREIGN KEY (peer_user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_transcript_jobs (
      id BIGINT NOT NULL AUTO_INCREMENT,
      content_item_id BIGINT NOT NULL,
      source_asset_id BIGINT NULL,
      requested_by_user_id INT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      error_message VARCHAR(512) NULL,
      attempts INT NOT NULL DEFAULT 0,
      started_at TIMESTAMP NULL DEFAULT NULL,
      finished_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_content_transcript_jobs_item (content_item_id),
      KEY idx_content_transcript_jobs_status_updated (status, updated_at),
      CONSTRAINT fk_content_transcript_jobs_item FOREIGN KEY (content_item_id) REFERENCES content_items(id) ON DELETE CASCADE,
      CONSTRAINT fk_content_transcript_jobs_user FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE SET NULL
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
      evidence_json LONGTEXT NULL,
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS anonymous_match_reports (
      id BIGINT NOT NULL AUTO_INCREMENT,
      reporter_id INT NOT NULL,
      reported_user_id INT NOT NULL,
      match_id VARCHAR(80) NOT NULL,
      reason VARCHAR(80) NOT NULL,
      details VARCHAR(1000) NULL,
      evidence_json LONGTEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'open',
      admin_note VARCHAR(1000) NULL,
      reviewed_by_admin_id INT NULL,
      reviewed_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_anonymous_match_reports_status_created (status, created_at),
      KEY idx_anonymous_match_reports_reporter_id (reporter_id),
      KEY idx_anonymous_match_reports_reported_user_id (reported_user_id),
      KEY idx_anonymous_match_reports_match_id (match_id),
      CONSTRAINT fk_anonymous_match_reports_reporter FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_anonymous_match_reports_reported FOREIGN KEY (reported_user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_anonymous_match_reports_reviewed_by FOREIGN KEY (reviewed_by_admin_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_bans (
      id BIGINT NOT NULL AUTO_INCREMENT,
      user_id INT NOT NULL,
      admin_id INT NULL,
      type VARCHAR(20) NOT NULL DEFAULT 'ban',
      reason VARCHAR(255) NULL,
      expires_at TIMESTAMP NULL DEFAULT NULL,
      revoked_at TIMESTAMP NULL DEFAULT NULL,
      revoked_by INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_user_bans_user_active (user_id, revoked_at, expires_at),
      KEY idx_user_bans_admin_id (admin_id),
      CONSTRAINT fk_user_bans_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT fk_user_bans_admin FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_user_bans_revoked_by FOREIGN KEY (revoked_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_accounts (
      id BIGINT NOT NULL AUTO_INCREMENT,
      email VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NULL,
      display_name VARCHAR(160) NOT NULL,
      role VARCHAR(32) NOT NULL DEFAULT 'viewer',
      status VARCHAR(24) NOT NULL DEFAULT 'invited',
      last_login_at TIMESTAMP NULL DEFAULT NULL,
      created_by_admin_account_id BIGINT NULL,
      created_by_user_id INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_admin_accounts_email (email),
      KEY idx_admin_accounts_status_role (status, role),
      KEY idx_admin_accounts_created_by_account (created_by_admin_account_id),
      KEY idx_admin_accounts_created_by_user (created_by_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_invites (
      id BIGINT NOT NULL AUTO_INCREMENT,
      admin_account_id BIGINT NOT NULL,
      email VARCHAR(255) NOT NULL,
      token_hash CHAR(64) NOT NULL,
      role VARCHAR(32) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      accepted_at TIMESTAMP NULL DEFAULT NULL,
      revoked_at TIMESTAMP NULL DEFAULT NULL,
      created_by_admin_account_id BIGINT NULL,
      created_by_user_id INT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_admin_invites_token_hash (token_hash),
      KEY idx_admin_invites_account_created (admin_account_id, created_at),
      KEY idx_admin_invites_email_created (email, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id BIGINT NOT NULL AUTO_INCREMENT,
      admin_id INT NULL,
      admin_account_id BIGINT NULL,
      action VARCHAR(80) NOT NULL,
      target_type VARCHAR(40) NULL,
      target_id BIGINT NULL,
      details LONGTEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_admin_audit_log_admin_created (admin_id, created_at),
      KEY idx_admin_audit_log_admin_account_created (admin_account_id, created_at),
      KEY idx_admin_audit_log_target_created (target_type, target_id, created_at),
      CONSTRAINT fk_admin_audit_log_admin FOREIGN KEY (admin_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key VARCHAR(80) NOT NULL,
      setting_value VARCHAR(255) NOT NULL,
      updated_by_admin_id INT NULL,
      updated_by_admin_account_id BIGINT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (setting_key),
      KEY idx_app_settings_updated_at (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS iap_purchases (
      id BIGINT NOT NULL AUTO_INCREMENT,
      user_id INT NOT NULL,
      platform VARCHAR(20) NOT NULL,
      product_id VARCHAR(160) NOT NULL,
      transaction_id VARCHAR(255) NOT NULL,
      original_transaction_id VARCHAR(255) NULL,
      purchase_token_hash CHAR(64) NOT NULL,
      purchase_token_tail VARCHAR(16) NULL,
      store_status VARCHAR(80) NULL,
      expires_at TIMESTAMP NULL DEFAULT NULL,
      last_verified_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      raw_response_json LONGTEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_iap_purchases_platform_transaction (platform, transaction_id),
      UNIQUE KEY uniq_iap_purchases_platform_token (platform, purchase_token_hash),
      KEY idx_iap_purchases_user_expires (user_id, expires_at),
      KEY idx_iap_purchases_product_expires (product_id, expires_at),
      CONSTRAINT fk_iap_purchases_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blog_posts (
      id BIGINT NOT NULL AUTO_INCREMENT,
      slug VARCHAR(160) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      title VARCHAR(220) NOT NULL,
      deck TEXT NULL,
      category VARCHAR(80) NULL,
      tags_json LONGTEXT NULL,
      author_name VARCHAR(120) NULL,
      reviewer_name VARCHAR(120) NULL,
      hero_image_url LONGTEXT NULL,
      hero_alt VARCHAR(220) NULL,
      seo_title VARCHAR(220) NULL,
      seo_description VARCHAR(320) NULL,
      sections_json LONGTEXT NULL,
      tips_json LONGTEXT NULL,
      references_json LONGTEXT NULL,
      related_slugs_json LONGTEXT NULL,
      correction_note TEXT NULL,
      created_by INT NULL,
      updated_by INT NULL,
      published_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_blog_posts_slug (slug),
      KEY idx_blog_posts_status_published (status, published_at),
      KEY idx_blog_posts_category_status (category, status),
      KEY idx_blog_posts_created_by (created_by),
      CONSTRAINT fk_blog_posts_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT fk_blog_posts_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const alterStatements = [
    "ALTER TABLE direct_messages ADD COLUMN message_type VARCHAR(20) NOT NULL DEFAULT 'text' AFTER receiver_id",
    "ALTER TABLE direct_messages MODIFY COLUMN message_text LONGTEXT NULL",
    "ALTER TABLE direct_messages ADD COLUMN image_url LONGTEXT NULL AFTER message_text",
    "ALTER TABLE direct_messages ADD COLUMN audio_url LONGTEXT NULL AFTER image_url",
    "ALTER TABLE direct_messages ADD COLUMN audio_duration INT NULL AFTER audio_url",
    "ALTER TABLE direct_messages ADD COLUMN file_url LONGTEXT NULL AFTER audio_duration",
    "ALTER TABLE direct_messages ADD COLUMN file_name VARCHAR(255) NULL AFTER file_url",
    "ALTER TABLE direct_messages ADD COLUMN file_size BIGINT NULL AFTER file_name",
    "ALTER TABLE direct_messages ADD COLUMN mime_type VARCHAR(120) NULL AFTER file_size",
    "ALTER TABLE direct_messages ADD COLUMN link_preview_json LONGTEXT NULL AFTER mime_type",
    "ALTER TABLE direct_messages ADD COLUMN edited_at TIMESTAMP NULL DEFAULT NULL AFTER link_preview_json",
    "ALTER TABLE direct_messages ADD COLUMN deleted_for_everyone_at TIMESTAMP NULL DEFAULT NULL AFTER edited_at",
    "ALTER TABLE direct_messages ADD COLUMN deleted_for_sender_at TIMESTAMP NULL DEFAULT NULL AFTER deleted_for_everyone_at",
    "ALTER TABLE direct_messages ADD COLUMN deleted_for_receiver_at TIMESTAMP NULL DEFAULT NULL AFTER deleted_for_sender_at",
    "ALTER TABLE direct_messages ADD COLUMN reply_to_message_id BIGINT NULL AFTER deleted_for_receiver_at",
    "ALTER TABLE direct_messages ADD KEY idx_dm_reply_to_message_id (reply_to_message_id)",
    "ALTER TABLE direct_messages ADD KEY idx_dm_deleted_for_everyone (deleted_for_everyone_at)",
    "ALTER TABLE user_reports ADD COLUMN evidence_json LONGTEXT NULL AFTER reason",
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

  const adminAccountAlterStatements = [
    "ALTER TABLE admin_audit_log MODIFY COLUMN admin_id INT NULL",
    "ALTER TABLE admin_audit_log ADD COLUMN admin_account_id BIGINT NULL AFTER admin_id",
    "ALTER TABLE admin_audit_log ADD KEY idx_admin_audit_log_admin_account_created (admin_account_id, created_at)",
  ];
  for (const sql of adminAccountAlterStatements) {
    try {
      await pool.query(sql);
    } catch (e) {
      if (
        e?.code !== "ER_DUP_FIELDNAME" &&
        e?.code !== "ER_DUP_KEYNAME" &&
        e?.code !== "ER_BAD_FIELD_ERROR"
      ) {
        console.error(e);
      }
    }
  }

  const directCallDeviceAlterStatements = [
    "ALTER TABLE direct_call_devices ADD COLUMN last_verified_at TIMESTAMP NULL DEFAULT NULL AFTER last_seen_at",
    "ALTER TABLE direct_call_devices ADD COLUMN last_push_success_at TIMESTAMP NULL DEFAULT NULL AFTER last_verified_at",
    "ALTER TABLE direct_call_devices ADD COLUMN last_push_failure_at TIMESTAMP NULL DEFAULT NULL AFTER last_push_success_at",
    "ALTER TABLE direct_call_devices ADD COLUMN last_push_error VARCHAR(512) NULL AFTER last_push_failure_at",
    "ALTER TABLE direct_call_devices ADD COLUMN consecutive_failures INT NOT NULL DEFAULT 0 AFTER last_push_error",
  ];
  for (const sql of directCallDeviceAlterStatements) {
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

  const directCallPermissionAlterStatements = [
    "ALTER TABLE direct_call_permissions MODIFY COLUMN allow_voice_calls TINYINT(1) NULL DEFAULT NULL",
    "ALTER TABLE direct_call_permissions MODIFY COLUMN allow_video_calls TINYINT(1) NULL DEFAULT NULL",
  ];
  for (const sql of directCallPermissionAlterStatements) {
    try {
      await pool.query(sql);
    } catch (e) {
      if (
        e?.code !== "ER_BAD_FIELD_ERROR" &&
        e?.code !== "ER_NO_SUCH_TABLE"
      ) {
        console.error(e);
      }
    }
  }

  const userAlterStatements = [
    "ALTER TABLE users ADD COLUMN cover_photo_urls_json LONGTEXT NULL AFTER profile_photo_url",
    "ALTER TABLE users ADD COLUMN cover_photo_thumb_urls_json LONGTEXT NULL AFTER cover_photo_urls_json",
    "ALTER TABLE users ADD COLUMN relationship_status VARCHAR(32) NULL AFTER cover_photo_thumb_urls_json",
    "ALTER TABLE users ADD COLUMN relationship_status_visible TINYINT(1) NOT NULL DEFAULT 0 AFTER relationship_status",
    "ALTER TABLE users ADD COLUMN show_country TINYINT(1) NOT NULL DEFAULT 0 AFTER country_code",
    "ALTER TABLE users ADD COLUMN show_flag TINYINT(1) NOT NULL DEFAULT 0 AFTER show_country",
    "ALTER TABLE users ADD COLUMN show_age TINYINT(1) NOT NULL DEFAULT 0 AFTER show_flag",
    "ALTER TABLE users ADD COLUMN show_follow_stats TINYINT(1) NOT NULL DEFAULT 1 AFTER show_age",
    "ALTER TABLE users ADD COLUMN show_online_status TINYINT(1) NOT NULL DEFAULT 1 AFTER show_follow_stats",
    "ALTER TABLE users ADD COLUMN receive_voice_calls TINYINT(1) NOT NULL DEFAULT 1 AFTER show_online_status",
    "ALTER TABLE users ADD COLUMN receive_video_calls TINYINT(1) NOT NULL DEFAULT 1 AFTER receive_voice_calls",
    "ALTER TABLE users ADD COLUMN bio_text VARCHAR(150) NULL AFTER profile_photo_url",
    "ALTER TABLE users ADD COLUMN bio_audio_url LONGTEXT NULL AFTER bio_text",
    "ALTER TABLE users ADD COLUMN bio_audio_duration INT NULL AFTER bio_audio_url",
    "ALTER TABLE users ADD COLUMN can_publish_video TINYINT(1) NOT NULL DEFAULT 0 AFTER role",
    "ALTER TABLE users ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL AFTER last_login_at",
    "ALTER TABLE users ADD KEY idx_users_deleted_at (deleted_at)",
    "ALTER TABLE users ADD KEY idx_users_can_publish_video (can_publish_video)",
  ];
  for (const sql of userAlterStatements) {
    try {
      await pool.query(sql);
    } catch (e) {
      if (
        e?.code !== "ER_DUP_FIELDNAME" &&
        e?.code !== "ER_BAD_FIELD_ERROR" &&
        e?.code !== "ER_NO_SUCH_TABLE" &&
        e?.code !== "ER_DUP_KEYNAME"
      ) {
        console.error(e);
      }
    }
  }

  const contentAlterStatements = [
    "ALTER TABLE content_items ADD COLUMN visibility VARCHAR(20) NOT NULL DEFAULT 'public' AFTER body",
    "ALTER TABLE content_items ADD COLUMN source_locale VARCHAR(16) NOT NULL DEFAULT 'und' AFTER visibility",
    "ALTER TABLE content_items ADD COLUMN translation_targets_json LONGTEXT NULL AFTER source_locale",
    "ALTER TABLE content_items ADD COLUMN published_at TIMESTAMP NULL DEFAULT NULL AFTER translation_targets_json",
    "ALTER TABLE content_items ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL AFTER published_at",
    "ALTER TABLE content_items ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER deleted_at",
    "ALTER TABLE content_items ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at",
    "ALTER TABLE content_items ADD KEY idx_content_items_user_created (user_id, created_at)",
    "ALTER TABLE content_items ADD KEY idx_content_items_kind_status_published (kind, status, published_at)",
    "ALTER TABLE content_assets ADD COLUMN asset_order INT NOT NULL DEFAULT 0 AFTER role",
    "ALTER TABLE content_assets ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at",
    "ALTER TABLE content_assets ADD KEY idx_content_assets_item_id (content_item_id)",
    "ALTER TABLE content_assets DROP INDEX uniq_content_assets_item_role",
    "ALTER TABLE content_assets ADD UNIQUE KEY uniq_content_assets_item_role_order (content_item_id, role, asset_order)",
    "ALTER TABLE content_comments ADD COLUMN parent_comment_id BIGINT NULL AFTER user_id",
    "ALTER TABLE content_comments ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL AFTER body",
    "ALTER TABLE content_comments ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at",
    "ALTER TABLE content_comments ADD KEY idx_content_comments_item_created (content_item_id, created_at)",
    "ALTER TABLE content_comments ADD KEY idx_content_comments_parent_id (parent_comment_id)",
    "ALTER TABLE content_comments ADD KEY idx_content_comments_user_id (user_id)",
    "ALTER TABLE content_transcripts ADD COLUMN source_language_code VARCHAR(16) NOT NULL DEFAULT 'und' AFTER language_code",
    "ALTER TABLE content_transcripts ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'ready' AFTER source_language_code",
    "ALTER TABLE content_transcripts ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER segments_json",
    "ALTER TABLE content_transcripts ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at",
    "ALTER TABLE content_transcripts ADD UNIQUE KEY uniq_content_transcripts_item_kind_lang (content_item_id, kind, language_code)",
    "ALTER TABLE content_transcripts ADD KEY idx_content_transcripts_item_created (content_item_id, created_at)",
    "ALTER TABLE content_share_links ADD COLUMN created_by_user_id INT NULL AFTER public_token",
    `ALTER TABLE content_share_links ADD COLUMN preview_seconds INT NOT NULL DEFAULT ${publicSharePreviewSeconds} AFTER created_by_user_id`,
    "ALTER TABLE content_share_links ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER preview_seconds",
    "ALTER TABLE content_share_links ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at",
    "ALTER TABLE content_share_links ADD UNIQUE KEY uniq_content_share_links_item (content_item_id)",
    "ALTER TABLE content_share_links ADD UNIQUE KEY uniq_content_share_links_token (public_token)",
    "ALTER TABLE content_share_links ADD KEY idx_content_share_links_active_token (is_active, public_token)",
  ];
  for (const sql of contentAlterStatements) {
    try {
      await pool.query(sql);
    } catch (e) {
      if (
        e?.code !== "ER_DUP_FIELDNAME" &&
        e?.code !== "ER_BAD_FIELD_ERROR" &&
        e?.code !== "ER_DUP_KEYNAME" &&
        e?.code !== "ER_NO_SUCH_TABLE" &&
        e?.code !== "ER_PARSE_ERROR" &&
        e?.code !== "ER_CANT_DROP_FIELD_OR_KEY"
      ) {
        console.error(e);
      }
    }
  }

  const blogAlterStatements = [
    "ALTER TABLE blog_posts ADD COLUMN related_slugs_json LONGTEXT NULL AFTER references_json",
    "ALTER TABLE blog_posts ADD COLUMN correction_note TEXT NULL AFTER related_slugs_json",
    "ALTER TABLE blog_posts ADD COLUMN created_by INT NULL AFTER correction_note",
    "ALTER TABLE blog_posts ADD COLUMN updated_by INT NULL AFTER created_by",
    "ALTER TABLE blog_posts ADD COLUMN published_at TIMESTAMP NULL DEFAULT NULL AFTER updated_by",
    "ALTER TABLE blog_posts ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER published_at",
    "ALTER TABLE blog_posts ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at",
    "ALTER TABLE blog_posts ADD UNIQUE KEY uniq_blog_posts_slug (slug)",
    "ALTER TABLE blog_posts ADD KEY idx_blog_posts_status_published (status, published_at)",
    "ALTER TABLE blog_posts ADD KEY idx_blog_posts_category_status (category, status)",
    "ALTER TABLE blog_posts ADD KEY idx_blog_posts_created_by (created_by)",
  ];
  for (const sql of blogAlterStatements) {
    try {
      await pool.query(sql);
    } catch (e) {
      if (
        e?.code !== "ER_DUP_FIELDNAME" &&
        e?.code !== "ER_BAD_FIELD_ERROR" &&
        e?.code !== "ER_DUP_KEYNAME" &&
        e?.code !== "ER_NO_SUCH_TABLE"
      ) {
        console.error(e);
      }
    }
  }
}
ensureTables().catch((e) => console.error("ensureTables failed", e));

async function ensureTranscriptJobsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_transcript_jobs (
      id BIGINT NOT NULL AUTO_INCREMENT,
      content_item_id BIGINT NOT NULL,
      source_asset_id BIGINT NULL,
      requested_by_user_id INT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      error_message VARCHAR(512) NULL,
      attempts INT NOT NULL DEFAULT 0,
      started_at TIMESTAMP NULL DEFAULT NULL,
      finished_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_content_transcript_jobs_item (content_item_id),
      KEY idx_content_transcript_jobs_status_updated (status, updated_at),
      CONSTRAINT fk_content_transcript_jobs_item FOREIGN KEY (content_item_id) REFERENCES content_items(id) ON DELETE CASCADE,
      CONSTRAINT fk_content_transcript_jobs_user FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

ensureTranscriptJobsTable().catch((e) =>
  console.error("ensureTranscriptJobsTable failed", e)
);

app.get("/health", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 as ok");
    if (exposeHealthDetails) {
      return res.json({ ok: true, db: rows?.[0]?.ok === 1 });
    }
    return res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

app.get("/admin/diagnostics/health", requireAuth, requireAdmin, async (req, res) => {
  const checkedAt = new Date().toISOString();
  try {
    const [rows] = await pool.query("SELECT 1 as ok");
    return res.json({
      ok: true,
      health: {
        api: true,
        db: rows?.[0]?.ok === 1,
        environment: isProduction ? "production" : "development",
        mailProvider,
        checkedAt,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      health: {
        api: false,
        db: false,
        environment: isProduction ? "production" : "development",
        mailProvider,
        checkedAt,
      },
      message: "Failed to load admin health diagnostics.",
    });
  }
});

app.get("/admin/stats/detailed", requireAuth, requireAdmin, async (req, res) => {
  try {
    const [statsRows] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM users) AS total,
         (SELECT COUNT(*) FROM users WHERE LOWER(COALESCE(plan, '')) = 'pro') AS pro,
         (SELECT COUNT(*) FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS newWeek,
         (SELECT COUNT(*) FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS new30,
         (SELECT COUNT(*) FROM content_items WHERE deleted_at IS NULL AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) AS contentMonth,
         (SELECT COUNT(DISTINCT user_id)
            FROM user_bans
           WHERE revoked_at IS NULL
             AND (expires_at IS NULL OR expires_at > NOW())) AS banned`
    );
    const [countryRows] = await pool.query(
      `SELECT
         COALESCE(NULLIF(TRIM(country), ''), NULLIF(TRIM(from_country), ''), NULLIF(TRIM(country_code), ''), 'Unknown') AS name,
         COALESCE(NULLIF(TRIM(country_code), ''), '??') AS code,
         COUNT(*) AS count
       FROM users
       GROUP BY name, code
       ORDER BY count DESC, name ASC
       LIMIT 8`
    );

    const stats = statsRows?.[0] || {};
    const anonymousMatchZeroCooldownEnabled = await readAnonymousMatchZeroCooldownSetting();
    return res.json({
      ok: true,
      stats: {
        total: Number(stats.total || 0),
        pro: Number(stats.pro || 0),
        newWeek: Number(stats.newWeek || 0),
        new30: Number(stats.new30 || 0),
        contentMonth: Number(stats.contentMonth || 0),
        banned: Number(stats.banned || 0),
        topCountries: (countryRows || []).map((row) => ({
          name: row.name || row.code || "Unknown",
          code: row.code || "",
          count: Number(row.count || 0),
        })),
      },
      anonymousMatchCooldown: serializeAnonymousMatchCooldownSettings(
        anonymousMatchZeroCooldownEnabled
      ),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load admin stats." });
  }
});

app.get("/admin/anonymous-match/settings", requireAuth, requireAdmin, async (req, res) => {
  try {
    const zeroCooldownEnabled = await readAnonymousMatchZeroCooldownSetting();
    return res.json({
      ok: true,
      anonymousMatchCooldown: serializeAnonymousMatchCooldownSettings(zeroCooldownEnabled),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load anonymous match settings." });
  }
});

app.patch("/admin/anonymous-match/settings", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (typeof req.body?.zeroCooldownEnabled !== "boolean") {
      return res.status(400).json({ message: "zeroCooldownEnabled must be true or false." });
    }

    const auditActor = getAdminActor(req);
    const zeroCooldownEnabled = Boolean(req.body.zeroCooldownEnabled);
    await pool.query(
      `INSERT INTO app_settings (
         setting_key,
         setting_value,
         updated_by_admin_id,
         updated_by_admin_account_id
       )
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         setting_value = VALUES(setting_value),
         updated_by_admin_id = VALUES(updated_by_admin_id),
         updated_by_admin_account_id = VALUES(updated_by_admin_account_id),
         updated_at = CURRENT_TIMESTAMP`,
      [
        ANONYMOUS_MATCH_ZERO_COOLDOWN_SETTING_KEY,
        zeroCooldownEnabled ? "1" : "0",
        auditActor.adminId || null,
        auditActor.adminAccountId || null,
      ]
    );
    await insertAdminAuditLog({
      ...auditActor,
      action: "update-anonymous-match-settings",
      targetType: "app_setting",
      details: {
        key: ANONYMOUS_MATCH_ZERO_COOLDOWN_SETTING_KEY,
        zeroCooldownEnabled,
      },
    });

    return res.json({
      ok: true,
      anonymousMatchCooldown: serializeAnonymousMatchCooldownSettings(zeroCooldownEnabled),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to update anonymous match settings." });
  }
});

app.post("/admin/anonymous-match/reset-history", requireAuth, requireAdmin, async (req, res) => {
  try {
    const auditActor = getAdminActor(req);
    const reset = resetAnonymousMatchHistory({ actor: auditActor });
    await insertAdminAuditLog({
      ...auditActor,
      action: "reset-anonymous-match-history",
      targetType: "anonymous_match",
      details: reset,
    });

    return res.json({
      ok: true,
      reset,
      message: "Anonymous match history cleared.",
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to clear anonymous match history." });
  }
});

app.get("/admin/pro-limits", requireAuth, requireAdmin, async (req, res) => {
  try {
    const limits = await readFreeUsageLimits(pool);
    return res.json({
      ok: true,
      freeUsageLimits: serializeFreeUsageLimits(limits),
      resetPolicy: "utc_daily",
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load Pro limit settings." });
  }
});

app.patch("/admin/pro-limits", requireAuth, requireAdmin, async (req, res) => {
  try {
    const updates = normalizeFreeUsageLimitUpdate(req.body || {});
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "At least one Pro limit setting is required." });
    }
    const auditActor = getAdminActor(req);
    for (const [key, amount] of Object.entries(updates)) {
      await pool.query(
        `INSERT INTO app_settings (
           setting_key,
           setting_value,
           updated_by_admin_id,
           updated_by_admin_account_id
         )
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           setting_value = VALUES(setting_value),
           updated_by_admin_id = VALUES(updated_by_admin_id),
           updated_by_admin_account_id = VALUES(updated_by_admin_account_id),
           updated_at = CURRENT_TIMESTAMP`,
        [
          freeUsageSettingKey(key),
          String(amount),
          auditActor.adminId || null,
          auditActor.adminAccountId || null,
        ]
      );
    }
    await insertAdminAuditLog({
      ...auditActor,
      action: "update-pro-limits",
      targetType: "app_setting",
      details: { updates },
    });
    const limits = await readFreeUsageLimits(pool);
    return res.json({
      ok: true,
      freeUsageLimits: serializeFreeUsageLimits(limits),
      resetPolicy: "utc_daily",
    });
  } catch (e) {
    console.error(e);
    return res.status(400).json({ message: e?.message || "Failed to update Pro limit settings." });
  }
});

app.get("/admin/users/recent", requireAuth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, email, display_name, username, created_at
       FROM users
       ORDER BY created_at DESC
       LIMIT 12`
    );
    return res.json({
      ok: true,
      users: (rows || []).map((row) => ({
        id: Number(row.id || 0),
        email: row.email || "",
        displayName: row.display_name || "",
        username: row.username || "",
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load recent users." });
  }
});

app.get("/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const q = String(req.query?.q || "").trim();
    const page = Math.max(1, Number(req.query?.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query?.limit || 50)));
    const offset = (page - 1) * limit;
    const params = [];
    const where = [];

    if (q) {
      const like = `%${q}%`;
      const qAsId = Number(q);
      if (Number.isFinite(qAsId) && qAsId > 0) {
        where.push("(u.id = ? OR u.email LIKE ? OR u.display_name LIKE ? OR u.username LIKE ?)");
        params.push(qAsId, like, like, like);
      } else {
        where.push("(u.email LIKE ? OR u.display_name LIKE ? OR u.username LIKE ?)");
        params.push(like, like, like);
      }
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM users u
       ${whereSql}`,
      params
    );
    const [rows] = await pool.query(
      `SELECT
         u.id,
         u.email,
         u.display_name,
         u.username,
         u.role,
         COALESCE(u.can_publish_video, 0) AS can_publish_video,
         u.created_at,
         COALESCE(active_bans.active_ban, 0) AS active_ban,
         COALESCE(u.is_verified, 0) AS is_verified,
         COALESCE(u.can_go_live, 0) AS can_go_live
       FROM users u
       LEFT JOIN (
         SELECT user_id, 1 AS active_ban
         FROM user_bans
         WHERE revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > NOW())
         GROUP BY user_id
       ) active_bans ON active_bans.user_id = u.id
       ${whereSql}
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return res.json({
      ok: true,
      total: Number(countRows?.[0]?.total || 0),
      page,
      limit,
      users: (rows || []).map((row) => ({
        id: Number(row.id || 0),
        email: row.email || "",
        displayName: row.display_name || "",
        username: row.username || "",
        role: String(row.role || "user"),
        canPublishVideo: isContentCreatorRow(row),
        isBanned: Number(row.active_ban || 0) === 1,
        isVerified: Number(row.is_verified || 0) === 1,
        canGoLive: Number(row.can_go_live || 0) === 1,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to search users." });
  }
});

app.get("/admin/users/:id/detail", requireAuth, requireAdmin, async (req, res) => {
  try {
    const targetUserId = Number(req.params.id);
    if (!targetUserId) {
      return res.status(400).json({ message: "Invalid user id." });
    }
    const [rows] = await pool.query(
      `SELECT
         u.id,
         u.email,
         u.display_name,
         u.username,
         u.role,
         COALESCE(u.can_publish_video, 0) AS can_publish_video,
         u.plan,
         u.country,
         u.bio_text,
         u.signup_ip,
         u.created_at,
         u.last_login_at,
         COALESCE(u.is_verified, 0) AS is_verified,
         COALESCE(u.can_go_live, 0) AS can_go_live,
         COALESCE(active_bans.active_ban, 0) AS active_ban,
         (COALESCE(follower_counts.followers, 0) + COALESCE(synthetic_followers.count_value, 0)) AS followers,
         COALESCE(following_counts.following, 0) AS following,
         COALESCE(post_counts.posts, 0) AS posts,
         COALESCE(report_counts.reports_against, 0) AS reports_against
       FROM users u
       LEFT JOIN (
         SELECT user_id, 1 AS active_ban
         FROM user_bans
         WHERE revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > NOW())
         GROUP BY user_id
       ) active_bans ON active_bans.user_id = u.id
       LEFT JOIN (
         SELECT following_id, COUNT(*) AS followers
         FROM follows
         GROUP BY following_id
       ) follower_counts ON follower_counts.following_id = u.id
       LEFT JOIN synthetic_metric_adjustments synthetic_followers
         ON synthetic_followers.target_type = 'user'
        AND synthetic_followers.metric = 'followers'
        AND synthetic_followers.target_id = u.id
       LEFT JOIN (
         SELECT follower_id, COUNT(*) AS following
         FROM follows
         GROUP BY follower_id
       ) following_counts ON following_counts.follower_id = u.id
       LEFT JOIN (
         SELECT user_id, COUNT(*) AS posts
         FROM content_items
         WHERE deleted_at IS NULL
         GROUP BY user_id
       ) post_counts ON post_counts.user_id = u.id
       LEFT JOIN (
         SELECT reported_user_id, COUNT(*) AS reports_against
         FROM (
           SELECT reported_user_id FROM user_reports
           UNION ALL
           SELECT reported_user_id FROM direct_message_reports
         ) report_union
         GROUP BY reported_user_id
       ) report_counts ON report_counts.reported_user_id = u.id
       WHERE u.id = ?
       LIMIT 1`,
      [targetUserId]
    );
    const row = rows?.[0];
    if (!row) {
      return res.status(404).json({ message: "User not found." });
    }
    return res.json({
      ok: true,
      user: {
        id: Number(row.id || 0),
        email: row.email || "",
        displayName: row.display_name || "",
        username: row.username || "",
        role: String(row.role || "user"),
        canPublishVideo: isContentCreatorRow(row),
        plan: String(row.plan || "free"),
        country: row.country || "",
        bioText: row.bio_text || "",
        signupIp: row.signup_ip || "",
        isBanned: Number(row.active_ban || 0) === 1,
        isVerified: Number(row.is_verified || 0) === 1,
        canGoLive: Number(row.can_go_live || 0) === 1,
        followers: Number(row.followers || 0),
        following: Number(row.following || 0),
        posts: Number(row.posts || 0),
        reportsAgainst: Number(row.reports_against || 0),
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load user detail." });
  }
});

async function findAdminPlanTarget(rawIdentity) {
  const identity = String(rawIdentity || "").trim();
  if (!identity) return null;
  const normalized = identity.replace(/^@+/, "").toLowerCase();
  const [rows] = await pool.query(
    `SELECT id, email, display_name, username, role, plan, trial_ends_at, pro_ends_at
     FROM users
     WHERE deleted_at IS NULL
       AND (
         LOWER(email) = ?
         OR LOWER(username) = ?
       )
     LIMIT 1`,
    [normalized, normalized]
  );
  return rows?.[0] || null;
}

function serializeAdminPlanTarget(row) {
  if (!row) return null;
  const effective = computeEffectivePlan(row);
  return {
    id: Number(row.id || 0),
    email: row.email || "",
    displayName: row.display_name || "",
    username: row.username || "",
    role: String(row.role || "user"),
    storedPlan: String(row.plan || "free"),
    effectivePlan: effective.plan,
    trialEndsAt: row.trial_ends_at ? new Date(row.trial_ends_at).toISOString() : null,
    proEndsAt: row.pro_ends_at ? new Date(row.pro_ends_at).toISOString() : null,
  };
}

app.get("/admin/users/plan-lookup", requireAuth, requireAdmin, async (req, res) => {
  try {
    const target = await findAdminPlanTarget(req.query?.q);
    if (!target) return res.status(404).json({ message: "User not found." });
    return res.json({ ok: true, user: serializeAdminPlanTarget(target) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to look up user plan." });
  }
});

app.post("/admin/users/plan", requireAuth, requireAdmin, async (req, res) => {
  try {
    const identity = String(req.body?.q || req.body?.identity || "").trim();
    const nextPlan = String(req.body?.plan || "").trim().toLowerCase();
    if (nextPlan !== "pro" && nextPlan !== "free") {
      return res.status(400).json({ message: "Plan must be pro or free." });
    }
    const target = await findAdminPlanTarget(identity);
    if (!target) return res.status(404).json({ message: "User not found." });

    const targetUserId = Number(target.id || 0);
    if (!targetUserId) return res.status(400).json({ message: "Invalid user target." });

    await pool.query(
      `UPDATE users
       SET plan = ?,
           trial_ends_at = NULL,
           pro_ends_at = NULL
       WHERE id = ?
       LIMIT 1`,
      [nextPlan, targetUserId]
    );
    await insertAdminAuditLog({
      ...getAdminActor(req),
      action: nextPlan === "pro" ? "set-manual-pro" : "set-regular-user",
      targetType: "user",
      targetId: targetUserId,
      details: {
        identity,
        previousPlan: String(target.plan || "free"),
        nextPlan,
      },
    });

    const [rows] = await pool.query(
      `SELECT id, email, display_name, username, role, plan, trial_ends_at, pro_ends_at
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [targetUserId]
    );
    return res.json({ ok: true, user: serializeAdminPlanTarget(rows?.[0]) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to update user plan." });
  }
});

app.post("/admin/users/:id/action", requireAuth, requireAdmin, async (req, res) => {
  try {
    const actorUserId = getAdminActorUserId(req);
    const auditActor = getAdminActor(req);
    const actorRole = String(req.admin?.role || "").toLowerCase();
    const targetUserId = Number(req.params.id);
    const action = String(req.body?.action || "").trim().toLowerCase();
    const value = req.body?.value;
    if (!targetUserId || !action) {
      return res.status(400).json({ message: "Invalid admin action request." });
    }

    const [targetRows] = await pool.query(
      `SELECT id, email, display_name, username, role
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [targetUserId]
    );
    const targetUser = targetRows?.[0];
    if (!targetUser) {
      return res.status(404).json({ message: "User not found." });
    }

    const targetRole = String(targetUser.role || "").toLowerCase();

    if (action === "set-role") {
      if (actorRole !== "superadmin") {
        return res.status(403).json({ message: "Super admin access required." });
      }
      const nextRole = normalizeAdminTargetRole(value);
      if (!nextRole) {
        return res.status(400).json({ message: "Invalid role value." });
      }
      if (actorUserId && actorUserId === targetUserId && nextRole !== "superadmin") {
        return res.status(400).json({ message: "You cannot remove your own super admin role." });
      }
      if (targetRole === "superadmin" && nextRole !== "superadmin") {
        const superAdminCount = await countSuperAdmins();
        if (superAdminCount <= 1) {
          return res.status(400).json({ message: "Cannot remove the last super admin." });
        }
      }
      await pool.query(
        `UPDATE users
         SET role = ?
         WHERE id = ?
         LIMIT 1`,
        [nextRole, targetUserId]
      );
      await insertAdminAuditLog({
        ...auditActor,
        action: "set-role",
        targetType: "user",
        targetId: targetUserId,
        details: { previousRole: targetRole, nextRole },
      });
    } else if (action === "ban") {
      if (targetRole === "superadmin") {
        return res.status(403).json({ message: "Super admin accounts cannot be banned here." });
      }
      await pool.query(
        `UPDATE users
         SET is_banned = 1,
             is_suspended = 1,
             suspended_until = NULL
         WHERE id = ?
         LIMIT 1`,
        [targetUserId]
      );
      await pool.query(
        `INSERT INTO user_bans (user_id, admin_id, type, reason, expires_at, revoked_at, revoked_by)
         VALUES (?, ?, 'ban', ?, NULL, NULL, NULL)`,
        [targetUserId, actorUserId || null, "Banned from admin dashboard"]
      );
      await insertAdminAuditLog({
        ...auditActor,
        action: "ban-user",
        targetType: "user",
        targetId: targetUserId,
        details: { reason: "Banned from admin dashboard" },
      });
    } else if (action === "unban") {
      await pool.query(
        `UPDATE users
         SET is_banned = 0,
             is_suspended = 0,
             suspended_until = NULL
         WHERE id = ?
         LIMIT 1`,
        [targetUserId]
      );
      await pool.query(
        `UPDATE user_bans
         SET revoked_at = NOW(),
             revoked_by = ?
         WHERE user_id = ?
           AND revoked_at IS NULL`,
        [actorUserId || null, targetUserId]
      );
      await insertAdminAuditLog({
        ...auditActor,
        action: "unban-user",
        targetType: "user",
        targetId: targetUserId,
      });
    } else if (action === "verify" || action === "unverify") {
      await pool.query(
        `UPDATE users
         SET is_verified = ?
         WHERE id = ?
         LIMIT 1`,
        [action === "verify" ? 1 : 0, targetUserId]
      );
      await insertAdminAuditLog({
        ...auditActor,
        action,
        targetType: "user",
        targetId: targetUserId,
      });
    } else if (action === "allow-live" || action === "revoke-live") {
      await pool.query(
        `UPDATE users
         SET can_go_live = ?
         WHERE id = ?
         LIMIT 1`,
        [action === "allow-live" ? 1 : 0, targetUserId]
      );
      await insertAdminAuditLog({
        ...auditActor,
        action,
        targetType: "user",
        targetId: targetUserId,
      });
    } else if (action === "allow-creator" || action === "revoke-creator") {
      await pool.query(
        `UPDATE users
         SET can_publish_video = ?
         WHERE id = ?
         LIMIT 1`,
        [action === "allow-creator" ? 1 : 0, targetUserId]
      );
      await insertAdminAuditLog({
        ...auditActor,
        action,
        targetType: "user",
        targetId: targetUserId,
      });
    } else {
      return res.status(400).json({ message: "Unsupported admin action." });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to apply admin action." });
  }
});

app.get("/admin/admins", requireAuth, requireAdmin, async (req, res) => {
  try {
    const [accountRows] = await pool.query(
      `SELECT id, email, display_name, role, status, created_at, last_login_at
       FROM admin_accounts
       ORDER BY CASE WHEN LOWER(role) = 'superadmin' THEN 0 ELSE 1 END,
                CASE WHEN LOWER(status) = 'active' THEN 0 ELSE 1 END,
                created_at ASC, id ASC`
    );
    const [legacyRows] = await pool.query(
      `SELECT id, email, display_name, username, role, created_at, last_login_at
       FROM users
       WHERE LOWER(COALESCE(role, '')) IN ('admin', 'superadmin')
       ORDER BY CASE WHEN LOWER(role) = 'superadmin' THEN 0 ELSE 1 END, created_at ASC, id ASC`
    );
    return res.json({
      ok: true,
      admins: [
        ...(accountRows || []).map((row) => ({
          id: Number(row.id || 0),
          accountType: "admin_account",
          email: row.email || "",
          displayName: row.display_name || "",
          username: "",
          role: String(row.role || "viewer"),
          status: String(row.status || "invited"),
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
          lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
        })),
        ...(legacyRows || []).map((row) => ({
        id: Number(row.id || 0),
        accountType: "app_user",
        email: row.email || "",
        displayName: row.display_name || "",
        username: row.username || "",
        role: String(row.role || "admin"),
        status: "legacy",
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
        })),
      ],
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load admins." });
  }
});

app.post("/admin/invites", requireAuth, requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const displayName = String(req.body?.displayName || "").trim().slice(0, 160) || email;
    const role = normalizeAdminAccountRole(req.body?.role) || "viewer";
    if (!email || !email.includes("@")) {
      return res.status(400).json({ message: "A valid email is required." });
    }
    const actor = getAdminActor(req);
    const token = createAdminSetupToken();
    const tokenHash = hashAdminInviteToken(token);
    const expiresDays = 7;

    const [accountResult] = await pool.query(
      `INSERT INTO admin_accounts (
         email, display_name, role, status, created_by_admin_account_id, created_by_user_id
       )
       VALUES (?, ?, ?, 'invited', ?, ?)
       ON DUPLICATE KEY UPDATE
         display_name = VALUES(display_name),
         role = VALUES(role),
         status = IF(status = 'active', status, 'invited'),
         updated_at = NOW()`,
      [email, displayName, role, actor.adminAccountId, actor.adminId]
    );
    let adminAccountId = Number(accountResult?.insertId || 0);
    if (!adminAccountId) {
      const [existingRows] = await pool.query(
        `SELECT id, status FROM admin_accounts WHERE email = ? LIMIT 1`,
        [email]
      );
      adminAccountId = Number(existingRows?.[0]?.id || 0);
      if (String(existingRows?.[0]?.status || "").toLowerCase() === "active") {
        return res.status(409).json({ message: "This admin account is already active." });
      }
    }
    await pool.query(
      `UPDATE admin_invites
       SET revoked_at = NOW()
       WHERE admin_account_id = ?
         AND accepted_at IS NULL
         AND revoked_at IS NULL`,
      [adminAccountId]
    );
    await pool.query(
      `INSERT INTO admin_invites (
         admin_account_id, email, token_hash, role, expires_at,
         created_by_admin_account_id, created_by_user_id
       )
       VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY), ?, ?)`,
      [adminAccountId, email, tokenHash, role, expiresDays, actor.adminAccountId, actor.adminId]
    );
    const setupUrl = `${publicShareBaseUrl}/admin/?invite=${encodeURIComponent(token)}`;
    await insertAdminAuditLog({
      ...actor,
      action: "invite-admin",
      targetType: "admin_account",
      targetId: adminAccountId,
      details: { email, role },
    });
    return res.status(201).json({ ok: true, setupUrl, expiresDays });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to create admin invite." });
  }
});

app.post("/admin/invites/accept", async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    const displayName = String(req.body?.displayName || "").trim().slice(0, 160);
    const password = String(req.body?.password || "");
    if (!token || !displayName || !password) {
      return res.status(400).json({ message: "Invite token, name, and password are required." });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters." });
    }
    const tokenHash = hashAdminInviteToken(token);
    const [rows] = await pool.query(
      `SELECT inv.id, inv.admin_account_id, inv.email, inv.role, inv.expires_at,
              inv.accepted_at, inv.revoked_at, acc.status
       FROM admin_invites inv
       INNER JOIN admin_accounts acc ON acc.id = inv.admin_account_id
       WHERE inv.token_hash = ?
       LIMIT 1`,
      [tokenHash]
    );
    const invite = rows?.[0];
    if (!invite || invite.accepted_at || invite.revoked_at) {
      return res.status(400).json({ message: "This admin invite is invalid or already used." });
    }
    if (new Date(invite.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ message: "This admin invite has expired." });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
      `UPDATE admin_accounts
       SET display_name = ?,
           password_hash = ?,
           role = ?,
           status = 'active',
           updated_at = NOW()
       WHERE id = ?
       LIMIT 1`,
      [displayName, passwordHash, normalizeAdminAccountRole(invite.role) || "viewer", Number(invite.admin_account_id)]
    );
    await pool.query(
      `UPDATE admin_invites
       SET accepted_at = NOW()
       WHERE id = ?
       LIMIT 1`,
      [Number(invite.id)]
    );
    return res.json({ ok: true, email: invite.email || "" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to accept admin invite." });
  }
});

app.patch("/admin/accounts/:id", requireAuth, requireAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const accountId = Number(req.params.id);
    const role = normalizeAdminAccountRole(req.body?.role);
    const status = String(req.body?.status || "").trim().toLowerCase();
    const displayName = String(req.body?.displayName || "").trim().slice(0, 160);
    if (!accountId) return res.status(400).json({ message: "Invalid admin account id." });
    const updates = [];
    const params = [];
    if (role) {
      updates.push("role = ?");
      params.push(role);
    }
    if (status) {
      if (!["active", "invited", "disabled"].includes(status)) {
        return res.status(400).json({ message: "Invalid admin account status." });
      }
      if (req.admin?.kind === "admin_account" && Number(req.admin.id || 0) === accountId && status !== "active") {
        return res.status(400).json({ message: "You cannot disable your own admin account." });
      }
      updates.push("status = ?");
      params.push(status);
    }
    if (displayName) {
      updates.push("display_name = ?");
      params.push(displayName);
    }
    if (!updates.length) return res.status(400).json({ message: "No changes provided." });
    params.push(accountId);
    const [result] = await pool.query(
      `UPDATE admin_accounts
       SET ${updates.join(", ")}, updated_at = NOW()
       WHERE id = ?
       LIMIT 1`,
      params
    );
    if (!result?.affectedRows) return res.status(404).json({ message: "Admin account not found." });
    await insertAdminAuditLog({
      ...getAdminActor(req),
      action: "update-admin-account",
      targetType: "admin_account",
      targetId: accountId,
      details: { role: role || null, status: status || null, displayName: displayName || null },
    });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to update admin account." });
  }
});

app.post("/admin/admins/:id/promote", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const auditActor = getAdminActor(req);
    const targetUserId = Number(req.params.id);
    if (!targetUserId) {
      return res.status(400).json({ message: "Invalid user id." });
    }
    const [rows] = await pool.query(
      `SELECT id, role
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [targetUserId]
    );
    const user = rows?.[0];
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }
    const currentRole = String(user.role || "").toLowerCase();
    if (currentRole === "superadmin") {
      return res.status(400).json({ message: "User is already a super admin." });
    }
    if (currentRole !== "admin") {
      await pool.query(
        `UPDATE users
         SET role = 'admin'
         WHERE id = ?
         LIMIT 1`,
        [targetUserId]
      );
    }
    await insertAdminAuditLog({
      ...auditActor,
      action: "promote-admin",
      targetType: "user",
      targetId: targetUserId,
      details: { previousRole: currentRole, nextRole: "admin" },
    });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to promote admin." });
  }
});

app.post("/admin/admins/:id/demote", requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const actorUserId = getAdminActorUserId(req);
    const auditActor = getAdminActor(req);
    const targetUserId = Number(req.params.id);
    if (!targetUserId) {
      return res.status(400).json({ message: "Invalid user id." });
    }
    if (actorUserId === targetUserId) {
      return res.status(400).json({ message: "You cannot demote your own admin access here." });
    }
    const [rows] = await pool.query(
      `SELECT id, role
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [targetUserId]
    );
    const user = rows?.[0];
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }
    const currentRole = String(user.role || "").toLowerCase();
    if (currentRole === "superadmin") {
      return res.status(403).json({ message: "Super admin accounts are protected." });
    }
    if (currentRole !== "admin") {
      return res.status(400).json({ message: "User is not an admin." });
    }
    await pool.query(
      `UPDATE users
       SET role = 'user'
       WHERE id = ?
       LIMIT 1`,
      [targetUserId]
    );
    await insertAdminAuditLog({
      ...auditActor,
      action: "demote-admin",
      targetType: "user",
      targetId: targetUserId,
      details: { previousRole: currentRole, nextRole: "user" },
    });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to demote admin." });
  }
});

app.get("/admin/content", requireAuth, requireAdmin, async (req, res) => {
  try {
    const type = String(req.query?.type || "").trim().toLowerCase();
    const page = Math.max(1, Number(req.query?.page || 1));
    const limit = 50;
    const offset = (page - 1) * limit;
    const typeFilter = type && ["video", "image", "text", "audio"].includes(type) ? type : "";
    const typeExpression = `
      CASE
        WHEN LOWER(COALESCE(c.kind, '')) IN ('podcast', 'audio') THEN 'audio'
        WHEN LOWER(COALESCE(c.kind, '')) = 'video' THEN 'video'
        WHEN LOWER(COALESCE(c.kind, '')) = 'image' THEN 'image'
        WHEN LOWER(COALESCE(c.kind, '')) = 'text' THEN 'text'
        WHEN EXISTS (
          SELECT 1
          FROM content_assets a_video
          WHERE a_video.content_item_id = c.id
            AND LOWER(COALESCE(a_video.mime_type, '')) LIKE 'video/%'
        ) THEN 'video'
        WHEN EXISTS (
          SELECT 1
          FROM content_assets a_image
          WHERE a_image.content_item_id = c.id
            AND LOWER(COALESCE(a_image.mime_type, '')) LIKE 'image/%'
        ) THEN 'image'
        WHEN EXISTS (
          SELECT 1
          FROM content_assets a_audio
          WHERE a_audio.content_item_id = c.id
            AND LOWER(COALESCE(a_audio.mime_type, '')) LIKE 'audio/%'
        ) THEN 'audio'
        ELSE 'text'
      END`;
    const whereSql = `
      WHERE c.deleted_at IS NULL
        AND (${typeFilter ? `${typeExpression} = ?` : "1=1"})`;
    const params = typeFilter ? [typeFilter] : [];

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM content_items c
       ${whereSql}`,
      params
    );
    const [rows] = await pool.query(
      `SELECT
         c.id,
         c.kind,
         c.title,
         c.body,
         c.created_at,
         u.display_name,
         u.username,
         ${typeExpression} AS resolved_type,
         (
           SELECT a.mime_type
           FROM content_assets a
           WHERE a.content_item_id = c.id
           ORDER BY a.asset_order ASC, a.id ASC
           LIMIT 1
         ) AS preview_mime_type,
         (COALESCE(like_counts.like_count, 0) + COALESCE(synthetic_like_counts.count_value, 0)) AS like_count,
         (COALESCE(view_counts.view_count, 0) + COALESCE(synthetic_view_counts.count_value, 0)) AS view_count
       FROM content_items c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN (
         SELECT content_item_id, COUNT(*) AS like_count
         FROM content_likes
         GROUP BY content_item_id
       ) like_counts ON like_counts.content_item_id = c.id
     LEFT JOIN synthetic_metric_adjustments synthetic_like_counts
       ON synthetic_like_counts.target_type = 'content'
      AND synthetic_like_counts.metric = 'likes'
      AND synthetic_like_counts.target_id = c.id
       LEFT JOIN (
         SELECT content_item_id, COUNT(*) AS view_count
         FROM content_views
         GROUP BY content_item_id
       ) view_counts ON view_counts.content_item_id = c.id
     LEFT JOIN synthetic_metric_adjustments synthetic_view_counts
       ON synthetic_view_counts.target_type = 'content'
      AND synthetic_view_counts.metric = 'views'
      AND synthetic_view_counts.target_id = c.id
       ${whereSql}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return res.json({
      ok: true,
      total: Number(countRows?.[0]?.total || 0),
      page,
      limit,
      items: (rows || []).map((row) => ({
        id: Number(row.id || 0),
        type: deriveAdminContentType(row.resolved_type || row.kind, row.preview_mime_type),
        title: row.title || "",
        bodyText: row.body || "",
        authorName: row.display_name || "",
        authorUsername: row.username || "",
        likes: Number(row.like_count || 0),
        views: Number(row.view_count || 0),
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load content." });
  }
});

app.delete("/admin/content/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const auditActor = getAdminActor(req);
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({ message: "Invalid content id." });
    }
    const [result] = await pool.query(
      `UPDATE content_items
       SET deleted_at = NOW()
       WHERE id = ?
         AND deleted_at IS NULL
       LIMIT 1`,
      [contentId]
    );
    if (!result?.affectedRows) {
      return res.status(404).json({ message: "Content not found." });
    }
    await insertAdminAuditLog({
      ...auditActor,
      action: "delete-content",
      targetType: "content",
      targetId: contentId,
    });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to delete content." });
  }
});

app.get("/admin/synthetic-metrics/user", requireAuth, requireAdmin, async (req, res) => {
  try {
    const email = String(req.query?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ message: "Email is required." });
    const [rows] = await pool.query(
      `SELECT id, email, display_name, username
       FROM users
       WHERE LOWER(email) = ?
         AND deleted_at IS NULL
       LIMIT 1`,
      [email]
    );
    const user = rows?.[0];
    if (!user?.id) return res.status(404).json({ message: "User not found." });
    const followers = await getFollowerCountWithSynthetic(Number(user.id));
    return res.json({
      ok: true,
      user: {
        id: Number(user.id),
        email: user.email || "",
        displayName: user.display_name || "",
        username: user.username || "",
      },
      followers,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load synthetic follower status." });
  }
});

app.post("/admin/synthetic-metrics/followers", requireAuth, requireAdmin, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const count = parseSyntheticCount(req.body?.count);
    if (!email) return res.status(400).json({ message: "Email is required." });
    if (count == null) return res.status(400).json({ message: "Synthetic followers must be a valid number." });
    const [rows] = await pool.query(
      `SELECT id, email, display_name, username
       FROM users
       WHERE LOWER(email) = ?
         AND deleted_at IS NULL
       LIMIT 1`,
      [email]
    );
    const user = rows?.[0];
    if (!user?.id) return res.status(404).json({ message: "User not found." });
    const actor = getAdminActor(req);
    await setSyntheticMetricAdjustment({
      targetType: "user",
      targetId: Number(user.id),
      metric: "followers",
      count,
      actor,
    });
    await insertAdminAuditLog({
      ...actor,
      action: "set-synthetic-followers",
      targetType: "user",
      targetId: Number(user.id),
      details: { email: user.email || email, syntheticFollowers: count },
    });
    const followers = await getFollowerCountWithSynthetic(Number(user.id));
    return res.json({
      ok: true,
      user: {
        id: Number(user.id),
        email: user.email || "",
        displayName: user.display_name || "",
        username: user.username || "",
      },
      followers,
    });
  } catch (e) {
    console.error(e);
    return res.status(e?.statusCode || 500).json({ message: e?.message || "Failed to update synthetic followers." });
  }
});

app.post("/admin/synthetic-metrics/followers/undo", requireAuth, requireAdmin, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ message: "Email is required." });
    const [rows] = await pool.query(
      `SELECT id, email, display_name, username
       FROM users
       WHERE LOWER(email) = ?
         AND deleted_at IS NULL
       LIMIT 1`,
      [email]
    );
    const user = rows?.[0];
    if (!user?.id) return res.status(404).json({ message: "User not found." });
    const actor = getAdminActor(req);
    await setSyntheticMetricAdjustment({
      targetType: "user",
      targetId: Number(user.id),
      metric: "followers",
      count: 0,
      actor,
    });
    await insertAdminAuditLog({
      ...actor,
      action: "undo-synthetic-followers",
      targetType: "user",
      targetId: Number(user.id),
      details: { email: user.email || email },
    });
    const followers = await getFollowerCountWithSynthetic(Number(user.id));
    return res.json({
      ok: true,
      user: {
        id: Number(user.id),
        email: user.email || "",
        displayName: user.display_name || "",
        username: user.username || "",
      },
      followers,
    });
  } catch (e) {
    console.error(e);
    return res.status(e?.statusCode || 500).json({ message: e?.message || "Failed to undo synthetic followers." });
  }
});

app.get("/admin/synthetic-metrics/content", requireAuth, requireAdmin, async (req, res) => {
  try {
    const link = String(req.query?.link || "").trim();
    const contentId = await resolveContentIdFromAdminLink(link);
    if (!contentId) return res.status(400).json({ message: "Could not resolve content from that link." });
    const item = await getContentItemById(contentId);
    if (!item?.id) return res.status(404).json({ message: "Content not found." });
    const likes = await getContentMetricCountWithSynthetic(contentId, "likes");
    const views = await getContentMetricCountWithSynthetic(contentId, "views");
    return res.json({
      ok: true,
      item: {
        id: String(item.id),
        userId: String(item.user_id),
        kind: item.kind || "",
        title: item.title || "",
        status: item.status || "",
      },
      likes,
      views,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load synthetic content status." });
  }
});

app.post("/admin/synthetic-metrics/content", requireAuth, requireAdmin, async (req, res) => {
  try {
    const link = String(req.body?.link || "").trim();
    const metric = String(req.body?.metric || "").trim().toLowerCase();
    const count = parseSyntheticCount(req.body?.count);
    if (metric !== "likes" && metric !== "views") {
      return res.status(400).json({ message: "Metric must be likes or views." });
    }
    if (count == null) return res.status(400).json({ message: "Synthetic count must be a valid number." });
    const contentId = await resolveContentIdFromAdminLink(link);
    if (!contentId) return res.status(400).json({ message: "Could not resolve content from that link." });
    const item = await getContentItemById(contentId);
    if (!item?.id) return res.status(404).json({ message: "Content not found." });
    const actor = getAdminActor(req);
    await setSyntheticMetricAdjustment({
      targetType: "content",
      targetId: contentId,
      metric,
      count,
      actor,
    });
    await insertAdminAuditLog({
      ...actor,
      action: `set-synthetic-${metric}`,
      targetType: "content",
      targetId: contentId,
      details: { link, metric, syntheticCount: count },
    });
    const likes = await getContentMetricCountWithSynthetic(contentId, "likes");
    const views = await getContentMetricCountWithSynthetic(contentId, "views");
    return res.json({
      ok: true,
      item: {
        id: String(item.id),
        userId: String(item.user_id),
        kind: item.kind || "",
        title: item.title || "",
        status: item.status || "",
      },
      likes,
      views,
    });
  } catch (e) {
    console.error(e);
    return res.status(e?.statusCode || 500).json({ message: e?.message || "Failed to update synthetic content metric." });
  }
});

app.post("/admin/synthetic-metrics/content/undo", requireAuth, requireAdmin, async (req, res) => {
  try {
    const link = String(req.body?.link || "").trim();
    const metric = String(req.body?.metric || "").trim().toLowerCase();
    if (metric !== "likes" && metric !== "views") {
      return res.status(400).json({ message: "Metric must be likes or views." });
    }
    const contentId = await resolveContentIdFromAdminLink(link);
    if (!contentId) return res.status(400).json({ message: "Could not resolve content from that link." });
    const item = await getContentItemById(contentId);
    if (!item?.id) return res.status(404).json({ message: "Content not found." });
    const actor = getAdminActor(req);
    await setSyntheticMetricAdjustment({
      targetType: "content",
      targetId: contentId,
      metric,
      count: 0,
      actor,
    });
    await insertAdminAuditLog({
      ...actor,
      action: `undo-synthetic-${metric}`,
      targetType: "content",
      targetId: contentId,
      details: { link, metric },
    });
    const likes = await getContentMetricCountWithSynthetic(contentId, "likes");
    const views = await getContentMetricCountWithSynthetic(contentId, "views");
    return res.json({
      ok: true,
      item: {
        id: String(item.id),
        userId: String(item.user_id),
        kind: item.kind || "",
        title: item.title || "",
        status: item.status || "",
      },
      likes,
      views,
    });
  } catch (e) {
    console.error(e);
    return res.status(e?.statusCode || 500).json({ message: e?.message || "Failed to undo synthetic content metric." });
  }
});

app.get("/admin/blog/posts", requireAuth, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query?.page || 1));
    const limit = Math.min(100, Math.max(10, Number(req.query?.limit || 50)));
    const offset = (page - 1) * limit;
    const q = normalizeBlogText(req.query?.q, 160);
    const status = String(req.query?.status || "").trim().toLowerCase();
    const where = [];
    const params = [];
    if (status && ["draft", "published", "archived"].includes(status)) {
      where.push("status = ?");
      params.push(status);
    }
    if (q) {
      where.push("(title LIKE ? OR deck LIKE ? OR slug LIKE ? OR category LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM blog_posts ${whereSql}`,
      params
    );
    const [rows] = await pool.query(
      `SELECT *
       FROM blog_posts
       ${whereSql}
       ORDER BY updated_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return res.json({
      ok: true,
      total: Number(countRows?.[0]?.total || 0),
      page,
      limit,
      posts: (rows || []).map(serializeBlogPostRow),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load blog posts." });
  }
});

app.get("/admin/blog/posts/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid blog post id." });
    const [rows] = await pool.query(`SELECT * FROM blog_posts WHERE id = ? LIMIT 1`, [id]);
    if (!rows?.length) return res.status(404).json({ message: "Blog post not found." });
    return res.json({ ok: true, post: serializeBlogPostRow(rows[0]) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load blog post." });
  }
});

app.post("/admin/blog/posts", requireAuth, requireAdmin, async (req, res) => {
  try {
    const actorUserId = getAdminActorUserId(req);
    const auditActor = getAdminActor(req);
    const payload = normalizeBlogPayload(req.body || {});
    if (!payload.title) return res.status(400).json({ message: "Title is required." });
    if (!payload.deck) return res.status(400).json({ message: "Short description is required." });
    if (!payload.sections.length) {
      return res.status(400).json({ message: "At least one article section is required." });
    }
    const slug = await createUniqueBlogSlug({
      requestedSlug: payload.slug,
      title: payload.title,
    });
    const publishedAtSql = payload.status === "published" ? "NOW()" : "NULL";
    const [result] = await pool.query(
      `INSERT INTO blog_posts (
         slug, status, title, deck, category, tags_json, author_name,
         reviewer_name, hero_image_url, hero_alt, seo_title, seo_description,
         sections_json, tips_json, references_json, related_slugs_json,
         correction_note, created_by, updated_by, published_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${publishedAtSql})`,
      [
        slug,
        payload.status,
        payload.title,
        payload.deck,
        payload.category || null,
        JSON.stringify(payload.tags),
        payload.authorName || null,
        payload.reviewerName || null,
        payload.heroImageUrl || null,
        payload.heroAlt || null,
        payload.seoTitle || null,
        payload.seoDescription || null,
        JSON.stringify(payload.sections),
        JSON.stringify(payload.tips),
        JSON.stringify(payload.references),
        JSON.stringify(payload.relatedSlugs),
        payload.correctionNote || null,
        actorUserId || null,
        actorUserId || null,
      ]
    );
    const id = Number(result?.insertId || 0);
    await insertAdminAuditLog({
      ...auditActor,
      action: "create-blog-post",
      targetType: "blog_post",
      targetId: id,
      details: { status: payload.status, slug },
    });
    const [rows] = await pool.query(`SELECT * FROM blog_posts WHERE id = ? LIMIT 1`, [id]);
    return res.status(201).json({ ok: true, post: serializeBlogPostRow(rows[0]) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to create blog post." });
  }
});

app.put("/admin/blog/posts/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const actorUserId = getAdminActorUserId(req);
    const auditActor = getAdminActor(req);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid blog post id." });
    const [existingRows] = await pool.query(`SELECT id, status, published_at FROM blog_posts WHERE id = ? LIMIT 1`, [id]);
    if (!existingRows?.length) return res.status(404).json({ message: "Blog post not found." });
    const existing = existingRows[0];
    const payload = normalizeBlogPayload(req.body || {});
    if (!payload.title) return res.status(400).json({ message: "Title is required." });
    if (!payload.deck) return res.status(400).json({ message: "Short description is required." });
    if (!payload.sections.length) {
      return res.status(400).json({ message: "At least one article section is required." });
    }
    const slug = await createUniqueBlogSlug({
      requestedSlug: payload.slug,
      title: payload.title,
      existingId: id,
    });
    const wasPublished = String(existing.status || "").toLowerCase() === "published";
    const shouldPublishNow = payload.status === "published" && !existing.published_at;
    const publishedAtSql = shouldPublishNow
      ? "published_at = NOW(),"
      : payload.status !== "published"
        ? "published_at = NULL,"
        : "";
    await pool.query(
      `UPDATE blog_posts
       SET slug = ?,
           status = ?,
           title = ?,
           deck = ?,
           category = ?,
           tags_json = ?,
           author_name = ?,
           reviewer_name = ?,
           hero_image_url = ?,
           hero_alt = ?,
           seo_title = ?,
           seo_description = ?,
           sections_json = ?,
           tips_json = ?,
           references_json = ?,
           related_slugs_json = ?,
           correction_note = ?,
           updated_by = ?,
           ${publishedAtSql}
           updated_at = NOW()
       WHERE id = ?
       LIMIT 1`,
      [
        slug,
        payload.status,
        payload.title,
        payload.deck,
        payload.category || null,
        JSON.stringify(payload.tags),
        payload.authorName || null,
        payload.reviewerName || null,
        payload.heroImageUrl || null,
        payload.heroAlt || null,
        payload.seoTitle || null,
        payload.seoDescription || null,
        JSON.stringify(payload.sections),
        JSON.stringify(payload.tips),
        JSON.stringify(payload.references),
        JSON.stringify(payload.relatedSlugs),
        payload.correctionNote || null,
        actorUserId || null,
        id,
      ]
    );
    await insertAdminAuditLog({
      ...auditActor,
      action: "update-blog-post",
      targetType: "blog_post",
      targetId: id,
      details: { previousStatus: existing.status || "draft", nextStatus: payload.status, wasPublished, slug },
    });
    const [rows] = await pool.query(`SELECT * FROM blog_posts WHERE id = ? LIMIT 1`, [id]);
    return res.json({ ok: true, post: serializeBlogPostRow(rows[0]) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to update blog post." });
  }
});

app.delete("/admin/blog/posts/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const actorUserId = getAdminActorUserId(req);
    const auditActor = getAdminActor(req);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ message: "Invalid blog post id." });
    const [result] = await pool.query(
      `UPDATE blog_posts
       SET status = 'archived',
           published_at = NULL,
           updated_by = ?,
           updated_at = NOW()
       WHERE id = ?
       LIMIT 1`,
      [actorUserId || null, id]
    );
    if (!result?.affectedRows) return res.status(404).json({ message: "Blog post not found." });
    await insertAdminAuditLog({
      ...auditActor,
      action: "archive-blog-post",
      targetType: "blog_post",
      targetId: id,
    });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to archive blog post." });
  }
});

app.post("/admin/blog/upload-image", requireAuth, requireAdmin, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "Image file is required." });
    const mime = String(req.file.mimetype || "").toLowerCase();
    if (!mime.startsWith("image/")) {
      removeUploadByPublicUrl(`/uploads/${req.file.filename}`);
      return res.status(400).json({ message: "Only image uploads are allowed." });
    }
    const publicUrl = `/uploads/${req.file.filename}`;
    await insertAdminAuditLog({
      ...getAdminActor(req),
      action: "upload-blog-image",
      targetType: "blog_image",
      details: { publicUrl },
    });
    return res.json({ ok: true, url: publicUrl });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to upload blog image." });
  }
});

app.get("/blog/posts", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query?.page || 1));
    const limit = Math.min(50, Math.max(1, Number(req.query?.limit || 12)));
    const offset = (page - 1) * limit;
    const category = normalizeBlogText(req.query?.category, 80);
    const where = ["status = 'published'", "published_at IS NOT NULL"];
    const params = [];
    if (category) {
      where.push("category = ?");
      params.push(category);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;
    const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM blog_posts ${whereSql}`, params);
    const [rows] = await pool.query(
      `SELECT *
       FROM blog_posts
       ${whereSql}
       ORDER BY published_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return res.json({
      ok: true,
      total: Number(countRows?.[0]?.total || 0),
      page,
      limit,
      posts: (rows || []).map(serializeBlogPostRow),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load blog posts." });
  }
});

app.get("/blog/posts/:slug", async (req, res) => {
  try {
    const slug = normalizeBlogSlug(req.params.slug);
    if (!slug) return res.status(400).json({ message: "Invalid blog slug." });
    const [rows] = await pool.query(
      `SELECT *
       FROM blog_posts
       WHERE slug = ?
         AND status = 'published'
         AND published_at IS NOT NULL
       LIMIT 1`,
      [slug]
    );
    if (!rows?.length) return res.status(404).json({ message: "Blog post not found." });
    return res.json({ ok: true, post: serializeBlogPostRow(rows[0]) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load blog post." });
  }
});

app.get("/admin/reports", requireAuth, requireAdmin, async (req, res) => {
  try {
    const [userReportRows] = await pool.query(
      `SELECT
         ur.id,
         ur.reporter_id,
         ur.reported_user_id,
         ur.reason,
         ur.evidence_json,
         ur.created_at,
         reporter.display_name AS reporter_display_name,
         reporter.username AS reporter_username,
         reported.display_name AS reported_display_name,
         reported.username AS reported_username
       FROM user_reports ur
       LEFT JOIN users reporter ON reporter.id = ur.reporter_id
       LEFT JOIN users reported ON reported.id = ur.reported_user_id
       ORDER BY ur.created_at DESC
       LIMIT 100`
    );
    const [messageReportRows] = await pool.query(
      `SELECT
         mr.id,
         mr.reporter_id,
         mr.reported_user_id,
         mr.message_id,
         mr.reason,
         mr.created_at,
         reporter.display_name AS reporter_display_name,
         reporter.username AS reporter_username,
         reported.display_name AS reported_display_name,
         reported.username AS reported_username
       FROM direct_message_reports mr
       LEFT JOIN users reporter ON reporter.id = mr.reporter_id
       LEFT JOIN users reported ON reported.id = mr.reported_user_id
       ORDER BY mr.created_at DESC
      LIMIT 100`
    );
    const [anonymousReportRows] = await pool.query(
      `SELECT
         ar.id,
         ar.reporter_id,
         ar.reported_user_id,
         ar.match_id,
         ar.reason,
         ar.details,
         ar.evidence_json,
         ar.status,
         ar.admin_note,
         ar.reviewed_at,
         ar.created_at,
         reporter.display_name AS reporter_display_name,
         reporter.username AS reporter_username,
         reported.display_name AS reported_display_name,
         reported.username AS reported_username,
         reviewer.display_name AS reviewer_display_name,
         reviewer.username AS reviewer_username
       FROM anonymous_match_reports ar
       LEFT JOIN users reporter ON reporter.id = ar.reporter_id
       LEFT JOIN users reported ON reported.id = ar.reported_user_id
       LEFT JOIN users reviewer ON reviewer.id = ar.reviewed_by_admin_id
       ORDER BY CASE WHEN ar.status = 'open' THEN 0 ELSE 1 END,
                ar.created_at DESC
       LIMIT 100`
    );
    return res.json({
      ok: true,
      userReports: (userReportRows || []).map((row) => {
        let evidence = [];
        try {
          const parsed = JSON.parse(String(row.evidence_json || "[]"));
          evidence = Array.isArray(parsed) ? parsed : [];
        } catch (_) {}
        return {
          id: Number(row.id || 0),
          reporterId: Number(row.reporter_id || 0),
          reportedUserId: Number(row.reported_user_id || 0),
          reporterName: row.reporter_display_name || row.reporter_username || "",
          reportedName: row.reported_display_name || row.reported_username || "",
          reason: row.reason || "",
          evidence,
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        };
      }),
      messageReports: (messageReportRows || []).map((row) => ({
        id: Number(row.id || 0),
        reporterId: Number(row.reporter_id || 0),
        reportedUserId: Number(row.reported_user_id || 0),
        reporterName: row.reporter_display_name || row.reporter_username || "",
        reportedName: row.reported_display_name || row.reported_username || "",
        reason: row.reason || "",
        messageId: Number(row.message_id || 0),
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      })),
      anonymousReports: (anonymousReportRows || []).map((row) => {
        let evidence = [];
        try {
          const parsed = JSON.parse(String(row.evidence_json || "[]"));
          evidence = Array.isArray(parsed) ? parsed : [];
        } catch {}
        return {
          id: Number(row.id || 0),
          reporterId: Number(row.reporter_id || 0),
          reportedUserId: Number(row.reported_user_id || 0),
          reporterName: row.reporter_display_name || row.reporter_username || "",
          reportedName: row.reported_display_name || row.reported_username || "",
          matchId: row.match_id || "",
          reason: row.reason || "",
          details: row.details || "",
          evidence,
          status: row.status || "open",
          adminNote: row.admin_note || "",
          reviewedByName: row.reviewer_display_name || row.reviewer_username || "",
          reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        };
      }),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load reports." });
  }
});

app.patch("/admin/reports/anonymous/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const reportId = Number(req.params.id);
    const status = String(req.body?.status || "").trim().toLowerCase();
    const adminNote = String(req.body?.adminNote || "").trim().slice(0, 1000);
    const allowedStatuses = new Set(["open", "reviewing", "actioned", "dismissed"]);
    if (!reportId || !allowedStatuses.has(status)) {
      return res.status(400).json({ message: "Invalid anonymous report update." });
    }
    const reviewerId = getAdminActorUserId(req) || null;
    await pool.query(
      `UPDATE anonymous_match_reports
          SET status = ?,
              admin_note = ?,
              reviewed_by_admin_id = ?,
              reviewed_at = CURRENT_TIMESTAMP
        WHERE id = ?
        LIMIT 1`,
      [status, adminNote || null, reviewerId, reportId]
    );
    const actor = getAdminActor(req);
    await insertAdminAuditLog({
      ...actor,
      action: "review-anonymous-report",
      targetType: "anonymous_match_report",
      targetId: reportId,
      details: { status, adminNote },
    });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to update anonymous report." });
  }
});

app.get("/admin/live/broadcasts", requireAuth, requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, host_user_id, room_state, ended_at, created_at
       FROM live_broadcasts
       ORDER BY created_at DESC
       LIMIT 100`
    );
    const syntheticBroadcasts = listSyntheticLiveBroadcasts().map((room) => ({
      id: String(room.id || ""),
      hostId: 0,
      title: String(room.title || ""),
      host: String(room.host || ""),
      status: "synthetic",
      participants: Number(room.attendees || 0),
      createdAt: room.createdAt ? new Date(Number(room.createdAt)).toISOString() : null,
      synthetic: true,
      joinBlocked: room.joinBlocked === true,
    }));
    return res.json({
      ok: true,
      broadcasts: [
        ...syntheticBroadcasts,
        ...(rows || []).map((row) => {
        const roomState = parseJsonObject(row.room_state, {});
        const participants = Number(
          roomState?.participants ??
            roomState?.participantCount ??
            roomState?.listeners ??
            roomState?.viewerCount ??
            roomState?.audienceCount ??
            0
        );
        const status =
          row.ended_at != null
            ? "ended"
            : String(roomState?.status || roomState?.state || "live").toLowerCase();
        return {
          id: row.id != null ? String(row.id) : "",
          hostId: Number(row.host_user_id || 0),
          title: String(roomState?.title || roomState?.name || roomState?.topic || ""),
          host: String(roomState?.host || ""),
          status,
          participants,
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
          synthetic: false,
          joinBlocked: false,
        };
        }),
      ],
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load live broadcasts." });
  }
});

app.post("/admin/live/synthetic-broadcasts", requireAuth, requireAdmin, async (req, res) => {
  try {
    const audienceCount = Number(req.body?.audienceCount || 500000);
    if (!Number.isFinite(audienceCount) || audienceCount < 1 || audienceCount > 1000000) {
      return res.status(400).json({ message: "Audience count must be between 1 and 1,000,000." });
    }
    const broadcast = createSyntheticLiveBroadcast(io, {
      title: req.body?.title,
      description: req.body?.description,
      host: req.body?.host,
      hostPhotoUrl: req.body?.hostPhotoUrl,
      lang: req.body?.lang,
      lang2: req.body?.lang2,
      audienceCount,
    });
    await insertAdminAuditLog({
      ...getAdminActor(req),
      action: "create-synthetic-live-broadcast",
      targetType: "live_broadcast",
      targetId: broadcast.id,
      details: {
        title: broadcast.title,
        host: broadcast.host,
        hostPhotoUrl: broadcast.hostPhoto,
        audienceCount: broadcast.attendees,
        temporary: true,
      },
    });
    return res.status(201).json({ ok: true, broadcast });
  } catch (e) {
    console.error(e);
    return res.status(e?.statusCode || 500).json({
      message: e?.statusCode ? e.message : "Failed to create synthetic broadcast.",
    });
  }
});

app.delete("/admin/live/synthetic-broadcasts/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const broadcast = endSyntheticLiveBroadcast(io, req.params.id);
    if (!broadcast) {
      return res.status(404).json({ message: "Synthetic broadcast not found." });
    }
    await insertAdminAuditLog({
      ...getAdminActor(req),
      action: "end-synthetic-live-broadcast",
      targetType: "live_broadcast",
      targetId: broadcast.id,
      details: {
        title: broadcast.title,
        host: broadcast.host,
        temporary: true,
      },
    });
    return res.json({ ok: true, broadcast });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to end synthetic broadcast." });
  }
});

app.get("/admin/audit-log", requireAuth, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query?.page || 1));
    const limit = 50;
    const offset = (page - 1) * limit;
    const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM admin_audit_log`);
    const [rows] = await pool.query(
      `SELECT
         log.id,
         log.admin_id,
         log.admin_account_id,
         log.action,
         log.target_type,
         log.target_id,
         log.details,
         log.created_at,
         admin_user.display_name AS admin_display_name,
         admin_user.username AS admin_username,
         admin_account.display_name AS admin_account_display_name,
         admin_account.email AS admin_account_email
       FROM admin_audit_log log
       LEFT JOIN users admin_user ON admin_user.id = log.admin_id
       LEFT JOIN admin_accounts admin_account ON admin_account.id = log.admin_account_id
       ORDER BY log.created_at DESC, log.id DESC
       LIMIT ? OFFSET ?`,
      [limit, offset]
    );
    return res.json({
      ok: true,
      total: Number(countRows?.[0]?.total || 0),
      page,
      limit,
      entries: (rows || []).map((row) => {
        const details = parseJsonObject(row.details, {});
        return {
          id: Number(row.id || 0),
          adminId: Number(row.admin_id || row.admin_account_id || 0),
          adminName: row.admin_account_display_name || row.admin_account_email || row.admin_display_name || row.admin_username || "",
          action: row.action || "",
          targetUserId:
            String(row.target_type || "").toLowerCase() === "user" && row.target_id != null
              ? Number(row.target_id || 0)
              : null,
          note:
            typeof details?.note === "string" && details.note
              ? details.note
              : typeof details?.reason === "string" && details.reason
                ? details.reason
                : typeof details?.nextRole === "string"
                  ? `Role → ${details.nextRole}`
                  : "",
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        };
      }),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load audit log." });
  }
});

app.post("/admin/change-password", requireAuth, requireAdmin, async (req, res) => {
  try {
    const adminUserId = getAdminActorUserId(req);
    const adminAccountId = req.admin?.kind === "admin_account" ? Number(req.admin.id || 0) : 0;
    const auditActor = getAdminActor(req);
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");
    if ((!adminUserId && !adminAccountId) || !currentPassword || !newPassword) {
      return res.status(400).json({ message: "Current and new password are required." });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters." });
    }
    const table = adminAccountId ? "admin_accounts" : "users";
    const id = adminAccountId || adminUserId;
    const [rows] = await pool.query(
      `SELECT id, password_hash
       FROM ${table}
       WHERE id = ?
       LIMIT 1`,
      [id]
    );
    const adminUser = rows?.[0];
    if (!adminUser) {
      return res.status(404).json({ message: "Admin account not found." });
    }
    const matches = await bcrypt.compare(currentPassword, adminUser.password_hash);
    if (!matches) {
      return res.status(401).json({ message: "Current password is incorrect." });
    }
    const nextHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE ${table}
       SET password_hash = ?
       WHERE id = ?
       LIMIT 1`,
      [nextHash, id]
    );
    await insertAdminAuditLog({
      ...auditActor,
      action: "change-password",
      targetType: adminAccountId ? "admin_account" : "user",
      targetId: id,
      details: { note: "Changed admin dashboard password" },
    });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to change password." });
  }
});

//meet

app.get("/me", requireAuth, async (req, res) => {
  const userId = req.user.sub;

  const [rows] = await pool.query(
    `SELECT id, email, display_name, username,
            first_language, learn_language,
            city, country, country_code, from_country, profile_photo_url, cover_photo_urls_json, cover_photo_thumb_urls_json,
            relationship_status, relationship_status_visible,
            bio_text, bio_audio_url, bio_audio_duration,
            show_country, show_flag, show_age, show_follow_stats, show_online_status, receive_voice_calls, receive_video_calls,
            dob, gender,
            plan, role, trial_ends_at, pro_ends_at,
            trial_used,
            meet_languages_json
     FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [userId]
  );

  const u = rows?.[0];
  if (!u) return res.status(404).json({ message: "User not found" });

  const effective = computeEffectivePlan(u);
  const capability = await resolveUserVideoCapabilityById(userId);
  const postsCount = await countPublishedPostsForUser(userId);
  const followersCount = await getFollowerCountWithSynthetic(userId);
  const [[followingRow]] = await pool.query(
    `SELECT COUNT(*) AS count FROM follows WHERE follower_id = ?`,
    [userId]
  );
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
      sessionId: req.user?.sid || "",
      canPublishVideo: capability.canPublishVideo,
      trialUsed: Boolean(u.trial_used),
      trialEndsAt: u.trial_ends_at,
      proEndsAt: u.pro_ends_at,
      meetLanguages: meetLangs,
      city: u.city,
      country: u.country,
      countryCode: u.country_code,
      showCountry: Number(u.show_country || 0) === 1,
      showFlag: Number(u.show_flag || 0) === 1,
      showAge: Number(u.show_age || 0) === 1,
      showFollowStats: Number(u.show_follow_stats ?? 1) === 1,
      showOnlineStatus: Number(u.show_online_status ?? 1) === 1,
      receiveVoiceCalls: Number(u.receive_voice_calls ?? 1) === 1,
      receiveVideoCalls: Number(u.receive_video_calls ?? 1) === 1,
      nationalityCode: u.from_country,
      nationalityName: u.from_country,
      profilePhotoUrl: u.profile_photo_url,
      coverPhotoUrls: parseCoverPhotoUrls(u.cover_photo_urls_json),
      coverPhotoThumbUrls: parseCoverPhotoThumbUrls(u.cover_photo_thumb_urls_json),
      coverPhotosLocked: false,
      relationshipStatus: normalizeRelationshipStatus(u.relationship_status),
      relationshipStatusVisible: Number(u.relationship_status_visible || 0) === 1,
      bioText: u.bio_text || "",
      bioAudioUrl: u.bio_audio_url || "",
      bioAudioDuration: Number(u.bio_audio_duration || 0),
      dateOfBirth: u.dob ? new Date(u.dob).toISOString().split("T")[0] : "",
      age: computeAgeFromDob(u.dob),
      gender: u.gender || "",
      followersCount: followersCount.total,
      followingCount: Number(followingRow?.count || 0),
      postsCount,
      isFollowing: false,
    },
  });
});

app.get("/me/direct-call/rtc-config", requireAuth, async (req, res) => {
  return res.json({
    ok: true,
    ...buildDirectCallRtcConfig(),
  });
});

app.get("/me/direct-call/readiness", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.sub || 0);
    const rtc = buildDirectCallRtcConfig();
    const [rows] = await pool.query(
      `SELECT id, platform, push_provider, device_token, app_bundle, device_label, enabled,
              last_seen_at, last_verified_at, last_push_success_at, last_push_failure_at,
              last_push_error, consecutive_failures, created_at, updated_at
         FROM direct_call_devices
        WHERE user_id = ?
        ORDER BY updated_at DESC, id DESC`,
      [userId]
    );
    const devices = (rows || []).map(serializeDirectCallDevice);
    return res.json({
      ok: true,
      relayRequired: true,
      hasRelay: rtc.hasRelay,
      deviceSummary: summarizeDirectCallDevices(devices),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load direct call readiness." });
  }
});

app.get("/me/direct-call/sessions/current", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.sub || 0);
    const threadId = String(req.query?.threadId || "").trim();
    if (!threadId || !isDirectThreadMember(threadId, userId)) {
      return res.status(400).json({ message: "threadId is invalid." });
    }
    const [rows] = await pool.query(
      `SELECT call_id, thread_id, caller_id, callee_id, wants_video, state,
              session_version, initiated_at, answered_at, started_at, ended_at,
              ended_by_user_id, last_offer_at, last_answer_at, last_ice_at, updated_at
         FROM direct_call_sessions
        WHERE thread_id = ?
          AND (caller_id = ? OR callee_id = ?)
          AND state IN ('ringing', 'accepted', 'active')
        ORDER BY id DESC
        LIMIT 1`,
      [threadId, userId, userId]
    );
    const row = rows?.[0];
    return res.json({
      ok: true,
      session: row
        ? {
            callId: row.call_id,
            threadId: row.thread_id,
            callerId: String(row.caller_id),
            calleeId: String(row.callee_id),
            wantsVideo: Number(row.wants_video || 0) === 1,
            state: String(row.state || ""),
            sessionVersion: Number(row.session_version || 1),
            initiatedAt: row.initiated_at,
            answeredAt: row.answered_at,
            startedAt: row.started_at,
            endedAt: row.ended_at,
            endedByUserId: row.ended_by_user_id == null ? null : String(row.ended_by_user_id),
            lastOfferAt: row.last_offer_at,
            lastAnswerAt: row.last_answer_at,
            lastIceAt: row.last_ice_at,
            updatedAt: row.updated_at,
          }
        : null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load call session." });
  }
});

app.post("/me/direct-call/devices", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.sub || 0);
    const platform = String(req.body?.platform || "").trim().toLowerCase();
    const pushProvider = String(req.body?.pushProvider || "").trim().toLowerCase();
    const deviceToken = String(req.body?.deviceToken || "").trim();
    const appBundle = String(req.body?.appBundle || "").trim().slice(0, 160);
    const deviceLabel = String(req.body?.deviceLabel || "").trim().slice(0, 120);
    const enabled =
      req.body?.enabled === undefined
        ? true
        : req.body?.enabled === true ||
          req.body?.enabled === 1 ||
          String(req.body?.enabled || "").trim().toLowerCase() === "true";
    if (!["ios", "android"].includes(platform)) {
      return res.status(400).json({ message: "platform is invalid." });
    }
    if (!["voip_apns", "apns", "fcm"].includes(pushProvider)) {
      return res.status(400).json({ message: "pushProvider is invalid." });
    }
    if (!deviceToken) {
      return res.status(400).json({ message: "deviceToken is required." });
    }
    await pool.query(
      `INSERT INTO direct_call_devices
         (user_id, platform, push_provider, device_token, app_bundle, device_label, enabled, last_seen_at, last_verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         user_id = VALUES(user_id),
         platform = VALUES(platform),
         app_bundle = VALUES(app_bundle),
         device_label = VALUES(device_label),
         enabled = VALUES(enabled),
         last_seen_at = NOW(),
         last_verified_at = NOW()`,
      [userId, platform, pushProvider, deviceToken, appBundle || null, deviceLabel || null, enabled ? 1 : 0]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to register device." });
  }
});

function serializeDirectCallDevice(row) {
  const supportsBackgroundIncoming =
    Number(row.enabled || 0) === 1 &&
    supportsDirectCallBackgroundDevice(row);
  return {
    id: String(row.id),
    platform: row.platform,
    pushProvider: row.push_provider,
    appBundle: row.app_bundle || "",
    deviceLabel: row.device_label || "",
    enabled: Number(row.enabled || 0) === 1,
    supportsBackgroundIncoming,
    healthyForBackgroundIncoming: supportsBackgroundIncoming
      ? isHealthyDirectCallDevice(row)
      : false,
    consecutiveFailures: Number(row.consecutive_failures || 0),
    tokenSuffix: String(row.device_token || "").slice(-12),
    lastSeenAt: row.last_seen_at,
    lastVerifiedAt: row.last_verified_at,
    lastPushSuccessAt: row.last_push_success_at,
    lastPushFailureAt: row.last_push_failure_at,
    lastPushError: row.last_push_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pickLatestTimestamp(values) {
  let latestValue = null;
  let latestMs = -Infinity;
  for (const value of values) {
    if (!value) continue;
    const parsedMs = new Date(value).getTime();
    if (Number.isNaN(parsedMs) || parsedMs <= latestMs) continue;
    latestMs = parsedMs;
    latestValue = value;
  }
  return latestValue;
}

function summarizeDirectCallDevices(devices) {
  return {
    deviceCount: devices.length,
    enabledDeviceCount: devices.filter((device) => device.enabled).length,
    backgroundCallableDeviceCount: devices.filter(
      (device) => device.enabled && device.supportsBackgroundIncoming
    ).length,
    healthyBackgroundCallableDeviceCount: devices.filter(
      (device) => device.enabled && device.healthyForBackgroundIncoming
    ).length,
    failingDeviceCount: devices.filter(
      (device) =>
        device.consecutiveFailures > 0 ||
        (typeof device.lastPushError === "string" && device.lastPushError.trim().length > 0)
    ).length,
    latestSeenAt: pickLatestTimestamp(devices.map((device) => device.lastSeenAt)),
    latestVerifiedAt: pickLatestTimestamp(devices.map((device) => device.lastVerifiedAt)),
    latestPushSuccessAt: pickLatestTimestamp(
      devices.map((device) => device.lastPushSuccessAt)
    ),
    latestPushFailureAt: pickLatestTimestamp(
      devices.map((device) => device.lastPushFailureAt)
    ),
  };
}

app.get("/me/direct-call/devices", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.sub || 0);
    const [rows] = await pool.query(
      `SELECT id, platform, push_provider, device_token, app_bundle, device_label, enabled,
              last_seen_at, last_verified_at, last_push_success_at, last_push_failure_at,
              last_push_error, consecutive_failures, created_at, updated_at
         FROM direct_call_devices
        WHERE user_id = ?
        ORDER BY updated_at DESC, id DESC`,
      [userId]
    );
    return res.json({
      ok: true,
      devices: (rows || []).map(serializeDirectCallDevice),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load devices." });
  }
});

function boolFromRequest(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function serializeNotificationPreferences(row) {
  return {
    messagesEnabled: row ? Number(row.messages_enabled ?? 1) === 1 : true,
    messageSoundEnabled: row ? Number(row.message_sound_enabled ?? 1) === 1 : true,
    followersEnabled: row ? Number(row.followers_enabled ?? 1) === 1 : true,
    followerSoundEnabled: row ? Number(row.follower_sound_enabled ?? 1) === 1 : true,
  };
}

async function getNotificationPreferences(userId) {
  const [[row]] = await pool.query(
    `SELECT messages_enabled, message_sound_enabled, followers_enabled, follower_sound_enabled
       FROM notification_preferences
      WHERE user_id = ?
      LIMIT 1`,
    [Number(userId)]
  );
  return serializeNotificationPreferences(row);
}

function notificationTargetMetadata(row) {
  const type = String(row?.type || "system").trim().toLowerCase();
  const targetId = String(row?.target_id || "").trim();
  const fromUserId = row?.from_user_id == null ? "" : String(row.from_user_id);
  if (type === "new_follower" || type === "follow" || type === "follower") {
    return {
      targetType: "profile",
      route: fromUserId ? `/app/profile/${fromUserId}` : "",
    };
  }
  if (type === "direct_message" || type === "message" || type === "chat_message") {
    return {
      targetType: "direct_chat",
      route: fromUserId ? `/app/talk/${fromUserId}` : "",
    };
  }
  if (type === "live_broadcast" || type.includes("live")) {
    return {
      targetType: "live_room",
      route: targetId ? `/app/live?broadcastId=${encodeURIComponent(targetId)}` : "/app/live",
    };
  }
  if (type.startsWith("video_")) {
    return {
      targetType: "video",
      route: targetId ? `/app/content/videos/${targetId}` : "/app/content",
    };
  }
  if (type.startsWith("post_") || type.includes("content")) {
    return {
      targetType: "post",
      route: "/app/content",
    };
  }
  return { targetType: "", route: "" };
}

function serializeNotification(row) {
  const target = notificationTargetMetadata(row);
  return {
    id: String(row.id),
    type: String(row.type || "system"),
    title: String(row.title || ""),
    body: String(row.body || ""),
    fromUserId: row.from_user_id == null ? "" : String(row.from_user_id),
    fromDisplayName: String(row.from_display_name || ""),
    fromPhotoUrl: String(row.from_photo_url || ""),
    targetId: String(row.target_id || ""),
    targetType: target.targetType,
    route: target.route,
    isRead: Number(row.is_read || 0) === 1,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
  };
}

function normalizePemValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/\\n/g, "\n");
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function getGeneralApnsConfig() {
  const teamId = String(process.env.APNS_TEAM_ID || "").trim();
  const keyId = String(process.env.APNS_KEY_ID || "").trim();
  const privateKey = normalizePemValue(process.env.APNS_PRIVATE_KEY || "");
  const bundleId = String(
    process.env.APNS_ALERT_TOPIC ||
      process.env.APNS_BUNDLE_ID ||
      process.env.IOS_BUNDLE_ID ||
      "cc.talkflix.app"
  ).trim();
  if (!teamId || !keyId || !privateKey || !bundleId) return null;
  const env = String(process.env.APNS_ENV || "").trim().toLowerCase();
  const useSandbox =
    String(process.env.APNS_USE_SANDBOX || "").trim() === "1" ||
    env === "sandbox" ||
    env === "development";
  return {
    teamId,
    keyId,
    privateKey,
    bundleId,
    authority: useSandbox
      ? "https://api.sandbox.push.apple.com"
      : "https://api.push.apple.com",
  };
}

function createGeneralApnsJwtToken(config) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64UrlEncode(JSON.stringify({ iss: config.teamId, iat: issuedAt }));
  const unsigned = `${header}.${claims}`;
  const signer = crypto.createSign("sha256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${base64UrlEncode(signer.sign(config.privateKey))}`;
}

async function sendGeneralApnsPush(deviceToken, notification, preferences) {
  const config = getGeneralApnsConfig();
  if (!config) return { ok: false, skipped: true, error: "missing_apns_config" };
  const isMessage = String(notification.type || "").includes("message");
  const soundEnabled = isMessage
    ? preferences.messageSoundEnabled
    : preferences.followerSoundEnabled;
  const payload = {
    aps: {
      alert: {
        title: notification.title || "Talkflix",
        body: notification.body || "",
      },
      sound: soundEnabled ? "default" : undefined,
    },
    notificationId: String(notification.id || ""),
    type: String(notification.type || "system"),
    targetId: String(notification.targetId || ""),
    fromUserId: String(notification.fromUserId || ""),
  };
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const client = http2.connect(config.authority);
    client.on("error", (error) => {
      finish({ ok: false, error: error?.message || String(error) });
    });
    const request = client.request({
      ":method": "POST",
      ":path": `/3/device/${encodeURIComponent(String(deviceToken))}`,
      authorization: `bearer ${createGeneralApnsJwtToken(config)}`,
      "apns-topic": config.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    });
    let statusCode = 0;
    let responseBody = "";
    request.setEncoding("utf8");
    request.on("response", (headers) => {
      statusCode = Number(headers[":status"] || 0);
    });
    request.on("data", (chunk) => {
      responseBody += chunk;
    });
    request.on("error", (error) => {
      client.close();
      finish({ ok: false, error: error?.message || String(error) });
    });
    request.on("end", () => {
      client.close();
      let reason = "";
      try {
        reason = JSON.parse(responseBody || "{}")?.reason || "";
      } catch {}
      finish({
        ok: statusCode >= 200 && statusCode < 300,
        statusCode,
        reason,
        body: responseBody || "",
      });
    });
    request.end(JSON.stringify(payload));
  });
}

function getGeneralFcmConfig() {
  const serviceAccountJson = String(process.env.FCM_SERVICE_ACCOUNT_JSON || "").trim();
  if (serviceAccountJson) {
    try {
      const parsed = JSON.parse(serviceAccountJson);
      if (parsed.project_id && parsed.client_email && parsed.private_key) {
        return {
          projectId: String(parsed.project_id),
          clientEmail: String(parsed.client_email),
          privateKey: normalizePemValue(parsed.private_key),
        };
      }
    } catch (error) {
      console.error("[notifications] Failed to parse FCM_SERVICE_ACCOUNT_JSON", error);
    }
  }
  const projectId = String(process.env.FCM_PROJECT_ID || "").trim();
  const clientEmail = String(process.env.FCM_CLIENT_EMAIL || "").trim();
  const privateKey = normalizePemValue(process.env.FCM_PRIVATE_KEY || "");
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey };
}

let cachedGeneralFcmAccessToken = "";
let cachedGeneralFcmAccessTokenExpiresAt = 0;

async function getGeneralFcmAccessToken() {
  const config = getGeneralFcmConfig();
  if (!config) return null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    cachedGeneralFcmAccessToken &&
    cachedGeneralFcmAccessTokenExpiresAt - 60 > nowSeconds
  ) {
    return cachedGeneralFcmAccessToken;
  }
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64UrlEncode(
    JSON.stringify({
      iss: config.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    })
  );
  const unsigned = `${header}.${claims}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${base64UrlEncode(signer.sign(config.privateKey))}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.access_token) {
    throw new Error(
      payload?.error_description ||
        payload?.error ||
        `FCM auth failed with status ${response.status}`
    );
  }
  cachedGeneralFcmAccessToken = String(payload.access_token);
  cachedGeneralFcmAccessTokenExpiresAt = nowSeconds + Number(payload.expires_in || 3600);
  return cachedGeneralFcmAccessToken;
}

async function sendGeneralFcmPush(deviceToken, notification, preferences) {
  const config = getGeneralFcmConfig();
  if (!config) return { ok: false, skipped: true, error: "missing_fcm_config" };
  const accessToken = await getGeneralFcmAccessToken();
  const isMessage = String(notification.type || "").includes("message");
  const soundEnabled = isMessage
    ? preferences.messageSoundEnabled
    : preferences.followerSoundEnabled;
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token: String(deviceToken),
          notification: {
            title: notification.title || "Talkflix",
            body: notification.body || "",
          },
          data: {
            notificationId: String(notification.id || ""),
            type: String(notification.type || "system"),
            targetId: String(notification.targetId || ""),
            fromUserId: String(notification.fromUserId || ""),
          },
          android: {
            priority: "high",
            notification: {
              sound: soundEnabled ? "default" : undefined,
              channel_id: "talkflix_notifications",
            },
          },
          apns: {
            payload: {
              aps: {
                sound: soundEnabled ? "default" : undefined,
              },
            },
          },
        },
      }),
    }
  );
  const bodyText = await response.text();
  return {
    ok: response.ok,
    statusCode: response.status,
    body: bodyText,
    error: response.ok ? "" : bodyText || `FCM send failed with status ${response.status}`,
  };
}

async function updateNotificationDevicePushHealth(device, result) {
  if (!device?.id || result?.skipped === true) return;
  if (result?.ok === true) {
    await pool.query(
      `UPDATE notification_devices
          SET last_push_success_at = NOW(),
              last_push_error = NULL,
              consecutive_failures = 0
        WHERE id = ?`,
      [Number(device.id)]
    );
    return;
  }
  const errorMessage = String(
    result?.error || result?.reason || result?.body || "push_failed"
  )
    .trim()
    .slice(0, 512);
  await pool.query(
    `UPDATE notification_devices
        SET last_push_failure_at = NOW(),
            last_push_error = ?,
            consecutive_failures = COALESCE(consecutive_failures, 0) + 1
      WHERE id = ?`,
    [errorMessage || "push_failed", Number(device.id)]
  );
}

async function fetchNotificationDevices(userId) {
  const [rows] = await pool.query(
    `SELECT id, user_id, platform, push_provider, device_token, app_bundle, enabled,
            last_push_failure_at, consecutive_failures
       FROM notification_devices
      WHERE user_id = ?
        AND enabled = 1`,
    [Number(userId)]
  );
  return rows || [];
}

async function sendNotificationPushes(userId, notification, preferences) {
  const devices = await fetchNotificationDevices(userId);
  for (const device of devices) {
    const provider = String(device.push_provider || "").trim().toLowerCase();
    let result = { ok: false, skipped: true, error: "unsupported_provider" };
    try {
      if (provider === "apns") {
        result = await sendGeneralApnsPush(device.device_token, notification, preferences);
      } else if (provider === "fcm") {
        result = await sendGeneralFcmPush(device.device_token, notification, preferences);
      }
    } catch (error) {
      result = { ok: false, error: error?.message || String(error) };
    }
    void updateNotificationDevicePushHealth(device, result).catch((error) => {
      console.error("[notifications] Failed to update device push health", error);
    });
  }
}

async function createUserNotification({
  userId,
  type,
  title,
  body,
  fromUserId = null,
  fromDisplayName = "",
  fromPhotoUrl = "",
  targetId = "",
}) {
  const preferences = await getNotificationPreferences(userId);
  const normalizedType = String(type || "system").trim().toLowerCase();
  if (normalizedType.includes("message") && !preferences.messagesEnabled) return null;
  if (
    (normalizedType === "follow" ||
      normalizedType === "follower" ||
      normalizedType === "new_follower") &&
    !preferences.followersEnabled
  ) {
    return null;
  }
  const [result] = await pool.query(
    `INSERT INTO notifications
       (user_id, type, title, body, from_user_id, from_display_name, from_photo_url, target_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(userId),
      normalizedType,
      String(title || "Talkflix").slice(0, 220),
      String(body || "").slice(0, 2000),
      fromUserId == null ? null : Number(fromUserId),
      String(fromDisplayName || "").slice(0, 160),
      fromPhotoUrl || null,
      String(targetId || "").slice(0, 255),
    ]
  );
  const [[row]] = await pool.query(
    `SELECT id, user_id, type, title, body, from_user_id, from_display_name,
            from_photo_url, target_id, is_read, created_at
       FROM notifications
      WHERE id = ?
      LIMIT 1`,
    [result.insertId]
  );
  const notification = serializeNotification(row);
  if (io) io.to(`user:${userId}`).emit("notification:new", notification);
  void sendNotificationPushes(userId, notification, preferences).catch((error) => {
    console.error("[notifications] Failed to send push", error);
  });
  return notification;
}

async function loadNotificationActor(userId) {
  const [[row]] = await pool.query(
    `SELECT id, display_name, profile_photo_url
       FROM users
      WHERE id = ?
      LIMIT 1`,
    [Number(userId)]
  );
  if (!row) {
    return {
      id: String(userId || ""),
      displayName: "Talkflix user",
      profilePhotoUrl: "",
    };
  }
  return {
    id: String(row.id),
    displayName: String(row.display_name || "Talkflix user"),
    profilePhotoUrl: String(row.profile_photo_url || ""),
  };
}

function contentNotificationKind(item) {
  return String(item?.kind || "").trim().toLowerCase() === "video" ? "video" : "post";
}

function contentNotificationLabel(item) {
  return contentNotificationKind(item) === "video" ? "video" : "post";
}

app.get("/me/notifications", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.sub || 0);
    const parsedLimit = Number(req.query?.limit || 50);
    const limit = Math.min(Math.max(Number.isFinite(parsedLimit) ? Math.trunc(parsedLimit) : 50, 1), 100);
    const [rows] = await pool.query(
      `SELECT id, user_id, type, title, body, from_user_id, from_display_name,
              from_photo_url, target_id, is_read, created_at
         FROM notifications
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      [userId, limit]
    );
    return res.json({ ok: true, notifications: (rows || []).map(serializeNotification) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load notifications." });
  }
});

app.get("/me/notifications/unread-count", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.sub || 0);
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS count
         FROM notifications
        WHERE user_id = ?
          AND is_read = 0`,
      [userId]
    );
    return res.json({ ok: true, count: Number(row?.count || 0) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load unread count." });
  }
});

app.patch("/me/notifications/read-all", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.sub || 0);
    await pool.query(
      `UPDATE notifications
          SET is_read = 1, read_at = COALESCE(read_at, NOW())
        WHERE user_id = ? AND is_read = 0`,
      [userId]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to mark notifications read." });
  }
});

app.patch("/me/notifications/:id/read", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.sub || 0);
    const notificationId = Number(req.params.id);
    if (!notificationId) return res.status(400).json({ message: "Invalid notification." });
    const [result] = await pool.query(
      `UPDATE notifications
          SET is_read = 1, read_at = COALESCE(read_at, NOW())
        WHERE id = ? AND user_id = ?`,
      [notificationId, userId]
    );
    if (Number(result?.affectedRows || 0) === 0) {
      return res.status(404).json({ message: "Notification not found." });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to mark notification read." });
  }
});

app.get("/me/notification-preferences", requireAuth, async (req, res) => {
  try {
    const preferences = await getNotificationPreferences(Number(req.user?.sub || 0));
    return res.json({ ok: true, preferences });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load notification preferences." });
  }
});

app.patch("/me/notification-preferences", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.sub || 0);
    const current = await getNotificationPreferences(userId);
    const next = {
      messagesEnabled: boolFromRequest(req.body?.messagesEnabled, current.messagesEnabled),
      messageSoundEnabled: boolFromRequest(
        req.body?.messageSoundEnabled,
        current.messageSoundEnabled
      ),
      followersEnabled: boolFromRequest(req.body?.followersEnabled, current.followersEnabled),
      followerSoundEnabled: boolFromRequest(
        req.body?.followerSoundEnabled,
        current.followerSoundEnabled
      ),
    };
    if (!next.messagesEnabled) next.messageSoundEnabled = false;
    if (!next.followersEnabled) next.followerSoundEnabled = false;
    await pool.query(
      `INSERT INTO notification_preferences
         (user_id, messages_enabled, message_sound_enabled, followers_enabled, follower_sound_enabled)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         messages_enabled = VALUES(messages_enabled),
         message_sound_enabled = VALUES(message_sound_enabled),
         followers_enabled = VALUES(followers_enabled),
         follower_sound_enabled = VALUES(follower_sound_enabled),
         updated_at = CURRENT_TIMESTAMP`,
      [
        userId,
        next.messagesEnabled ? 1 : 0,
        next.messageSoundEnabled ? 1 : 0,
        next.followersEnabled ? 1 : 0,
        next.followerSoundEnabled ? 1 : 0,
      ]
    );
    return res.json({ ok: true, preferences: next });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to save notification preferences." });
  }
});

app.post("/me/notification-devices", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.sub || 0);
    const platform = String(req.body?.platform || "").trim().toLowerCase();
    const pushProvider = String(req.body?.pushProvider || "").trim().toLowerCase();
    const deviceToken = String(req.body?.deviceToken || "").trim();
    const appBundle = String(req.body?.appBundle || "").trim().slice(0, 160);
    const deviceLabel = String(req.body?.deviceLabel || "").trim().slice(0, 120);
    const enabled = boolFromRequest(req.body?.enabled, true);
    if (!["ios", "android"].includes(platform)) {
      return res.status(400).json({ message: "platform is invalid." });
    }
    if (!["apns", "fcm"].includes(pushProvider)) {
      return res.status(400).json({ message: "pushProvider is invalid." });
    }
    if (!deviceToken) {
      return res.status(400).json({ message: "deviceToken is required." });
    }
    await pool.query(
      `INSERT INTO notification_devices
         (user_id, platform, push_provider, device_token, app_bundle, device_label, enabled, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE
         user_id = VALUES(user_id),
         platform = VALUES(platform),
         app_bundle = VALUES(app_bundle),
         device_label = VALUES(device_label),
         enabled = VALUES(enabled),
         last_seen_at = NOW(),
         updated_at = CURRENT_TIMESTAMP`,
      [userId, platform, pushProvider, deviceToken, appBundle || null, deviceLabel || null, enabled ? 1 : 0]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to register notification device." });
  }
});

async function readDirectCallPermissionState(ownerUserId, peerUserId) {
  const [[user]] = await pool.query(
    `SELECT receive_voice_calls, receive_video_calls
       FROM users
      WHERE id = ?
      LIMIT 1`,
    [Number(ownerUserId)]
  );
  if (!user) return null;
  const [[permission]] = await pool.query(
    `SELECT allow_voice_calls, allow_video_calls
       FROM direct_call_permissions
      WHERE owner_user_id = ?
        AND peer_user_id = ?
      LIMIT 1`,
    [Number(ownerUserId), Number(peerUserId)]
  );
  const globalReceiveVoiceCalls = Number(user.receive_voice_calls ?? 1) === 1;
  const globalReceiveVideoCalls = Number(user.receive_video_calls ?? 1) === 1;
  const rawReceiveVoiceCalls =
    permission?.allow_voice_calls == null
      ? null
      : Number(permission.allow_voice_calls) === 1;
  const rawReceiveVideoCalls =
    permission?.allow_video_calls == null
      ? null
      : Number(permission.allow_video_calls) === 1;
  return {
    receiveVoiceCalls:
      rawReceiveVoiceCalls == null
        ? globalReceiveVoiceCalls
        : rawReceiveVoiceCalls,
    receiveVideoCalls:
      rawReceiveVideoCalls == null
        ? globalReceiveVideoCalls
        : rawReceiveVideoCalls,
    globalReceiveVoiceCalls,
    globalReceiveVideoCalls,
    voiceOverrideSet: rawReceiveVoiceCalls != null,
    videoOverrideSet: rawReceiveVideoCalls != null,
  };
}

app.get("/users/:id/direct-call-permissions", requireAuth, async (req, res) => {
  try {
    const ownerUserId = Number(req.user?.sub || 0);
    const peerUserId = Number(req.params?.id || 0);
    if (!ownerUserId || !peerUserId || ownerUserId === peerUserId) {
      return res.status(400).json({ message: "User id is invalid." });
    }
    const [[peerUser]] = await pool.query(
      `SELECT id FROM users WHERE id = ? LIMIT 1`,
      [peerUserId]
    );
    if (!peerUser) {
      return res.status(404).json({ message: "User not found." });
    }
    const permissions = await readDirectCallPermissionState(ownerUserId, peerUserId);
    if (!permissions) {
      return res.status(404).json({ message: "User not found." });
    }
    return res.json({ ok: true, ...permissions });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load direct call permissions." });
  }
});

app.patch("/users/:id/direct-call-permissions", requireAuth, async (req, res) => {
  try {
    const ownerUserId = Number(req.user?.sub || 0);
    const peerUserId = Number(req.params?.id || 0);
    if (!ownerUserId || !peerUserId || ownerUserId === peerUserId) {
      return res.status(400).json({ message: "User id is invalid." });
    }
    const [[peerUser]] = await pool.query(
      `SELECT id FROM users WHERE id = ? LIMIT 1`,
      [peerUserId]
    );
    if (!peerUser) {
      return res.status(404).json({ message: "User not found." });
    }

    const voiceProvided = Object.prototype.hasOwnProperty.call(
      req.body || {},
      "receiveVoiceCalls"
    );
    const videoProvided = Object.prototype.hasOwnProperty.call(
      req.body || {},
      "receiveVideoCalls"
    );
    if (!voiceProvided && !videoProvided) {
      return res.status(400).json({ message: "No direct call permission changes were provided." });
    }

    const current = await readDirectCallPermissionState(ownerUserId, peerUserId);
    if (!current) {
      return res.status(404).json({ message: "User not found." });
    }
    const [[existingPermission]] = await pool.query(
      `SELECT allow_voice_calls, allow_video_calls
         FROM direct_call_permissions
        WHERE owner_user_id = ?
          AND peer_user_id = ?
        LIMIT 1`,
      [ownerUserId, peerUserId]
    );

    const receiveVoiceCalls = voiceProvided
      ? req.body?.receiveVoiceCalls === true ||
        req.body?.receiveVoiceCalls === 1 ||
        String(req.body?.receiveVoiceCalls || "").trim().toLowerCase() === "true"
      : existingPermission?.allow_voice_calls == null
      ? null
      : Number(existingPermission.allow_voice_calls) === 1;
    const receiveVideoCalls = videoProvided
      ? req.body?.receiveVideoCalls === true ||
        req.body?.receiveVideoCalls === 1 ||
        String(req.body?.receiveVideoCalls || "").trim().toLowerCase() === "true"
      : existingPermission?.allow_video_calls == null
      ? null
      : Number(existingPermission.allow_video_calls) === 1;

    await pool.query(
      `INSERT INTO direct_call_permissions
         (owner_user_id, peer_user_id, allow_voice_calls, allow_video_calls)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         allow_voice_calls = VALUES(allow_voice_calls),
         allow_video_calls = VALUES(allow_video_calls)`,
      [
        ownerUserId,
        peerUserId,
        receiveVoiceCalls == null ? null : receiveVoiceCalls ? 1 : 0,
        receiveVideoCalls == null ? null : receiveVideoCalls ? 1 : 0,
      ]
    );

    const permissions = await readDirectCallPermissionState(ownerUserId, peerUserId);
    return res.json({ ok: true, ...permissions });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to update direct call permissions." });
  }
});

app.patch("/me/relationship-status", requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const requestedVisible =
      req.body?.relationshipStatusVisible === true ||
      req.body?.relationshipStatusVisible === 1 ||
      String(req.body?.relationshipStatusVisible || "").trim().toLowerCase() === "true";
    const providedStatus = Object.prototype.hasOwnProperty.call(
      req.body || {},
      "relationshipStatus"
    );
    const requestedStatus = normalizeRelationshipStatus(req.body?.relationshipStatus);

    if (providedStatus && !requestedStatus && String(req.body?.relationshipStatus || "").trim().length > 0) {
      return res.status(400).json({ message: "Relationship status is invalid." });
    }

    const [rows] = await pool.query(
      `SELECT id, relationship_status
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [userId]
    );
    const user = rows?.[0];
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const currentStatus = normalizeRelationshipStatus(user.relationship_status);
    const finalStatus = requestedStatus || currentStatus;

    if (requestedVisible && !finalStatus) {
      return res.status(400).json({ message: "Select a relationship status first." });
    }

    await pool.query(
      `UPDATE users
       SET relationship_status = ?, relationship_status_visible = ?
       WHERE id = ?
       LIMIT 1`,
      [finalStatus || null, requestedVisible ? 1 : 0, userId]
    );

    return res.json({
      ok: true,
      relationshipStatus: finalStatus,
      relationshipStatusVisible: requestedVisible,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to update relationship status." });
  }
});

app.patch("/me/privacy", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const updates = [];
    const values = [];

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "showAge")) {
      const showAge =
        req.body?.showAge === true ||
        req.body?.showAge === 1 ||
        String(req.body?.showAge || "").trim().toLowerCase() === "true";
      updates.push("show_age = ?");
      values.push(showAge ? 1 : 0);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "showCountry")) {
      const showCountry =
        req.body?.showCountry === true ||
        req.body?.showCountry === 1 ||
        String(req.body?.showCountry || "").trim().toLowerCase() === "true";
      updates.push("show_country = ?");
      values.push(showCountry ? 1 : 0);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "showFlag")) {
      const showFlag =
        req.body?.showFlag === true ||
        req.body?.showFlag === 1 ||
        String(req.body?.showFlag || "").trim().toLowerCase() === "true";
      updates.push("show_flag = ?");
      values.push(showFlag ? 1 : 0);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "showFollowStats")) {
      const showFollowStats =
        req.body?.showFollowStats === true ||
        req.body?.showFollowStats === 1 ||
        String(req.body?.showFollowStats || "").trim().toLowerCase() === "true";
      updates.push("show_follow_stats = ?");
      values.push(showFollowStats ? 1 : 0);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "showOnlineStatus")) {
      const showOnlineStatus =
        req.body?.showOnlineStatus === true ||
        req.body?.showOnlineStatus === 1 ||
        String(req.body?.showOnlineStatus || "").trim().toLowerCase() === "true";
      updates.push("show_online_status = ?");
      values.push(showOnlineStatus ? 1 : 0);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "receiveVoiceCalls")) {
      const receiveVoiceCalls =
        req.body?.receiveVoiceCalls === true ||
        req.body?.receiveVoiceCalls === 1 ||
        String(req.body?.receiveVoiceCalls || "").trim().toLowerCase() === "true";
      updates.push("receive_voice_calls = ?");
      values.push(receiveVoiceCalls ? 1 : 0);
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "receiveVideoCalls")) {
      const receiveVideoCalls =
        req.body?.receiveVideoCalls === true ||
        req.body?.receiveVideoCalls === 1 ||
        String(req.body?.receiveVideoCalls || "").trim().toLowerCase() === "true";
      updates.push("receive_video_calls = ?");
      values.push(receiveVideoCalls ? 1 : 0);
    }

    if (updates.length === 0) {
      return res.status(400).json({ message: "No privacy changes were provided." });
    }

    values.push(userId);
    await pool.query(
      `UPDATE users
       SET ${updates.join(", ")}
       WHERE id = ?
         AND deleted_at IS NULL
       LIMIT 1`,
      values
    );

    const [rows] = await pool.query(
      `SELECT show_country, show_flag, show_age, show_follow_stats, show_online_status, receive_voice_calls, receive_video_calls
       FROM users
       WHERE id = ?
         AND deleted_at IS NULL
       LIMIT 1`,
      [userId]
    );
    const user = rows?.[0];
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    return res.json({
      ok: true,
      showCountry: Number(user.show_country || 0) === 1,
      showFlag: Number(user.show_flag || 0) === 1,
      showAge: Number(user.show_age || 0) === 1,
      showFollowStats: Number(user.show_follow_stats ?? 1) === 1,
      showOnlineStatus: Number(user.show_online_status ?? 1) === 1,
      receiveVoiceCalls: Number(user.receive_voice_calls ?? 1) === 1,
      receiveVideoCalls: Number(user.receive_video_calls ?? 1) === 1,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to update privacy." });
  }
});

app.post("/me/change-password", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");
    if (!userId || !currentPassword || !newPassword) {
      return res.status(400).json({ message: "Current and new password are required." });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters." });
    }
    const [rows] = await pool.query(
      `SELECT id, password_hash
       FROM users
       WHERE id = ?
         AND deleted_at IS NULL
       LIMIT 1`,
      [userId]
    );
    const user = rows?.[0];
    if (!user) return res.status(404).json({ message: "User not found." });
    const matches = await bcrypt.compare(currentPassword, user.password_hash || "");
    if (!matches) {
      return res.status(401).json({ message: "Current password is incorrect." });
    }
    const nextHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE users
       SET password_hash = ?
       WHERE id = ?
       LIMIT 1`,
      [nextHash, userId]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to change password." });
  }
});

app.post("/me/change-email", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const newEmail = String(req.body?.newEmail || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!userId || !newEmail || !password) {
      return res.status(400).json({ message: "New email and password are required." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return res.status(400).json({ message: "Enter a valid email address." });
    }
    const [rows] = await pool.query(
      `SELECT id, email, password_hash
       FROM users
       WHERE id = ?
         AND deleted_at IS NULL
       LIMIT 1`,
      [userId]
    );
    const user = rows?.[0];
    if (!user) return res.status(404).json({ message: "User not found." });
    const matches = await bcrypt.compare(password, user.password_hash || "");
    if (!matches) {
      return res.status(401).json({ message: "Password is incorrect." });
    }
    if (String(user.email || "").toLowerCase() === newEmail) {
      return res.json({ ok: true, email: newEmail });
    }
    const [existingRows] = await pool.query(
      `SELECT id
       FROM users
       WHERE email = ?
         AND id <> ?
         AND deleted_at IS NULL
       LIMIT 1`,
      [newEmail, userId]
    );
    if (existingRows?.length) {
      return res.status(409).json({ message: "That email is already in use." });
    }
    await pool.query(
      `UPDATE users
       SET email = ?
       WHERE id = ?
       LIMIT 1`,
      [newEmail, userId]
    );
    return res.json({ ok: true, email: newEmail });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to change email." });
  }
});

app.delete("/me", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const password = String(req.body?.password || "");
    if (!userId || !password) {
      return res.status(400).json({ message: "Password is required to delete your account." });
    }
    const [rows] = await pool.query(
      `SELECT id, password_hash
       FROM users
       WHERE id = ?
         AND deleted_at IS NULL
       LIMIT 1`,
      [userId]
    );
    const user = rows?.[0];
    if (!user) return res.status(404).json({ message: "User not found." });
    const matches = await bcrypt.compare(password, user.password_hash || "");
    if (!matches) {
      return res.status(401).json({ message: "Password is incorrect." });
    }
    const suffix = `${userId}_${Date.now()}`;
    const randomPasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
    await pool.query(
      `UPDATE users
       SET email = ?,
           username = ?,
           password_hash = ?,
           display_name = 'Deleted user',
           profile_photo_url = NULL,
           cover_photo_urls_json = NULL,
           cover_photo_thumb_urls_json = NULL,
           bio_text = NULL,
           bio_audio_url = NULL,
           bio_audio_duration = NULL,
           relationship_status = NULL,
           relationship_status_visible = 0,
           show_country = 0,
           show_flag = 0,
           show_age = 0,
           show_follow_stats = 0,
           show_online_status = 0,
           receive_voice_calls = 0,
           receive_video_calls = 0,
           deleted_at = NOW()
       WHERE id = ?
       LIMIT 1`,
      [`deleted+${suffix}@deleted.talkflix.local`, `deleted_user_${suffix}`, randomPasswordHash, userId]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to delete account." });
  }
});

app.post(
  "/me/cover-photos/upload",
  requireAuth,
  postMediaUpload.single("coverPhoto"),
  async (req, res) => {
    try {
      const userId = req.user.sub;
      if (!req.file) {
        return res.status(400).json({ message: "Attach a cover photo image to upload." });
      }
      const mimeType = String(req.file.mimetype || "").toLowerCase();
      if (!mimeType.startsWith("image/")) {
        return res.status(400).json({ message: "Cover photos must be image files." });
      }
      const slot = Number(req.body?.slot);
      if (!Number.isInteger(slot) || slot < 0 || slot > 1) {
        return res.status(400).json({ message: "Cover photo slot must be 0 or 1." });
      }

      const [rows] = await pool.query(
        `SELECT id, cover_photo_urls_json, cover_photo_thumb_urls_json, plan, role, trial_ends_at, pro_ends_at
         FROM users
         WHERE id = ?
         LIMIT 1`,
        [userId]
      );
      const user = rows?.[0];
      if (!user) return res.status(404).json({ message: "User not found" });
      const effective = computeEffectivePlan(user);
      const canManageCovers =
        effective.role === "admin" ||
        effective.plan === "pro" ||
        effective.plan === "trial";
      if (!canManageCovers) {
        return res.status(403).json({
          code: "PRO_REQUIRED",
          message: "Talkflix Pro is required to manage cover photos.",
        });
      }

      const current = parseCoverPhotoUrls(user.cover_photo_urls_json);
      const currentThumbs = parseCoverPhotoThumbUrls(user.cover_photo_thumb_urls_json);
      if (slot > current.length) {
        return res.status(400).json({ message: "Fill the first cover photo slot before adding the second one." });
      }

      const publicUrl = `/uploads/${req.file.filename}`;
      const thumbPublicUrl = await generateCoverPhotoThumbnail(req.file);
      const next = [...current];
      const nextThumbs = [...currentThumbs];
      const previousUrl = slot < current.length ? current[slot] : "";
      const previousThumbUrl = slot < currentThumbs.length ? currentThumbs[slot] : "";
      if (slot === next.length) {
        next.push(publicUrl);
        nextThumbs.push(thumbPublicUrl);
      } else {
        next[slot] = publicUrl;
        nextThumbs[slot] = thumbPublicUrl;
      }

      await pool.query(
        `UPDATE users
         SET cover_photo_urls_json = ?, cover_photo_thumb_urls_json = ?
         WHERE id = ?
         LIMIT 1`,
        [serializeCoverPhotoUrls(next), serializeCoverPhotoThumbUrls(nextThumbs), userId]
      );

      if (previousUrl) removeUploadByPublicUrl(previousUrl);
      if (previousThumbUrl) removeUploadByPublicUrl(previousThumbUrl);

      return res.json({
        ok: true,
        coverPhotoUrls: next,
        coverPhotoThumbUrls: nextThumbs,
        coverPhotosLocked: false,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: "Failed to upload cover photo." });
    }
  }
);

app.delete("/me/cover-photos/:slot", requireAuth, async (req, res) => {
  try {
    const userId = req.user.sub;
    const slot = Number(req.params.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot > 1) {
      return res.status(400).json({ message: "Cover photo slot must be 0 or 1." });
    }

    const [rows] = await pool.query(
      `SELECT id, cover_photo_urls_json, cover_photo_thumb_urls_json, plan, role, trial_ends_at, pro_ends_at
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [userId]
    );
    const user = rows?.[0];
    if (!user) return res.status(404).json({ message: "User not found" });
    const effective = computeEffectivePlan(user);
    const canManageCovers =
      effective.role === "admin" ||
      effective.plan === "pro" ||
      effective.plan === "trial";
    if (!canManageCovers) {
      return res.status(403).json({
        code: "PRO_REQUIRED",
        message: "Talkflix Pro is required to manage cover photos.",
      });
    }

    const current = parseCoverPhotoUrls(user.cover_photo_urls_json);
    const currentThumbs = parseCoverPhotoThumbUrls(user.cover_photo_thumb_urls_json);
    if (slot >= current.length) {
      return res.status(404).json({ message: "Cover photo slot is empty." });
    }

    const removedUrl = current[slot] || "";
    const removedThumbUrl = currentThumbs[slot] || "";
    const next = current.filter((_, index) => index !== slot);
    const nextThumbs = currentThumbs.filter((_, index) => index !== slot);
    await pool.query(
      `UPDATE users
       SET cover_photo_urls_json = ?, cover_photo_thumb_urls_json = ?
       WHERE id = ?
       LIMIT 1`,
      [serializeCoverPhotoUrls(next), serializeCoverPhotoThumbUrls(nextThumbs), userId]
    );

    if (removedUrl) removeUploadByPublicUrl(removedUrl);
    if (removedThumbUrl) removeUploadByPublicUrl(removedThumbUrl);

    return res.json({
      ok: true,
      coverPhotoUrls: next,
      coverPhotoThumbUrls: nextThumbs,
      coverPhotosLocked: false,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to remove cover photo." });
  }
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

const openAiTranslationModel =
  String(process.env.OPENAI_TRANSLATION_MODEL || "gpt-5-mini").trim() ||
  "gpt-5-mini";

function isOpenAiTranslationEnabled() {
  return String(process.env.OPENAI_API_KEY || "").trim().length > 0;
}

function extractResponseOutputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const parts = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const contentPart of item.content) {
      if (
        contentPart?.type === "output_text" &&
        typeof contentPart.text === "string" &&
        contentPart.text.trim()
      ) {
        parts.push(contentPart.text.trim());
      }
    }
  }
  return parts.join("\n").trim();
}

async function translateTextWithOpenAi({
  text,
  targetLanguage,
  sourceLanguage = "auto",
  context = "general",
}) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Translation service is not configured.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: openAiTranslationModel,
        instructions:
          "You are a translation engine. Translate the user's text into the target language. Return only the translated text. Preserve tone, meaning, punctuation, emojis, and line breaks. Do not explain your answer.",
        input: `Context: ${context}\nSource language: ${sourceLanguage}\nTarget language: ${targetLanguage}\nText:\n${text}`,
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    const payload = raw ? JSON.parse(raw) : {};
    if (!response.ok) {
      const message =
        payload?.error?.message ||
        payload?.message ||
        `OpenAI translation request failed with status ${response.status}.`;
      throw new Error(message);
    }
    const translation = extractResponseOutputText(payload);
    if (!translation) {
      throw new Error("OpenAI translation returned no text.");
    }
    return translation;
  } finally {
    clearTimeout(timeout);
  }
}

const openAiTranscriptModel = "whisper-1";
const openAiTranscriptMaxBytes = 25 * 1024 * 1024;
let sourceTranscriptJobPumpScheduled = false;
let sourceTranscriptJobPumpRunning = false;

function normalizeLanguageCode(raw, fallback = "und") {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return fallback;
  return value.slice(0, 16);
}

function sanitizeTranscriptSegments(rawSegments) {
  if (!Array.isArray(rawSegments)) return [];
  return rawSegments
    .map((segment, index) => {
      const startMs = Math.max(
        0,
        Math.round(
          Number(
            segment?.startMs ??
                segment?.start_ms ??
                Number(segment?.start || 0) * 1000
          ) || 0
        )
      );
      const endMs = Math.max(
        startMs,
        Math.round(
          Number(
            segment?.endMs ??
                segment?.end_ms ??
                Number(segment?.end || 0) * 1000
          ) || startMs
        )
      );
      const text = String(segment?.text || "").trim();
      if (!text) return null;
      return {
        index,
        startMs,
        endMs,
        text,
      };
    })
    .filter(Boolean);
}

function parseTranscriptSegmentsJson(raw) {
  if (!raw) return [];
  try {
    return sanitizeTranscriptSegments(JSON.parse(raw));
  } catch {
    return [];
  }
}

function buildTranscriptTrackResponse(row) {
  const segments = parseTranscriptSegmentsJson(row?.segments_json);
  return {
    id: String(row?.id || ""),
    contentId: String(row?.content_item_id || ""),
    kind: String(row?.kind || "source"),
    languageCode: normalizeLanguageCode(row?.language_code),
    sourceLanguageCode: normalizeLanguageCode(row?.source_language_code),
    status: String(row?.status || "ready"),
    segmentCount: segments.length,
    createdAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    segments,
  };
}

function validateEditableTranscriptSegments(rawSegments) {
  const sanitized = sanitizeTranscriptSegments(rawSegments);
  if (!sanitized.length) {
    throw new Error("Transcript must include at least one subtitle segment.");
  }
  let previousStartMs = -1;
  for (const segment of sanitized) {
    if (segment.startMs < previousStartMs) {
      throw new Error("Subtitle segments must stay ordered by time.");
    }
    if (segment.endMs < segment.startMs) {
      throw new Error("Subtitle segments cannot end before they start.");
    }
    if (!String(segment.text || "").trim()) {
      throw new Error("Subtitle text cannot be empty.");
    }
    previousStartMs = segment.startMs;
  }
  return sanitized;
}

function normalizeTranscriptJobStatus(raw, fallback = "none") {
  const status = String(raw || "").trim().toLowerCase();
  if (["pending", "processing", "ready", "failed"].includes(status)) {
    return status;
  }
  return fallback;
}

function buildTranscriptJobResponse(row) {
  return {
    id: String(row?.id || ""),
    contentId: String(row?.content_item_id || ""),
    sourceAssetId: row?.source_asset_id ? String(row.source_asset_id) : "",
    requestedByUserId: row?.requested_by_user_id
      ? String(row.requested_by_user_id)
      : "",
    status: normalizeTranscriptJobStatus(row?.status, "pending"),
    errorMessage: String(row?.error_message || ""),
    attempts: Number(row?.attempts || 0),
    startedAt: row?.started_at ? new Date(row.started_at).toISOString() : null,
    finishedAt: row?.finished_at
      ? new Date(row.finished_at).toISOString()
      : null,
    createdAt: row?.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function getContentAssetByRole(contentId, role) {
  const [rows] = await pool.query(
    `SELECT id, content_item_id, role, storage_key, public_url, mime_type, byte_size
     FROM content_assets
     WHERE content_item_id = ? AND role = ?
     LIMIT 1`,
    [contentId, role]
  );
  return rows?.[0] || null;
}

async function getTranscriptSourceAsset(contentId) {
  const [rows] = await pool.query(
    `SELECT id, content_item_id, role, asset_order, storage_key, public_url, mime_type, byte_size
     FROM content_assets
     WHERE content_item_id = ?
       AND role IN ('video_original', 'gallery_item', 'video_stream', 'podcast_audio', 'audio_track')
     ORDER BY
       CASE role
         WHEN 'video_original' THEN 0
         WHEN 'gallery_item' THEN 1
         WHEN 'video_stream' THEN 2
         WHEN 'podcast_audio' THEN 3
         WHEN 'audio_track' THEN 4
         ELSE 9
       END,
      asset_order ASC,
      id ASC`,
    [contentId]
  );
  const mediaRows = (rows || []).filter((row) =>
    /^(video|audio)\//.test(String(row?.mime_type || "").toLowerCase())
  );
  const transcribableRows = mediaRows.filter((row) => {
    const byteSize = Number(row?.byte_size || 0);
    return !byteSize || byteSize <= openAiTranscriptMaxBytes;
  });
  const candidates = transcribableRows.length > 0 ? transcribableRows : mediaRows;
  for (const row of candidates) {
    const mimeType = String(row?.mime_type || "").toLowerCase();
    if (mimeType.startsWith("video/") || mimeType.startsWith("audio/")) {
      return row;
    }
  }
  return null;
}

async function getTranscriptTrackRow(contentId, languageCode, kind = "source") {
  const [rows] = await pool.query(
    `SELECT id, content_item_id, kind, language_code, source_language_code, status, segments_json, created_at, updated_at
     FROM content_transcripts
     WHERE content_item_id = ?
       AND kind = ?
       AND language_code = ?
     LIMIT 1`,
    [contentId, kind, normalizeLanguageCode(languageCode)]
  );
  return rows?.[0] || null;
}

async function listTranscriptTrackRows(contentId) {
  const [rows] = await pool.query(
    `SELECT id, content_item_id, kind, language_code, source_language_code, status, segments_json, created_at, updated_at
     FROM content_transcripts
     WHERE content_item_id = ?
     ORDER BY kind ASC, language_code ASC, id ASC`,
    [contentId]
  );
  return rows || [];
}

async function getSourceTranscriptTrackRow(contentId) {
  const rows = await listTranscriptTrackRows(contentId);
  return rows.find((row) => String(row?.kind || "") === "source") || null;
}

async function getTranscriptJobRow(contentId) {
  const [rows] = await pool.query(
    `SELECT id, content_item_id, source_asset_id, requested_by_user_id, status, error_message,
            attempts, started_at, finished_at, created_at, updated_at
     FROM content_transcript_jobs
     WHERE content_item_id = ?
     LIMIT 1`,
    [contentId]
  );
  return rows?.[0] || null;
}

async function markSourceTranscriptJobReady({
  contentId,
  sourceAssetId = null,
  requestedByUserId = null,
}) {
  await pool.query(
    `INSERT INTO content_transcript_jobs
     (content_item_id, source_asset_id, requested_by_user_id, status, error_message, attempts, started_at, finished_at)
     VALUES (?, ?, ?, 'ready', NULL, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       source_asset_id = COALESCE(VALUES(source_asset_id), source_asset_id),
       requested_by_user_id = COALESCE(VALUES(requested_by_user_id), requested_by_user_id),
       status = 'ready',
       error_message = NULL,
       finished_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP`,
    [contentId, sourceAssetId, requestedByUserId]
  );
}

async function markSourceTranscriptJobFailed({
  contentId,
  sourceAssetId = null,
  requestedByUserId = null,
  errorMessage,
}) {
  await pool.query(
    `INSERT INTO content_transcript_jobs
     (content_item_id, source_asset_id, requested_by_user_id, status, error_message, attempts, finished_at)
     VALUES (?, ?, ?, 'failed', ?, 1, CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       source_asset_id = COALESCE(VALUES(source_asset_id), source_asset_id),
       requested_by_user_id = COALESCE(VALUES(requested_by_user_id), requested_by_user_id),
       status = 'failed',
       error_message = VALUES(error_message),
       finished_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP`,
    [contentId, sourceAssetId, requestedByUserId, String(errorMessage || "Failed to generate transcript.")]
  );
}

function scheduleSourceTranscriptJobPump(delayMs = 0) {
  if (sourceTranscriptJobPumpScheduled) {
    return;
  }
  sourceTranscriptJobPumpScheduled = true;
  setTimeout(() => {
    sourceTranscriptJobPumpScheduled = false;
    void pumpSourceTranscriptJobs();
  }, Math.max(0, Number(delayMs || 0)));
}

async function queueSourceTranscriptJob({
  contentId,
  requestedByUserId = null,
  sourceAssetId = null,
}) {
  const existingTrack = await getSourceTranscriptTrackRow(contentId);
  if (existingTrack) {
    await markSourceTranscriptJobReady({
      contentId,
      sourceAssetId,
      requestedByUserId,
    });
    return {
      track: existingTrack,
      job: await getTranscriptJobRow(contentId),
    };
  }
  const existingJob = await getTranscriptJobRow(contentId);
  const existingStatus = normalizeTranscriptJobStatus(existingJob?.status, "none");
  if (existingStatus === "pending" || existingStatus === "processing") {
    scheduleSourceTranscriptJobPump(0);
    return { track: null, job: existingJob };
  }
  await pool.query(
    `INSERT INTO content_transcript_jobs
     (content_item_id, source_asset_id, requested_by_user_id, status, error_message, attempts, started_at, finished_at)
     VALUES (?, ?, ?, 'pending', NULL, 0, NULL, NULL)
     ON DUPLICATE KEY UPDATE
       source_asset_id = COALESCE(VALUES(source_asset_id), source_asset_id),
       requested_by_user_id = COALESCE(VALUES(requested_by_user_id), requested_by_user_id),
       status = 'pending',
       error_message = NULL,
       started_at = NULL,
       finished_at = NULL,
       updated_at = CURRENT_TIMESTAMP`,
    [contentId, sourceAssetId, requestedByUserId]
  );
  const job = await getTranscriptJobRow(contentId);
  scheduleSourceTranscriptJobPump(0);
  return { track: null, job };
}

async function claimNextSourceTranscriptJob() {
  let rows;
  try {
    [rows] = await pool.query(
      `SELECT id, content_item_id, source_asset_id, requested_by_user_id, status, error_message,
              attempts, started_at, finished_at, created_at, updated_at
       FROM content_transcript_jobs
       WHERE status = 'pending'
          OR (status = 'processing' AND started_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE))
       ORDER BY
         CASE status WHEN 'processing' THEN 0 ELSE 1 END,
         updated_at ASC,
         id ASC
       LIMIT 1`
    );
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') {
      return null;
    }
    throw error;
  }
  const job = rows?.[0] || null;
  if (!job?.id) {
    return null;
  }
  await pool.query(
    `UPDATE content_transcript_jobs
     SET status = 'processing',
         attempts = attempts + 1,
         started_at = CURRENT_TIMESTAMP,
         error_message = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [job.id]
  );
  return await getTranscriptJobRow(job.content_item_id);
}

async function processSourceTranscriptJob(jobRow) {
  const contentId = Number(jobRow?.content_item_id || 0);
  if (!contentId) {
    return;
  }
  const requestedByUserId = Number(jobRow?.requested_by_user_id || 0) || null;
  try {
    const existingTrack = await getSourceTranscriptTrackRow(contentId);
    if (existingTrack) {
      await markSourceTranscriptJobReady({
        contentId,
        sourceAssetId: jobRow?.source_asset_id ?? null,
        requestedByUserId,
      });
      return;
    }
    const item = await getContentItemById(contentId);
    const itemKind = String(item?.kind || "").toLowerCase();
    const isTranscribableContent =
      itemKind === "video" || itemKind === "podcast" || itemKind === "audio";
    if (!item || item.deleted_at || !isTranscribableContent) {
      throw new Error("Transcribable content not found.");
    }
    const asset = await getTranscriptSourceAsset(contentId);
    if (!asset?.storage_key) {
      throw new Error("A media source file is required before generating a transcript.");
    }
    const transcript = await transcribeMediaFileWithOpenAi({
      filePath: asset.storage_key,
      mimeType: asset.mime_type,
      sourceLanguage: item.source_locale || "und",
    });
    const languageCode = normalizeLanguageCode(
      transcript.languageCode,
      item.source_locale || "und"
    );
    await pool.query(
      `INSERT INTO content_transcripts
       (content_item_id, kind, language_code, source_language_code, status, segments_json)
       VALUES (?, 'source', ?, ?, 'ready', ?)
       ON DUPLICATE KEY UPDATE
         source_language_code = VALUES(source_language_code),
         status = VALUES(status),
         segments_json = VALUES(segments_json),
         updated_at = CURRENT_TIMESTAMP`,
      [
        contentId,
        languageCode,
        languageCode,
        JSON.stringify(transcript.segments),
      ]
    );
    await markSourceTranscriptJobReady({
      contentId,
      sourceAssetId: Number(asset.id || 0) || null,
      requestedByUserId,
    });
  } catch (error) {
    await markSourceTranscriptJobFailed({
      contentId,
      sourceAssetId: jobRow?.source_asset_id ?? null,
      requestedByUserId,
      errorMessage: String(error?.message || "Failed to generate transcript."),
    });
  }
}

async function pumpSourceTranscriptJobs() {
  if (sourceTranscriptJobPumpRunning) {
    return;
  }
  sourceTranscriptJobPumpRunning = true;
  try {
    while (true) {
      const job = await claimNextSourceTranscriptJob();
      if (!job) {
        break;
      }
      await processSourceTranscriptJob(job);
    }
  } finally {
    sourceTranscriptJobPumpRunning = false;
  }
}

async function countPublishedPostsForUser(userId) {
  const numericUserId = Number(userId);
  if (!numericUserId) return 0;
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS count
     FROM content_items c
     INNER JOIN users u ON u.id = c.user_id
     WHERE c.user_id = ?
       AND c.status = 'published'
       AND c.deleted_at IS NULL
       AND (
         COALESCE(u.can_publish_video, 0) = 1
         OR LOWER(COALESCE(u.role, '')) = 'creator'
       )
       AND (
         c.kind IN ('text', 'image')
         OR (
           c.kind = 'video'
           AND EXISTS (
             SELECT 1
             FROM content_assets a
             WHERE a.content_item_id = c.id
               AND a.role IN ('gallery_item', 'video_original')
           )
         )
         OR c.kind = 'podcast'
         OR (
           c.kind = 'audio'
           AND EXISTS (
             SELECT 1
             FROM content_assets a
             WHERE a.content_item_id = c.id
               AND a.role IN ('podcast_audio', 'audio_track')
           )
         )
       )`,
    [numericUserId]
  );
  return Number(row?.count || 0);
}

async function transcribeMediaFileWithOpenAi({
  filePath,
  mimeType,
  sourceLanguage = "und",
}) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Translation service is not configured.");
  }
  const normalizedMimeType = String(mimeType || "").trim().toLowerCase();
  const derivedAudioSource =
    normalizedMimeType.startsWith("video/")
      ? await buildTranscriptAudioDerivative(filePath)
      : null;
  const transcriptFilePath = derivedAudioSource?.filePath || filePath;
  const transcriptMimeType = derivedAudioSource?.mimeType || mimeType || "video/mp4";
  const normalizedSourceLanguage = normalizeLanguageCode(sourceLanguage);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const stat = await fs.promises.stat(transcriptFilePath);
    if (!stat?.isFile?.()) {
      throw new Error("Transcript source file is unavailable.");
    }
    if (Number(stat.size || 0) > openAiTranscriptMaxBytes) {
      const maxMb = Math.round(openAiTranscriptMaxBytes / (1024 * 1024));
      throw new Error(
        `Transcript generation currently supports media files up to ${maxMb} MB.`
      );
    }
    const bytes = await fs.promises.readFile(transcriptFilePath);
    const file = new File([bytes], path.basename(transcriptFilePath), {
      type: transcriptMimeType,
    });
    const form = new FormData();
    form.set("file", file);
    form.set("model", openAiTranscriptModel);
    form.set("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    if (normalizedSourceLanguage && normalizedSourceLanguage !== "und") {
      form.set("language", normalizedSourceLanguage);
    }
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
      signal: controller.signal,
    });
    const raw = await response.text();
    const payload = raw ? JSON.parse(raw) : {};
    if (!response.ok) {
      const message =
        payload?.error?.message ||
        payload?.message ||
        `OpenAI transcription request failed with status ${response.status}.`;
      throw new Error(message);
    }
    const segments = sanitizeTranscriptSegments(payload?.segments);
    if (segments.length === 0) {
      throw new Error("OpenAI transcription returned no timed segments.");
    }
    return {
      languageCode: normalizeLanguageCode(payload?.language, normalizedSourceLanguage),
      segments,
      text: String(payload?.text || "").trim(),
    };
  } finally {
    clearTimeout(timeout);
    await derivedAudioSource?.cleanup?.();
  }
}

async function translateTranscriptSegmentsWithOpenAi({
  segments,
  sourceLanguage = "auto",
  targetLanguage,
}) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("Translation service is not configured.");
  }
  const sanitized = sanitizeTranscriptSegments(segments);
  if (sanitized.length === 0) {
    throw new Error("No transcript segments available to translate.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: openAiTranslationModel,
        instructions:
          "You translate timestamped transcript segments. Return JSON only. Preserve the number of segments and their order exactly. Never merge or split segments. Return an array where each item has exactly two fields: index (number) and text (string). Translate only the text field.",
        input:
          `Source language: ${sourceLanguage}\nTarget language: ${targetLanguage}\n` +
          `Transcript segments JSON:\n${JSON.stringify(
            sanitized.map((segment, index) => ({ index, text: segment.text }))
          )}`,
      }),
      signal: controller.signal,
    });
    const raw = await response.text();
    const payload = raw ? JSON.parse(raw) : {};
    if (!response.ok) {
      const message =
        payload?.error?.message ||
        payload?.message ||
        `OpenAI transcript translation failed with status ${response.status}.`;
      throw new Error(message);
    }
    const outputText = extractResponseOutputText(payload);
    let translatedPayload;
    try {
      translatedPayload = JSON.parse(outputText);
    } catch {
      throw new Error("OpenAI transcript translation returned invalid JSON.");
    }
    if (!Array.isArray(translatedPayload) || translatedPayload.length !== sanitized.length) {
      throw new Error("OpenAI transcript translation returned an unexpected segment count.");
    }
    const translatedByIndex = new Map();
    for (const row of translatedPayload) {
      const index = Number(row?.index);
      const text = String(row?.text || "").trim();
      if (!Number.isFinite(index) || index < 0 || index >= sanitized.length || !text) {
        throw new Error("OpenAI transcript translation returned invalid segment data.");
      }
      translatedByIndex.set(index, text);
    }
    return sanitized.map((segment, index) => ({
      ...segment,
      text: translatedByIndex.get(index) || segment.text,
    }));
  } finally {
    clearTimeout(timeout);
  }
}

async function getContentItemById(contentId) {
  const [rows] = await pool.query(
    `SELECT c.id, c.user_id, c.kind, c.status, c.title, c.summary, c.body, c.source_locale, c.deleted_at
     FROM content_items c
     WHERE c.id = ?
     LIMIT 1`,
    [contentId]
  );
  return rows?.[0] || null;
}

function isContentItemVisibleForEngagement(item) {
  if (!item) return false;
  if (item.deleted_at) return false;
  return String(item.status || "") === "published";
}

const SYNTHETIC_METRIC_MAX = 1000000000;

function parseSyntheticCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(Math.trunc(parsed), 0), SYNTHETIC_METRIC_MAX);
}

async function getSyntheticMetricAdjustment(targetType, targetId, metric) {
  const [[row]] = await pool.query(
    `SELECT count_value
     FROM synthetic_metric_adjustments
     WHERE target_type = ?
       AND target_id = ?
       AND metric = ?
     LIMIT 1`,
    [targetType, targetId, metric]
  );
  return Number(row?.count_value || 0);
}

async function setSyntheticMetricAdjustment({ targetType, targetId, metric, count, actor }) {
  const safeCount = parseSyntheticCount(count);
  if (safeCount == null) {
    const err = new Error("Synthetic count must be a valid number.");
    err.statusCode = 400;
    throw err;
  }
  await pool.query(
    `INSERT INTO synthetic_metric_adjustments
       (target_type, target_id, metric, count_value, updated_by_admin_id, updated_by_admin_account_id)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       count_value = VALUES(count_value),
       updated_by_admin_id = VALUES(updated_by_admin_id),
       updated_by_admin_account_id = VALUES(updated_by_admin_account_id),
       updated_at = CURRENT_TIMESTAMP`,
    [
      targetType,
      targetId,
      metric,
      safeCount,
      actor?.adminId || null,
      actor?.adminAccountId || null,
    ]
  );
  return safeCount;
}

async function getFollowerCountWithSynthetic(userId) {
  const [[followersRow]] = await pool.query(
    `SELECT COUNT(*) AS count FROM follows WHERE following_id = ?`,
    [userId]
  );
  const organic = Number(followersRow?.count || 0);
  const synthetic = await getSyntheticMetricAdjustment("user", userId, "followers");
  return { organic, synthetic, total: organic + synthetic };
}

async function getContentMetricCountWithSynthetic(contentId, metric) {
  const table = metric === "views" ? "content_views" : "content_likes";
  const [[countRow]] = await pool.query(
    `SELECT COUNT(*) AS count FROM ${table} WHERE content_item_id = ?`,
    [contentId]
  );
  const organic = Number(countRow?.count || 0);
  const synthetic = await getSyntheticMetricAdjustment("content", contentId, metric);
  return { organic, synthetic, total: organic + synthetic };
}

async function resolveContentIdFromAdminLink(rawLink) {
  const text = String(rawLink || "").trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  const shareMatch = text.match(/\/(?:share|s)\/([A-Za-z0-9_-]+)/);
  if (shareMatch?.[1]) {
    const [rows] = await pool.query(
      `SELECT content_item_id
       FROM content_share_links
       WHERE public_token = ?
       LIMIT 1`,
      [shareMatch[1]]
    );
    return Number(rows?.[0]?.content_item_id || 0) || null;
  }
  const explicitMatch = text.match(/\/(?:app\/)?content\/(?:items|videos|podcasts|video|podcast|post)\/(\d+)/);
  if (explicitMatch?.[1]) return Number(explicitMatch[1]);
  return null;
}

function parseBoundedInt(rawValue, defaultValue, minValue, maxValue) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(Math.trunc(parsed), minValue), maxValue);
}

function decodeContentCursor(rawCursor) {
  const text = String(rawCursor || "").trim();
  if (!text) return null;
  try {
    const decoded = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    const timestamp = String(decoded?.timestamp || "").trim();
    const id = Number(decoded?.id);
    if (!timestamp || !Number.isFinite(id) || id <= 0) {
      return null;
    }
    return { timestamp, id: Math.trunc(id) };
  } catch {
    return null;
  }
}

function encodeContentCursor(timestamp, id) {
  const normalizedTimestamp = String(timestamp || "").trim();
  const normalizedId = Number(id);
  if (!normalizedTimestamp || !Number.isFinite(normalizedId) || normalizedId <= 0) {
    return null;
  }
  return Buffer.from(
    JSON.stringify({ timestamp: normalizedTimestamp, id: Math.trunc(normalizedId) }),
    "utf8"
  ).toString("base64url");
}

function buildCursorFilter({ cursor, timeExpression, idExpression }) {
  if (!cursor) {
    return { sql: "", params: [] };
  }
  return {
    sql:
      ` AND ((${timeExpression}) < ? OR ((${timeExpression}) = ? AND (${idExpression}) < ?))`,
    params: [cursor.timestamp, cursor.timestamp, cursor.id],
  };
}

function takePageRows(rows, limit) {
  if (!Array.isArray(rows)) {
    return { items: [], pageInfo: { hasMore: false, nextCursor: null, limit } };
  }
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.length > 0 ? items[items.length - 1] : null;
  return {
    items,
    pageInfo: {
      hasMore,
      nextCursor: hasMore ? encodeContentCursor(last?.cursor_timestamp, last?.id) : null,
      limit,
    },
  };
}

function buildPostAssetPayload(assetRows) {
  const posterByOrder = new Map();
  const mediaByOrder = new Map();
  for (const assetRow of assetRows || []) {
    const publicUrl = String(assetRow?.public_url || "").trim();
    if (!publicUrl) continue;
    const role = String(assetRow?.role || "");
    const order = Number(assetRow?.asset_order || 0);
    const key = `${order}`;
    if (role === "video_poster") {
      posterByOrder.set(key, publicUrl);
      continue;
    }
    const mimeType = String(assetRow?.mime_type || "").trim();
    const priority =
      role === "video_stream"
        ? 4
        : role === "video_original"
          ? 3
          : role === "gallery_item"
            ? 2
            : 1;
    const existing = mediaByOrder.get(key);
    if (!existing || priority > existing.priority) {
      mediaByOrder.set(key, {
        priority,
        role,
        order,
        url: publicUrl,
        mimeType,
      });
    }
  }

  const assets = Array.from(mediaByOrder.values())
    .sort((a, b) => a.order - b.order)
    .map((asset) => {
      const lowerMimeType = String(asset.mimeType || "").toLowerCase();
      const isVideo = lowerMimeType.startsWith("video/");
      return {
        role: isVideo ? "video" : asset.role || "gallery_item",
        order: asset.order,
        url: asset.url,
        posterUrl: isVideo ? posterByOrder.get(`${asset.order}`) || "" : "",
        mimeType: asset.mimeType || "",
      };
    });

  return {
    assets,
    mediaUrl: assets.length > 0 ? assets[0].url : "",
    mediaMimeType: assets.length > 0 ? assets[0].mimeType : "",
  };
}

async function getPublishedContentItemSummary(contentId, viewerId) {
  const [[row]] = await pool.query(
    `SELECT c.id, c.user_id, c.kind, c.title, c.summary, c.body, c.source_locale, c.created_at, c.published_at,
            u.display_name, u.username, u.profile_photo_url,
            (COALESCE(like_counts.like_count, 0) + COALESCE(synthetic_like_counts.count_value, 0)) AS like_count,
            COALESCE(comment_counts.comment_count, 0) AS comment_count,
            (COALESCE(view_counts.view_count, 0) + COALESCE(synthetic_view_counts.count_value, 0)) AS view_count,
            CASE WHEN viewer_likes.user_id IS NULL THEN 0 ELSE 1 END AS liked_by_me,
            CASE WHEN viewer_saves.user_id IS NULL THEN 0 ELSE 1 END AS saved_by_me
     FROM content_items c
     LEFT JOIN users u ON u.id = c.user_id
     LEFT JOIN (
       SELECT content_item_id, COUNT(*) AS like_count
       FROM content_likes
       GROUP BY content_item_id
     ) like_counts ON like_counts.content_item_id = c.id
     LEFT JOIN synthetic_metric_adjustments synthetic_like_counts
       ON synthetic_like_counts.target_type = 'content'
      AND synthetic_like_counts.metric = 'likes'
      AND synthetic_like_counts.target_id = c.id
     LEFT JOIN (
       SELECT content_item_id, COUNT(*) AS comment_count
       FROM content_comments
       WHERE deleted_at IS NULL
       GROUP BY content_item_id
     ) comment_counts ON comment_counts.content_item_id = c.id
     LEFT JOIN (
       SELECT content_item_id, COUNT(*) AS view_count
       FROM content_views
       GROUP BY content_item_id
     ) view_counts ON view_counts.content_item_id = c.id
     LEFT JOIN synthetic_metric_adjustments synthetic_view_counts
       ON synthetic_view_counts.target_type = 'content'
      AND synthetic_view_counts.metric = 'views'
      AND synthetic_view_counts.target_id = c.id
     LEFT JOIN content_likes viewer_likes
       ON viewer_likes.content_item_id = c.id
      AND viewer_likes.user_id = ?
     LEFT JOIN content_saves viewer_saves
       ON viewer_saves.content_item_id = c.id
      AND viewer_saves.user_id = ?
     WHERE c.id = ?
       AND c.status = 'published'
       AND c.deleted_at IS NULL
     LIMIT 1`,
    [viewerId, viewerId, contentId]
  );
  return row || null;
}

async function getPublishedContentItemDetail(contentId, viewerId) {
  const row = await getPublishedContentItemSummary(contentId, viewerId);
  if (!row?.id) {
    return null;
  }

  const base = {
    id: String(row.id),
    userId: String(row.user_id),
    kind: row.kind || "text",
    authorName: row.display_name || "User",
    authorUsername: row.username || "",
    authorProfilePhotoUrl: row.profile_photo_url || "",
    title: row.title || "",
    summary: row.summary || "",
    body: row.body || "",
    sourceLocale: row.source_locale || "und",
    likeCount: Number(row.like_count || 0),
    commentCount: Number(row.comment_count || 0),
    viewCount: Number(row.view_count || 0),
    likedByMe: Number(row.liked_by_me || 0) === 1,
    savedByMe: Number(row.saved_by_me || 0) === 1,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
  };

  if (String(row.kind || "") === "podcast" || String(row.kind || "") === "audio") {
    const [assetRows] = await pool.query(
      `SELECT role, public_url, mime_type
       FROM content_assets
       WHERE content_item_id = ?
         AND role IN ('podcast_cover', 'podcast_audio', 'audio_track')
       ORDER BY CASE role
                  WHEN 'podcast_cover' THEN 0
                  WHEN 'podcast_audio' THEN 1
                  WHEN 'audio_track' THEN 2
                  ELSE 9
                END,
                id ASC`,
      [contentId]
    );
    let coverUrl = "";
    let audioUrl = "";
    let audioMimeType = "";
    for (const assetRow of assetRows || []) {
      const role = String(assetRow.role || "");
      if (role === "podcast_cover" && !coverUrl && assetRow.public_url) {
        coverUrl = assetRow.public_url;
      }
      if ((role === "podcast_audio" || role === "audio_track") && !audioUrl && assetRow.public_url) {
        audioUrl = assetRow.public_url;
        audioMimeType = assetRow.mime_type || "";
      }
    }
    return {
      ...base,
      kind: "podcast",
      coverUrl,
      audioUrl,
      audioMimeType,
    };
  }

  const [assetRows] = await pool.query(
    `SELECT role, asset_order, public_url, mime_type
     FROM content_assets
     WHERE content_item_id = ?
       AND role IN ('gallery_item', 'video_original', 'video_stream', 'video_poster')
     ORDER BY asset_order ASC,
              CASE role
                WHEN 'video_stream' THEN 0
                WHEN 'video_original' THEN 1
                WHEN 'gallery_item' THEN 2
                WHEN 'video_poster' THEN 3
                ELSE 9
              END,
              id ASC`,
    [contentId]
  );
  const media = buildPostAssetPayload(assetRows);
  return {
    ...base,
    assets: media.assets,
    mediaUrl: media.mediaUrl,
    mediaMimeType: media.mediaMimeType,
  };
}

function normalizeSharedContentKind(rawKind) {
  const kind = String(rawKind || "").trim().toLowerCase();
  if (kind === "video") return "video";
  if (kind === "podcast" || kind === "audio") return "podcast";
  return "post";
}

function buildPublicShareUrl(token, { webOnly = false } = {}) {
  const normalizedToken = encodeURIComponent(String(token || "").trim());
  return `${publicShareBaseUrl}/${webOnly ? "w" : "s"}/${normalizedToken}`;
}

function buildAppShareUrl(token) {
  return buildPublicShareUrl(token);
}

function buildNativeAppShareUrl(token) {
  return `talkflix://app/s/${encodeURIComponent(String(token || "").trim())}`;
}

function buildShareUrlPayload(token) {
  return {
    shareUrl: buildPublicShareUrl(token),
    webPreviewUrl: buildPublicShareUrl(token, { webOnly: true }),
    appShareUrl: buildAppShareUrl(token),
    nativeAppUrl: buildNativeAppShareUrl(token),
  };
}

function buildAuthenticatedSharedContentRoute(shareKind, contentId) {
  const normalizedContentId = encodeURIComponent(String(contentId || "").trim());
  if (!normalizedContentId) return "";
  if (String(shareKind || "").trim().toLowerCase() === "video") {
    return `/app/content/videos/${normalizedContentId}`;
  }
  return `/app/content/items/${normalizedContentId}`;
}

function generatePublicShareToken(length = 11) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.randomBytes(length);
  let token = "";
  for (let index = 0; index < length; index += 1) {
    token += alphabet[bytes[index] % alphabet.length];
  }
  return token;
}

async function getActiveContentShareLinkByItemId(contentId) {
  const [rows] = await pool.query(
    `SELECT id, content_item_id, public_token, created_by_user_id, preview_seconds, is_active, created_at, updated_at
     FROM content_share_links
     WHERE content_item_id = ?
       AND is_active = 1
     LIMIT 1`,
    [contentId]
  );
  return rows?.[0] || null;
}

async function getActiveContentShareLinkByToken(token) {
  const [rows] = await pool.query(
    `SELECT id, content_item_id, public_token, created_by_user_id, preview_seconds, is_active, created_at, updated_at
     FROM content_share_links
     WHERE public_token = ?
       AND is_active = 1
     LIMIT 1`,
    [String(token || "").trim()]
  );
  return rows?.[0] || null;
}

async function getOrCreateContentShareLink({ contentId, createdByUserId = null }) {
  const existing = await getActiveContentShareLinkByItemId(contentId);
  if (existing?.public_token) {
    return existing;
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const token = generatePublicShareToken();
    try {
      const [result] = await pool.query(
        `INSERT INTO content_share_links
         (content_item_id, public_token, created_by_user_id, preview_seconds, is_active)
         VALUES (?, ?, ?, ?, 1)`,
        [contentId, token, createdByUserId, publicSharePreviewSeconds]
      );
      return {
        id: Number(result.insertId || 0),
        content_item_id: contentId,
        public_token: token,
        created_by_user_id: createdByUserId,
        preview_seconds: publicSharePreviewSeconds,
        is_active: 1,
      };
    } catch (e) {
      if (e?.code === "ER_DUP_ENTRY") {
        const current = await getActiveContentShareLinkByItemId(contentId);
        if (current?.public_token) {
          return current;
        }
        continue;
      }
      throw e;
    }
  }
  throw new Error("Could not allocate a unique share token.");
}

function normalizeShareEntityType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "live") return "live";
  if (normalized === "profile" || normalized === "user") return "profile";
  return "";
}

function parseShareMetadata(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function serializeShareLink(row) {
  if (!row) return null;
  return {
    id: Number(row.id || 0),
    entityType: String(row.entity_type || ""),
    entityId: String(row.entity_id || ""),
    token: String(row.public_token || ""),
    createdByUserId: row.created_by_user_id == null ? null : Number(row.created_by_user_id),
    previewSeconds: Number(row.preview_seconds || publicSharePreviewSeconds),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    metadata: parseShareMetadata(row.metadata_json),
    ...buildShareUrlPayload(row.public_token),
  };
}

function buildShareResponse(row, { shareKind = "", canonicalRoute = "" } = {}) {
  const serialized = serializeShareLink(row);
  if (!serialized) return null;
  return {
    token: serialized.token,
    entityType: serialized.entityType,
    entityId: serialized.entityId,
    shareKind: shareKind || serialized.entityType,
    contentId: "",
    canonicalRoute,
    shareUrl: serialized.shareUrl,
    webPreviewUrl: serialized.webPreviewUrl,
    appShareUrl: serialized.appShareUrl,
    nativeAppUrl: serialized.nativeAppUrl,
    previewSeconds: serialized.previewSeconds,
    expiresAt: serialized.expiresAt,
  };
}

async function getActiveGenericShareLinkByToken(token) {
  const [rows] = await pool.query(
    `SELECT id, entity_type, entity_id, public_token, created_by_user_id, preview_seconds,
            is_active, expires_at, metadata_json, created_at, updated_at
     FROM share_links
     WHERE public_token = ?
       AND is_active = 1
       AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())
     LIMIT 1`,
    [String(token || "").trim()]
  );
  return rows?.[0] || null;
}

async function getActiveGenericShareLinkByEntity({ entityType, entityId }) {
  const [rows] = await pool.query(
    `SELECT id, entity_type, entity_id, public_token, created_by_user_id, preview_seconds,
            is_active, expires_at, metadata_json, created_at, updated_at
     FROM share_links
     WHERE entity_type = ?
       AND entity_id = ?
       AND is_active = 1
       AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [entityType, String(entityId || "").trim()]
  );
  return rows?.[0] || null;
}

async function getOrCreateGenericShareLink({
  entityType,
  entityId,
  createdByUserId = null,
  metadata = {},
  expiresAt = null,
}) {
  const normalizedEntityType = normalizeShareEntityType(entityType);
  const normalizedEntityId = String(entityId || "").trim();
  if (!normalizedEntityType || !normalizedEntityId) {
    throw new Error("Invalid share entity.");
  }
  const existing = await getActiveGenericShareLinkByEntity({
    entityType: normalizedEntityType,
    entityId: normalizedEntityId,
  });
  if (existing?.public_token) {
    if (metadata && Object.keys(metadata).length > 0) {
      await pool.query(
        `UPDATE share_links
         SET metadata_json = ?
         WHERE id = ?
         LIMIT 1`,
        [JSON.stringify(metadata), existing.id]
      );
      existing.metadata_json = JSON.stringify(metadata);
    }
    return existing;
  }

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const token = generatePublicShareToken();
    try {
      const [result] = await pool.query(
        `INSERT INTO share_links
         (entity_type, entity_id, public_token, created_by_user_id, preview_seconds, is_active, expires_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          normalizedEntityType,
          normalizedEntityId,
          token,
          createdByUserId,
          publicSharePreviewSeconds,
          expiresAt,
          JSON.stringify(metadata || {}),
        ]
      );
      return {
        id: Number(result.insertId || 0),
        entity_type: normalizedEntityType,
        entity_id: normalizedEntityId,
        public_token: token,
        created_by_user_id: createdByUserId,
        preview_seconds: publicSharePreviewSeconds,
        is_active: 1,
        expires_at: expiresAt,
        metadata_json: JSON.stringify(metadata || {}),
      };
    } catch (e) {
      if (e?.code === "ER_DUP_ENTRY") continue;
      throw e;
    }
  }
  throw new Error("Could not allocate a unique share token.");
}

function buildProfileCanonicalRoute(userId) {
  const normalizedUserId = encodeURIComponent(String(userId || "").trim());
  return normalizedUserId ? `/app/profile/${normalizedUserId}` : "";
}

function buildLiveCanonicalRoute(broadcastId) {
  const normalizedBroadcastId = encodeURIComponent(String(broadcastId || "").trim());
  return normalizedBroadcastId ? `/app/live?broadcastId=${normalizedBroadcastId}` : "/app/live";
}

async function buildProfileSharePreview(shareLink) {
  const userId = Number(shareLink?.entity_id || 0);
  if (!userId) return null;
  const [[user]] = await pool.query(
    `SELECT id, display_name, username, profile_photo_url
     FROM users
     WHERE id = ?
       AND deleted_at IS NULL
     LIMIT 1`,
    [userId]
  );
  if (!user?.id) return null;
  const token = String(shareLink.public_token || "");
  const shareUrls = buildShareUrlPayload(token);
  return {
    shareToken: token,
    entityType: "profile",
    entityId: String(user.id),
    shareKind: "profile",
    contentId: "",
    title: user.display_name || "Talkflix profile",
    summary: user.username ? `@${user.username}` : "Talkflix profile",
    body: "",
    sourceLocale: "und",
    authorName: user.display_name || "User",
    authorUsername: user.username || "",
    authorProfilePhotoUrl: user.profile_photo_url || "",
    likeCount: 0,
    commentCount: 0,
    viewCount: 0,
    createdAt: null,
    publishedAt: null,
    previewSeconds: Number(shareLink.preview_seconds || publicSharePreviewSeconds),
    ...shareUrls,
    canonicalPath: `/s/${token}`,
    requiresAppForFull: true,
    profileId: String(user.id),
    profileName: user.display_name || "User",
    profileUsername: user.username || "",
    profilePhotoUrl: user.profile_photo_url || "",
    expiresAt: shareLink.expires_at ? new Date(shareLink.expires_at).toISOString() : null,
  };
}

function buildLiveSharePreview(shareLink) {
  const metadata = parseShareMetadata(shareLink?.metadata_json);
  const token = String(shareLink.public_token || "");
  const broadcastId = String(shareLink.entity_id || "");
  const shareUrls = buildShareUrlPayload(token);
  const title = String(metadata.title || "").trim() || "Live room";
  const hostName = String(metadata.hostName || "").trim();
  return {
    shareToken: token,
    entityType: "live",
    entityId: broadcastId,
    shareKind: "live",
    contentId: "",
    title,
    summary: String(metadata.description || "").trim(),
    body: "",
    sourceLocale: "und",
    authorName: hostName || "Talkflix host",
    authorUsername: "",
    authorProfilePhotoUrl: String(metadata.hostProfilePhotoUrl || "").trim(),
    likeCount: 0,
    commentCount: 0,
    viewCount: 0,
    createdAt: null,
    publishedAt: null,
    previewSeconds: Number(shareLink.preview_seconds || publicSharePreviewSeconds),
    ...shareUrls,
    canonicalPath: `/s/${token}`,
    requiresAppForFull: true,
    broadcastId,
    roomType: String(metadata.roomType || "").trim() || "audio",
    hostName,
    hostProfilePhotoUrl: String(metadata.hostProfilePhotoUrl || "").trim(),
    isPrivate: metadata.isPrivate === true,
    expiresAt: shareLink.expires_at ? new Date(shareLink.expires_at).toISOString() : null,
  };
}

function buildPublicPostAssetPreview(assetRows, { previewSeconds = publicSharePreviewSeconds } = {}) {
  const posterByOrder = new Map();
  const teaserByOrder = new Map();
  const mediaByOrder = new Map();
  for (const assetRow of assetRows || []) {
    const publicUrl = String(assetRow?.public_url || "").trim();
    if (!publicUrl) continue;
    const role = String(assetRow?.role || "");
    const order = Number(assetRow?.asset_order || 0);
    const key = `${order}`;
    if (role === "video_poster") {
      posterByOrder.set(key, publicUrl);
      continue;
    }
    if (role === "video_teaser") {
      teaserByOrder.set(key, publicUrl);
      continue;
    }
    const mimeType = String(assetRow?.mime_type || "").trim();
    const priority =
      role === "video_stream"
        ? 4
        : role === "video_original"
          ? 3
          : role === "gallery_item"
            ? 2
            : 1;
    const existing = mediaByOrder.get(key);
    if (!existing || priority > existing.priority) {
      mediaByOrder.set(key, {
        priority,
        role,
        order,
        url: publicUrl,
        mimeType,
      });
    }
  }

  return Array.from(mediaByOrder.values())
    .sort((a, b) => a.order - b.order)
    .map((asset) => {
      const lowerMimeType = String(asset.mimeType || "").toLowerCase();
      const isVideo = lowerMimeType.startsWith("video/");
      const previewUrl = isVideo ? teaserByOrder.get(`${asset.order}`) || asset.url : asset.url;
      return {
        role: isVideo ? "video" : asset.role || "gallery_item",
        order: asset.order,
        url: isVideo ? previewUrl : asset.url,
        previewUrl,
        posterUrl: isVideo ? posterByOrder.get(`${asset.order}`) || "" : "",
        mimeType: asset.mimeType || "",
        lockedAfterSeconds: isVideo ? previewSeconds : 0,
      };
    });
}

async function buildPublicSharedContentPreview({ contentId, token, shareLink = null }) {
  const [rows] = await pool.query(
    `SELECT c.id, c.user_id, c.kind, c.title, c.summary, c.body, c.source_locale, c.created_at, c.published_at,
            u.display_name, u.username, u.profile_photo_url,
            (COALESCE(like_counts.like_count, 0) + COALESCE(synthetic_like_counts.count_value, 0)) AS like_count,
            COALESCE(comment_counts.comment_count, 0) AS comment_count,
            (COALESCE(view_counts.view_count, 0) + COALESCE(synthetic_view_counts.count_value, 0)) AS view_count
     FROM content_items c
     LEFT JOIN users u ON u.id = c.user_id
     LEFT JOIN (
       SELECT content_item_id, COUNT(*) AS like_count
       FROM content_likes
       GROUP BY content_item_id
     ) like_counts ON like_counts.content_item_id = c.id
     LEFT JOIN synthetic_metric_adjustments synthetic_like_counts
       ON synthetic_like_counts.target_type = 'content'
      AND synthetic_like_counts.metric = 'likes'
      AND synthetic_like_counts.target_id = c.id
     LEFT JOIN (
       SELECT content_item_id, COUNT(*) AS comment_count
       FROM content_comments
       WHERE deleted_at IS NULL
       GROUP BY content_item_id
     ) comment_counts ON comment_counts.content_item_id = c.id
     LEFT JOIN (
       SELECT content_item_id, COUNT(*) AS view_count
       FROM content_views
       GROUP BY content_item_id
     ) view_counts ON view_counts.content_item_id = c.id
     LEFT JOIN synthetic_metric_adjustments synthetic_view_counts
       ON synthetic_view_counts.target_type = 'content'
      AND synthetic_view_counts.metric = 'views'
      AND synthetic_view_counts.target_id = c.id
     WHERE c.id = ?
       AND c.status = 'published'
       AND c.deleted_at IS NULL
     LIMIT 1`,
    [contentId]
  );
  const row = rows?.[0];
  if (!row?.id) {
    return null;
  }

  const shareKind = normalizeSharedContentKind(row.kind);
  const shareToken = String(token || "").trim();
  const previewSeconds =
    Number(shareLink?.preview_seconds || 0) > 0
      ? Number(shareLink.preview_seconds)
      : publicSharePreviewSeconds;
  const shareUrls = buildShareUrlPayload(shareToken);
  const base = {
    shareToken,
    entityType: "content",
    entityId: String(row.id),
    shareKind,
    contentId: String(row.id),
    contentKind: String(row.kind || ""),
    title: row.title || "",
    summary: row.summary || "",
    body: row.body || "",
    sourceLocale: row.source_locale || "und",
    authorName: row.display_name || "User",
    authorUsername: row.username || "",
    authorProfilePhotoUrl: row.profile_photo_url || "",
    likeCount: Number(row.like_count || 0),
    commentCount: Number(row.comment_count || 0),
    viewCount: Number(row.view_count || 0),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    previewSeconds,
    ...shareUrls,
    canonicalPath: `/s/${shareToken}`,
  };

  if (shareKind === "video") {
    const [assetRows] = await pool.query(
      `SELECT role, public_url, mime_type, byte_size
       FROM content_assets
       WHERE content_item_id = ?
         AND role IN ('video_stream', 'video_original', 'gallery_item', 'video_poster', 'video_teaser')
         AND asset_order = 0
       ORDER BY CASE role
                  WHEN 'video_teaser' THEN 0
                  WHEN 'video_stream' THEN 1
                  WHEN 'video_original' THEN 2
                  WHEN 'gallery_item' THEN 3
                  WHEN 'video_poster' THEN 4
                  ELSE 9
                END`,
      [contentId]
    );
    let teaserAsset = null;
    let playbackAsset = null;
    let posterAsset = null;
    for (const assetRow of assetRows || []) {
      const role = String(assetRow.role || "");
      if (!teaserAsset && role === "video_teaser") teaserAsset = assetRow;
      if (!playbackAsset && (role === "video_stream" || role === "video_original" || role === "gallery_item")) {
        playbackAsset = assetRow;
      }
      if (!posterAsset && role === "video_poster") {
        posterAsset = assetRow;
      }
    }
    const sourceTranscriptRow = await getSourceTranscriptTrackRow(contentId);
    const sourceTranscript = sourceTranscriptRow
      ? buildTranscriptTrackResponse(sourceTranscriptRow)
      : null;
    return {
      ...base,
      videoUrl: "",
      previewUrl: teaserAsset?.public_url || playbackAsset?.public_url || "",
      posterUrl: posterAsset?.public_url || "",
      mimeType: playbackAsset?.mime_type || "",
      byteSize: Number(playbackAsset?.byte_size || 0),
      requiresAppForFull: true,
      transcript: sourceTranscript,
    };
  }

  if (shareKind === "podcast") {
    const [assetRows] = await pool.query(
      `SELECT role, public_url, mime_type
       FROM content_assets
       WHERE content_item_id = ?
         AND role IN ('podcast_cover', 'podcast_audio', 'audio_track', 'audio_teaser')
       ORDER BY CASE role
                  WHEN 'podcast_cover' THEN 0
                  WHEN 'audio_teaser' THEN 1
                  WHEN 'podcast_audio' THEN 2
                  WHEN 'audio_track' THEN 3
                  ELSE 9
                END,
                id ASC`,
      [contentId]
    );
    let coverUrl = "";
    let audioUrl = "";
    let previewUrl = "";
    let audioMimeType = "";
    for (const assetRow of assetRows || []) {
      const role = String(assetRow.role || "");
      if (role === "podcast_cover" && !coverUrl && assetRow.public_url) {
        coverUrl = assetRow.public_url;
      }
      if (role === "audio_teaser" && !previewUrl && assetRow.public_url) {
        previewUrl = assetRow.public_url;
      }
      if ((role === "podcast_audio" || role === "audio_track") && !audioUrl && assetRow.public_url) {
        audioUrl = assetRow.public_url;
        audioMimeType = assetRow.mime_type || "";
      }
    }
    return {
      ...base,
      coverUrl,
      audioUrl: "",
      previewUrl: previewUrl || audioUrl,
      audioMimeType,
      requiresAppForFull: true,
    };
  }

  const [assetRows] = await pool.query(
    `SELECT role, asset_order, public_url, mime_type
     FROM content_assets
     WHERE content_item_id = ?
       AND role IN ('gallery_item', 'video_original', 'video_stream', 'video_poster', 'video_teaser')
     ORDER BY asset_order ASC,
              CASE role
                WHEN 'video_teaser' THEN 0
                WHEN 'video_stream' THEN 1
                WHEN 'video_original' THEN 2
                WHEN 'gallery_item' THEN 3
                WHEN 'video_poster' THEN 4
                ELSE 9
              END,
              id ASC`,
    [contentId]
  );
  const assets = buildPublicPostAssetPreview(assetRows, {
    previewSeconds,
  });
  return {
    ...base,
    assets,
    mediaUrl: assets[0]?.url || "",
    previewUrl: assets[0]?.previewUrl || "",
    posterUrl: assets[0]?.posterUrl || "",
    mediaMimeType: assets[0]?.mimeType || "",
    requiresAppForFull: assets.some((asset) => Number(asset.lockedAfterSeconds || 0) > 0),
  };
}

const profileMediaVisibility = "profile_media";
const profileMediaMaxPhotos = 4;
const profileMediaMaxVideos = 1;
const profileMediaMaxVideoSeconds = 60;

function buildProfileMediaPayload(assetRows) {
  const photos = [];
  let video = null;
  const videoPostersByContentId = new Map();

  for (const row of assetRows || []) {
    const role = String(row?.role || "");
    const contentId = String(row?.content_item_id || row?.contentId || row?.id || "");
    const publicUrl = String(row?.public_url || "").trim();
    if (!contentId || !publicUrl) continue;
    if (role === "video_poster") {
      videoPostersByContentId.set(contentId, publicUrl);
    }
  }

  for (const row of assetRows || []) {
    const role = String(row?.role || "");
    if (!["gallery_item", "video_original", "video_stream"].includes(role)) continue;
    const publicUrl = String(row?.public_url || "").trim();
    if (!publicUrl) continue;
    const mimeType = String(row?.mime_type || "").toLowerCase();
    const contentId = String(row?.content_item_id || "");
    const item = {
      id: contentId,
      url: publicUrl,
      thumbnailUrl: "",
      mimeType,
      durationSeconds: Number(row?.duration_seconds || 0),
      order: Number(row?.asset_order || 0),
    };
    if (mimeType.startsWith("image/")) {
      photos.push(item);
    } else if (!video && mimeType.startsWith("video/")) {
      video = {
        ...item,
        thumbnailUrl: videoPostersByContentId.get(contentId) || "",
      };
    }
  }

  return {
    photos: photos
      .sort((a, b) => a.order - b.order || Number(a.id) - Number(b.id))
      .slice(0, profileMediaMaxPhotos),
    video,
    maxPhotos: profileMediaMaxPhotos,
    maxVideos: profileMediaMaxVideos,
  };
}

async function fetchProfileMediaPayload(userId) {
  const [assetRows] = await pool.query(
    `SELECT c.id AS content_item_id, c.kind, c.body, a.role, a.asset_order, a.public_url, a.mime_type
     FROM content_items c
     JOIN content_assets a ON a.content_item_id = c.id
     WHERE c.user_id = ?
       AND c.visibility = ?
       AND c.status = 'published'
       AND c.deleted_at IS NULL
       AND a.role IN ('gallery_item', 'video_original', 'video_stream', 'video_poster')
     ORDER BY c.created_at ASC, c.id ASC, a.asset_order ASC, a.id ASC`,
    [userId, profileMediaVisibility]
  );
  return buildProfileMediaPayload(assetRows);
}

async function countProfileMedia(userId) {
  const [rows] = await pool.query(
    `SELECT
       SUM(CASE WHEN a.mime_type LIKE 'image/%' THEN 1 ELSE 0 END) AS photo_count,
       SUM(CASE WHEN a.mime_type LIKE 'video/%' THEN 1 ELSE 0 END) AS video_count
     FROM content_items c
     JOIN content_assets a ON a.content_item_id = c.id
     WHERE c.user_id = ?
       AND c.visibility = ?
       AND c.status = 'published'
       AND c.deleted_at IS NULL
       AND a.role IN ('gallery_item', 'video_original', 'video_stream')`,
    [userId, profileMediaVisibility]
  );
  const row = rows?.[0] || {};
  return {
    photos: Number(row.photo_count || 0),
    videos: Number(row.video_count || 0),
  };
}

async function createProfileMediaItem({ userId, kind, publicUrl, storageKey, mimeType, byteSize, durationSeconds = 0 }) {
  const [result] = await pool.query(
    `INSERT INTO content_items
     (user_id, kind, status, title, summary, body, visibility, source_locale, translation_targets_json, published_at)
     VALUES (?, ?, 'published', ?, NULL, ?, ?, 'und', '[]', NOW())`,
    [
      userId,
      kind,
      kind === "video" ? "Profile video" : "Profile photo",
      durationSeconds > 0 ? JSON.stringify({ durationSeconds }) : null,
      profileMediaVisibility,
    ]
  );
  const contentId = Number(result.insertId);
  await upsertContentAsset({
    contentId,
    role: "gallery_item",
    assetOrder: 0,
    storageKey,
    publicUrl,
    mimeType,
    byteSize,
  });
  return contentId;
}

app.get("/users/:id/profile-media", requireAuth, async (req, res) => {
  try {
    const ownerUserId = Number(req.params.id);
    if (!ownerUserId) {
      return res.status(400).json({ message: "Invalid user id." });
    }
    const payload = await fetchProfileMediaPayload(ownerUserId);
    return res.json({ ok: true, profileMedia: payload });
  } catch (e) {
    if (e?.code === "ER_NO_SUCH_TABLE") {
      return res.status(503).json({
        code: "CONTENT_SCHEMA_MISSING",
        message: "Content tables are not ready. Run the content migration.",
      });
    }
    console.error(e);
    return res.status(500).json({ message: "Failed to load profile media." });
  }
});

app.post(
  "/me/profile-media/photos",
  requireAuth,
  profileMediaUpload.single("photo"),
  async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      if (!req.file) {
        return res.status(400).json({ message: "Attach a profile photo to upload." });
      }
      const mimeType = String(req.file.mimetype || "").toLowerCase();
      if (!mimeType.startsWith("image/")) {
        removeUploadByPublicUrl(`/uploads/${req.file.filename}`);
        return res.status(400).json({ message: "Profile photos must be image files." });
      }
      const counts = await countProfileMedia(userId);
      if (counts.photos >= profileMediaMaxPhotos) {
        removeUploadByPublicUrl(`/uploads/${req.file.filename}`);
        return res.status(409).json({
          code: "PROFILE_PHOTO_LIMIT",
          message: `You can share up to ${profileMediaMaxPhotos} profile photos.`,
        });
      }
      const publicUrl = `/uploads/${req.file.filename}`;
      await createProfileMediaItem({
        userId,
        kind: "image",
        publicUrl,
        storageKey: req.file.path,
        mimeType: req.file.mimetype,
        byteSize: Number(req.file.size || 0),
      });
      const payload = await fetchProfileMediaPayload(userId);
      return res.status(201).json({ ok: true, profileMedia: payload });
    } catch (e) {
      if (e?.code === "ER_NO_SUCH_TABLE") {
        return res.status(503).json({
          code: "CONTENT_SCHEMA_MISSING",
          message: "Content tables are not ready. Run the content migration.",
        });
      }
      console.error(e);
      return res.status(500).json({ message: "Failed to upload profile photo." });
    }
  }
);

app.post(
  "/me/profile-media/video",
  requireAuth,
  profileMediaUpload.single("video"),
  async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      if (!req.file) {
        return res.status(400).json({ message: "Attach a profile video to upload." });
      }
      const mimeType = String(req.file.mimetype || "").toLowerCase();
      if (!mimeType.startsWith("video/")) {
        removeUploadByPublicUrl(`/uploads/${req.file.filename}`);
        return res.status(400).json({ message: "Profile video must be a video file." });
      }
      const durationSeconds = Number(req.body?.durationSeconds || 0);
      if (Number.isFinite(durationSeconds) && durationSeconds > profileMediaMaxVideoSeconds) {
        removeUploadByPublicUrl(`/uploads/${req.file.filename}`);
        return res.status(400).json({
          code: "PROFILE_VIDEO_TOO_LONG",
          message: `Profile video must be ${profileMediaMaxVideoSeconds} seconds or shorter.`,
        });
      }
      const counts = await countProfileMedia(userId);
      if (counts.videos >= profileMediaMaxVideos) {
        removeUploadByPublicUrl(`/uploads/${req.file.filename}`);
        return res.status(409).json({
          code: "PROFILE_VIDEO_LIMIT",
          message: `You can share only ${profileMediaMaxVideos} profile video.`,
        });
      }
      const publicUrl = `/uploads/${req.file.filename}`;
      await createProfileMediaItem({
        userId,
        kind: "video",
        publicUrl,
        storageKey: req.file.path,
        mimeType: req.file.mimetype,
        byteSize: Number(req.file.size || 0),
        durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
      });
      const payload = await fetchProfileMediaPayload(userId);
      return res.status(201).json({ ok: true, profileMedia: payload });
    } catch (e) {
      if (e?.code === "ER_NO_SUCH_TABLE") {
        return res.status(503).json({
          code: "CONTENT_SCHEMA_MISSING",
          message: "Content tables are not ready. Run the content migration.",
        });
      }
      console.error(e);
      return res.status(500).json({ message: "Failed to upload profile video." });
    }
  }
);

app.delete("/me/profile-media/photos/:mediaId", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const contentId = Number(req.params.mediaId);
    if (!contentId) {
      return res.status(400).json({ message: "Invalid profile media id." });
    }
    const [assetRows] = await pool.query(
      `SELECT a.public_url
       FROM content_items c
       JOIN content_assets a ON a.content_item_id = c.id
       WHERE c.id = ?
         AND c.user_id = ?
         AND c.visibility = ?
         AND c.kind = 'image'
         AND c.deleted_at IS NULL`,
      [contentId, userId, profileMediaVisibility]
    );
    await pool.query(
      `UPDATE content_items
       SET deleted_at = NOW()
       WHERE id = ?
         AND user_id = ?
         AND visibility = ?
         AND kind = 'image'
       LIMIT 1`,
      [contentId, userId, profileMediaVisibility]
    );
    for (const row of assetRows || []) {
      removeUploadByPublicUrl(row.public_url);
    }
    return res.json({ ok: true, profileMedia: await fetchProfileMediaPayload(userId) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to delete profile photo." });
  }
});

app.delete("/me/profile-media/video", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const [assetRows] = await pool.query(
      `SELECT a.public_url
       FROM content_items c
       JOIN content_assets a ON a.content_item_id = c.id
       WHERE c.user_id = ?
         AND c.visibility = ?
         AND c.kind = 'video'
         AND c.deleted_at IS NULL`,
      [userId, profileMediaVisibility]
    );
    await pool.query(
      `UPDATE content_items
       SET deleted_at = NOW()
       WHERE user_id = ?
         AND visibility = ?
         AND kind = 'video'
         AND deleted_at IS NULL`,
      [userId, profileMediaVisibility]
    );
    for (const row of assetRows || []) {
      removeUploadByPublicUrl(row.public_url);
    }
    return res.json({ ok: true, profileMedia: await fetchProfileMediaPayload(userId) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to delete profile video." });
  }
});

app.post("/content/posts", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const kind = parseContentKind(req.body?.kind);
    if (!kind) {
      return res.status(400).json({ code: "INVALID_KIND", message: "Invalid content kind." });
    }
    if (kind === "audio") {
      return res.status(400).json({
        code: "AUDIO_MOVED_TO_PODCASTS",
        message: "Audio posts now belong in Podcasts.",
      });
    }

    const capability = await resolveUserVideoCapabilityById(userId);
    if (!capability.ok) {
      return res.status(404).json({ code: "USER_NOT_FOUND", message: "User not found." });
    }
    if (!capability.canPublishVideo) {
      return res.status(403).json({
        code: "CREATOR_ONLY",
        message: "Only content creators can post to Talkiz.",
      });
    }

    const title = String(req.body?.title || "").trim().slice(0, 512);
    const summary = String(req.body?.summary || "").trim() || null;
    const body = String(req.body?.body || "").trim() || null;
    const sourceLocale = String(req.body?.sourceLocale || "und").trim().slice(0, 16) || "und";
    const translationTargets = parseTranslationTargets(req.body?.translationTargets);
    const visibility = String(req.body?.visibility || "public").trim() === "unlisted"
      ? "unlisted"
      : "public";
    const initialStatus = kind === "text" ? "published" : "draft";

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
      if (!["audio", "image", "video"].includes(kind)) {
        return res.status(400).json({ code: "MEDIA_NOT_SUPPORTED", message: "This post kind does not accept media." });
      }
      const mimeType = String(req.file.mimetype || "").toLowerCase();
      const assetOrderRaw = Number(req.body?.order ?? 0);
      const assetOrder = Number.isFinite(assetOrderRaw)
        ? Math.max(0, Math.min(Math.trunc(assetOrderRaw), 99))
        : 0;

      let role = "gallery_item";
      let mimeAllowed = false;
      if (kind === "audio") {
        role = "audio_track";
        mimeAllowed = mimeType.startsWith("audio/");
      } else if (kind === "image") {
        mimeAllowed = mimeType.startsWith("image/");
      } else if (kind === "video") {
        mimeAllowed = mimeType.startsWith("image/") || mimeType.startsWith("video/");
      }

      if (!mimeAllowed) {
        return res.status(400).json({
          code: "INVALID_MEDIA_TYPE",
          message:
            kind === "video"
              ? "Expected image or video file type."
              : `Expected ${kind} file type.`,
        });
      }

      const publicUrl = `/uploads/${req.file.filename}`;
      const normalizedAssetOrder = role === "audio_track" ? 0 : assetOrder;
      await upsertContentAsset({
        contentId,
        role,
        assetOrder: normalizedAssetOrder,
        storageKey: req.file.path,
        publicUrl,
        mimeType: req.file.mimetype,
        byteSize: Number(req.file.size || 0),
      });
      if (kind === "video" && mimeType.startsWith("video/")) {
        try {
          const derivatives = await buildVideoDerivatives(req.file, {
            assetOrder: normalizedAssetOrder,
          });
          if (derivatives) {
            await upsertContentAsset({
              contentId,
              role: "video_stream",
              assetOrder: normalizedAssetOrder,
              storageKey: derivatives.streamPath,
              publicUrl: derivatives.streamPublicUrl,
              mimeType: derivatives.streamMimeType,
              byteSize: derivatives.streamByteSize,
            });
            await upsertContentAsset({
              contentId,
              role: "video_poster",
              assetOrder: normalizedAssetOrder,
              storageKey: derivatives.posterPath,
              publicUrl: derivatives.posterPublicUrl,
              mimeType: derivatives.posterMimeType,
              byteSize: derivatives.posterByteSize,
            });
            await upsertContentAsset({
              contentId,
              role: "video_teaser",
              assetOrder: normalizedAssetOrder,
              storageKey: derivatives.teaserPath,
              publicUrl: derivatives.teaserPublicUrl,
              mimeType: derivatives.teaserMimeType,
              byteSize: derivatives.teaserByteSize,
            });
          }
        } catch (videoProcessingError) {
          console.error("Failed to build post video derivatives", videoProcessingError);
        }
      }

      await pool.query(
        `UPDATE content_items
         SET status='published',
             published_at = COALESCE(published_at, NOW())
         WHERE id = ?
         LIMIT 1`,
        [contentId]
      );
      if (kind === "video" && mimeType.startsWith("video/")) {
        const sourceAsset = await getTranscriptSourceAsset(contentId);
        if (sourceAsset?.storage_key) {
          await queueSourceTranscriptJob({
            contentId,
            requestedByUserId: userId,
            sourceAssetId: Number(sourceAsset.id || 0) || null,
          });
        }
      }

      return res.json({
        ok: true,
        content: { id: String(contentId), status: "published" },
        asset: {
          role,
          order: normalizedAssetOrder,
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

app.get("/content/posts", requireAuth, async (req, res) => {
  try {
    const viewerId = Number(req.user.sub);
    const limit = parseBoundedInt(req.query?.limit, 20, 1, 50);
    const cursor = decodeContentCursor(req.query?.cursor);
    const cursorFilter = buildCursorFilter({
      cursor,
      timeExpression: "COALESCE(c.published_at, c.created_at)",
      idExpression: "c.id",
    });
    const [rawRows] = await pool.query(
      `SELECT c.id, c.user_id, c.kind, c.title, c.summary, c.body, c.source_locale, c.created_at, c.published_at,
              COALESCE(c.published_at, c.created_at) AS cursor_timestamp,
              u.display_name, u.username, u.profile_photo_url,
              (COALESCE(like_counts.like_count, 0) + COALESCE(synthetic_like_counts.count_value, 0)) AS like_count,
              COALESCE(comment_counts.comment_count, 0) AS comment_count,
              (COALESCE(view_counts.view_count, 0) + COALESCE(synthetic_view_counts.count_value, 0)) AS view_count,
              CASE WHEN viewer_likes.user_id IS NULL THEN 0 ELSE 1 END AS liked_by_me,
              CASE WHEN viewer_saves.user_id IS NULL THEN 0 ELSE 1 END AS saved_by_me
       FROM content_items c
       INNER JOIN users u ON u.id = c.user_id
       LEFT JOIN (
         SELECT content_item_id, COUNT(*) AS like_count
         FROM content_likes
         GROUP BY content_item_id
       ) like_counts ON like_counts.content_item_id = c.id
     LEFT JOIN synthetic_metric_adjustments synthetic_like_counts
       ON synthetic_like_counts.target_type = 'content'
      AND synthetic_like_counts.metric = 'likes'
      AND synthetic_like_counts.target_id = c.id
       LEFT JOIN (
         SELECT content_item_id, COUNT(*) AS comment_count
         FROM content_comments
         WHERE deleted_at IS NULL
         GROUP BY content_item_id
       ) comment_counts ON comment_counts.content_item_id = c.id
       LEFT JOIN (
         SELECT content_item_id, COUNT(*) AS view_count
         FROM content_views
         GROUP BY content_item_id
       ) view_counts ON view_counts.content_item_id = c.id
     LEFT JOIN synthetic_metric_adjustments synthetic_view_counts
       ON synthetic_view_counts.target_type = 'content'
      AND synthetic_view_counts.metric = 'views'
      AND synthetic_view_counts.target_id = c.id
       LEFT JOIN content_likes viewer_likes
         ON viewer_likes.content_item_id = c.id
        AND viewer_likes.user_id = ?
       LEFT JOIN content_saves viewer_saves
         ON viewer_saves.content_item_id = c.id
        AND viewer_saves.user_id = ?
       WHERE c.status = 'published'
         AND c.deleted_at IS NULL
         AND COALESCE(c.visibility, 'public') <> 'profile_media'
         AND (
           COALESCE(u.can_publish_video, 0) = 1
           OR LOWER(COALESCE(u.role, '')) = 'creator'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM content_hides h
           WHERE h.content_item_id = c.id
             AND h.user_id = ?
         )
         AND (
           c.kind IN ('text', 'image')
           OR (
             c.kind = 'video'
             AND EXISTS (
               SELECT 1
               FROM content_assets a
               WHERE a.content_item_id = c.id
                 AND a.role IN ('gallery_item', 'video_original', 'video_stream')
             )
           )
       )${cursorFilter.sql}
       ORDER BY c.published_at DESC, c.id DESC
       LIMIT ?`,
      [viewerId, viewerId, viewerId, ...cursorFilter.params, limit + 1]
    );
    const { items: postRows, pageInfo } = takePageRows(rawRows, limit);
    const itemsById = new Map();
    for (const row of postRows) {
      const id = String(row.id);
      itemsById.set(id, {
        id,
        userId: String(row.user_id),
        authorName: row.display_name || "User",
        authorUsername: row.username || "",
        authorProfilePhotoUrl: row.profile_photo_url || "",
        kind: row.kind || "text",
        title: row.title || "",
        summary: row.summary || "",
        body: row.body || "",
        sourceLocale: row.source_locale || "und",
        assets: [],
        mediaUrl: "",
        mediaMimeType: "",
        likeCount: Number(row.like_count || 0),
        commentCount: Number(row.comment_count || 0),
        viewCount: Number(row.view_count || 0),
        likedByMe: Number(row.liked_by_me || 0) === 1,
        savedByMe: Number(row.saved_by_me || 0) === 1,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
      });
    }
    if (postRows.length > 0) {
      const contentIds = postRows.map((row) => Number(row.id)).filter(Boolean);
      const placeholders = contentIds.map(() => "?").join(",");
      const [assetRows] = await pool.query(
        `SELECT content_item_id, role, asset_order, public_url, mime_type
         FROM content_assets
         WHERE content_item_id IN (${placeholders})
           AND role IN ('gallery_item', 'video_original', 'video_stream', 'video_poster')
         ORDER BY content_item_id ASC,
                  asset_order ASC,
                  CASE role
                    WHEN 'video_stream' THEN 0
                    WHEN 'video_original' THEN 1
                    WHEN 'gallery_item' THEN 2
                    WHEN 'video_poster' THEN 3
                    ELSE 9
                  END,
                  id ASC`,
        contentIds
      );
      const assetRowsByItem = new Map();
      for (const row of assetRows) {
        const key = String(row.content_item_id || "");
        if (!assetRowsByItem.has(key)) {
          assetRowsByItem.set(key, []);
        }
        assetRowsByItem.get(key).push(row);
      }
      for (const [contentId, rowsForItem] of assetRowsByItem.entries()) {
        const item = itemsById.get(contentId);
        if (!item) continue;
        const media = buildPostAssetPayload(rowsForItem);
        item.assets = media.assets;
        item.mediaUrl = media.mediaUrl;
        item.mediaMimeType = media.mediaMimeType;
      }
    }
    return res.json({
      ok: true,
      items: Array.from(itemsById.values()),
      pageInfo,
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

app.get("/users/:id/posts", requireAuth, async (req, res) => {
  try {
    const viewerId = Number(req.user.sub);
    const ownerUserId = Number(req.params.id);
    const limit = parseBoundedInt(req.query?.limit, 50, 1, 100);
    const cursor = decodeContentCursor(req.query?.cursor);
    const cursorFilter = buildCursorFilter({
      cursor,
      timeExpression: "COALESCE(c.published_at, c.created_at)",
      idExpression: "c.id",
    });
    if (!ownerUserId) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    const [rawRows] = await pool.query(
      `SELECT c.id, c.user_id, c.kind, c.title, c.summary, c.body, c.source_locale, c.created_at, c.published_at,
              COALESCE(c.published_at, c.created_at) AS cursor_timestamp,
              u.display_name, u.username, u.profile_photo_url,
              (COALESCE(like_counts.like_count, 0) + COALESCE(synthetic_like_counts.count_value, 0)) AS like_count,
              COALESCE(comment_counts.comment_count, 0) AS comment_count,
              (COALESCE(view_counts.view_count, 0) + COALESCE(synthetic_view_counts.count_value, 0)) AS view_count,
              CASE WHEN viewer_likes.user_id IS NULL THEN 0 ELSE 1 END AS liked_by_me,
              CASE WHEN viewer_saves.user_id IS NULL THEN 0 ELSE 1 END AS saved_by_me
       FROM content_items c
       INNER JOIN users u ON u.id = c.user_id
       LEFT JOIN (
         SELECT content_item_id, COUNT(*) AS like_count
         FROM content_likes
         GROUP BY content_item_id
       ) like_counts ON like_counts.content_item_id = c.id
     LEFT JOIN synthetic_metric_adjustments synthetic_like_counts
       ON synthetic_like_counts.target_type = 'content'
      AND synthetic_like_counts.metric = 'likes'
      AND synthetic_like_counts.target_id = c.id
       LEFT JOIN (
         SELECT content_item_id, COUNT(*) AS comment_count
         FROM content_comments
         WHERE deleted_at IS NULL
         GROUP BY content_item_id
       ) comment_counts ON comment_counts.content_item_id = c.id
       LEFT JOIN (
         SELECT content_item_id, COUNT(*) AS view_count
         FROM content_views
         GROUP BY content_item_id
       ) view_counts ON view_counts.content_item_id = c.id
     LEFT JOIN synthetic_metric_adjustments synthetic_view_counts
       ON synthetic_view_counts.target_type = 'content'
      AND synthetic_view_counts.metric = 'views'
      AND synthetic_view_counts.target_id = c.id
       LEFT JOIN content_likes viewer_likes
         ON viewer_likes.content_item_id = c.id
        AND viewer_likes.user_id = ?
       LEFT JOIN content_saves viewer_saves
         ON viewer_saves.content_item_id = c.id
        AND viewer_saves.user_id = ?
       WHERE c.user_id = ?
         AND c.status = 'published'
         AND c.deleted_at IS NULL
         AND COALESCE(c.visibility, 'public') <> 'profile_media'
         AND (
           COALESCE(u.can_publish_video, 0) = 1
           OR LOWER(COALESCE(u.role, '')) = 'creator'
         )
         AND (
           c.kind IN ('text', 'image')
           OR (
             c.kind = 'video'
             AND EXISTS (
               SELECT 1
               FROM content_assets a
               WHERE a.content_item_id = c.id
                 AND a.role IN ('gallery_item', 'video_original', 'video_stream')
             )
           )
       )${cursorFilter.sql}
       ORDER BY c.published_at DESC, c.id DESC
       LIMIT ?`,
      [viewerId, viewerId, ownerUserId, ...cursorFilter.params, limit + 1]
    );
    const { items: postRows, pageInfo } = takePageRows(rawRows, limit);

    const itemsById = new Map();
    for (const row of postRows) {
      const id = String(row.id);
      itemsById.set(id, {
        id,
        userId: String(row.user_id),
        authorName: row.display_name || "User",
        authorUsername: row.username || "",
        authorProfilePhotoUrl: row.profile_photo_url || "",
        kind: row.kind || "text",
        title: row.title || "",
        summary: row.summary || "",
        body: row.body || "",
        sourceLocale: row.source_locale || "und",
        assets: [],
        mediaUrl: "",
        mediaMimeType: "",
        likeCount: Number(row.like_count || 0),
        commentCount: Number(row.comment_count || 0),
        viewCount: Number(row.view_count || 0),
        likedByMe: Number(row.liked_by_me || 0) === 1,
        savedByMe: Number(row.saved_by_me || 0) === 1,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
      });
    }
    if (postRows.length > 0) {
      const contentIds = postRows.map((row) => Number(row.id)).filter(Boolean);
      const placeholders = contentIds.map(() => "?").join(",");
      const [assetRows] = await pool.query(
        `SELECT content_item_id, role, asset_order, public_url, mime_type
         FROM content_assets
         WHERE content_item_id IN (${placeholders})
           AND role IN ('gallery_item', 'video_original', 'video_stream', 'video_poster')
         ORDER BY content_item_id ASC,
                  asset_order ASC,
                  CASE role
                    WHEN 'video_stream' THEN 0
                    WHEN 'video_original' THEN 1
                    WHEN 'gallery_item' THEN 2
                    WHEN 'video_poster' THEN 3
                    ELSE 9
                  END,
                  id ASC`,
        contentIds
      );
      const assetRowsByItem = new Map();
      for (const row of assetRows) {
        const key = String(row.content_item_id || "");
        if (!assetRowsByItem.has(key)) {
          assetRowsByItem.set(key, []);
        }
        assetRowsByItem.get(key).push(row);
      }
      for (const [contentId, rowsForItem] of assetRowsByItem.entries()) {
        const item = itemsById.get(contentId);
        if (!item) continue;
        const media = buildPostAssetPayload(rowsForItem);
        item.assets = media.assets;
        item.mediaUrl = media.mediaUrl;
        item.mediaMimeType = media.mediaMimeType;
      }
    }

    return res.json({
      ok: true,
      items: Array.from(itemsById.values()),
      pageInfo,
    });
  } catch (e) {
    if (e?.code === "ER_NO_SUCH_TABLE") {
      return res.status(503).json({
        code: "CONTENT_SCHEMA_MISSING",
        message: "Content tables are not ready. Run the content migration.",
      });
    }
    console.error(e);
    return res.status(500).json({ message: "Failed to load user posts." });
  }
});

app.get("/users/:id/podcasts", requireAuth, async (req, res) => {
  try {
    const viewerId = Number(req.user.sub);
    const ownerUserId = Number(req.params.id);
    const limit = parseBoundedInt(req.query?.limit, 50, 1, 100);
    const cursor = decodeContentCursor(req.query?.cursor);
    const cursorFilter = buildCursorFilter({
      cursor,
      timeExpression: "COALESCE(c.published_at, c.created_at)",
      idExpression: "c.id",
    });
    if (!ownerUserId) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    const [rawRows] = await pool.query(
      `SELECT c.id, c.user_id, c.kind, c.title, c.summary, c.body, c.source_locale, c.created_at, c.published_at,
              COALESCE(c.published_at, c.created_at) AS cursor_timestamp,
              u.display_name, u.username, u.profile_photo_url,
              (COALESCE(like_counts.like_count, 0) + COALESCE(synthetic_like_counts.count_value, 0)) AS like_count,
              COALESCE(comment_counts.comment_count, 0) AS comment_count,
              (COALESCE(view_counts.view_count, 0) + COALESCE(synthetic_view_counts.count_value, 0)) AS view_count,
              CASE WHEN viewer_likes.user_id IS NULL THEN 0 ELSE 1 END AS liked_by_me,
              CASE WHEN viewer_saves.user_id IS NULL THEN 0 ELSE 1 END AS saved_by_me
       FROM content_items c
       INNER JOIN users u ON u.id = c.user_id
       LEFT JOIN (
         SELECT content_item_id, COUNT(*) AS like_count
         FROM content_likes
         GROUP BY content_item_id
       ) like_counts ON like_counts.content_item_id = c.id
       LEFT JOIN synthetic_metric_adjustments synthetic_like_counts
         ON synthetic_like_counts.target_type = 'content'
        AND synthetic_like_counts.metric = 'likes'
        AND synthetic_like_counts.target_id = c.id
       LEFT JOIN (
         SELECT content_item_id, COUNT(*) AS comment_count
         FROM content_comments
         WHERE deleted_at IS NULL
         GROUP BY content_item_id
       ) comment_counts ON comment_counts.content_item_id = c.id
       LEFT JOIN (
         SELECT content_item_id, COUNT(*) AS view_count
         FROM content_views
         GROUP BY content_item_id
       ) view_counts ON view_counts.content_item_id = c.id
       LEFT JOIN synthetic_metric_adjustments synthetic_view_counts
         ON synthetic_view_counts.target_type = 'content'
        AND synthetic_view_counts.metric = 'views'
        AND synthetic_view_counts.target_id = c.id
       LEFT JOIN content_likes viewer_likes
         ON viewer_likes.content_item_id = c.id
        AND viewer_likes.user_id = ?
       LEFT JOIN content_saves viewer_saves
         ON viewer_saves.content_item_id = c.id
        AND viewer_saves.user_id = ?
       WHERE c.user_id = ?
         AND c.status = 'published'
         AND c.deleted_at IS NULL
         AND (
           COALESCE(u.can_publish_video, 0) = 1
           OR LOWER(COALESCE(u.role, '')) = 'creator'
         )
         AND (
           c.kind = 'podcast'
           OR (
             c.kind = 'audio'
             AND EXISTS (
               SELECT 1
               FROM content_assets a
               WHERE a.content_item_id = c.id
                 AND a.role = 'audio_track'
             )
           )
         )${cursorFilter.sql}
       ORDER BY c.published_at DESC, c.id DESC
       LIMIT ?`,
      [viewerId, viewerId, ownerUserId, ...cursorFilter.params, limit + 1]
    );
    const { items: rows, pageInfo } = takePageRows(rawRows, limit);
    const itemsById = new Map();
    for (const row of rows) {
      const id = String(row.id);
      itemsById.set(id, {
        id,
        userId: String(row.user_id),
        kind: "podcast",
        authorName: row.display_name || "User",
        authorUsername: row.username || "",
        authorProfilePhotoUrl: row.profile_photo_url || "",
        title: row.title || "",
        summary: row.summary || "",
        body: row.body || "",
        sourceLocale: row.source_locale || "und",
        coverUrl: "",
        audioUrl: "",
        audioMimeType: "",
        transcriptStatus: "none",
        transcriptErrorMessage: "",
        transcripts: [],
        likeCount: Number(row.like_count || 0),
        commentCount: Number(row.comment_count || 0),
        viewCount: Number(row.view_count || 0),
        likedByMe: Number(row.liked_by_me || 0) === 1,
        savedByMe: Number(row.saved_by_me || 0) === 1,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
      });
    }
    if (rows.length > 0) {
      const contentIds = rows.map((row) => Number(row.id)).filter(Boolean);
      const placeholders = contentIds.map(() => "?").join(",");
      const [assetRows] = await pool.query(
        `SELECT content_item_id, role, public_url, mime_type
         FROM content_assets
         WHERE content_item_id IN (${placeholders})
           AND role IN ('podcast_cover', 'podcast_audio', 'audio_track')
         ORDER BY content_item_id ASC,
                  CASE role
                    WHEN 'podcast_cover' THEN 0
                    WHEN 'podcast_audio' THEN 1
                    WHEN 'audio_track' THEN 2
                    ELSE 9
                  END,
                  id ASC`,
        contentIds
      );
      for (const row of assetRows) {
        const item = itemsById.get(String(row.content_item_id));
        if (!item || !row.public_url) continue;
        const role = String(row.role || "");
        if (role === "podcast_cover" && !item.coverUrl) {
          item.coverUrl = row.public_url || "";
        }
        if ((role === "podcast_audio" || role === "audio_track") && !item.audioUrl) {
          item.audioUrl = row.public_url || "";
          item.audioMimeType = row.mime_type || "";
        }
      }
      const [transcriptRows] = await pool.query(
        `SELECT id, content_item_id, kind, language_code, source_language_code, status, segments_json, created_at, updated_at
         FROM content_transcripts
         WHERE content_item_id IN (${placeholders})
         ORDER BY kind ASC, language_code ASC, id ASC`,
        contentIds
      );
      const hasSourceTranscript = new Set();
      for (const row of transcriptRows || []) {
        const item = itemsById.get(String(row.content_item_id));
        if (!item) continue;
        const built = buildTranscriptTrackResponse(row);
        if (built.kind === "source") {
          hasSourceTranscript.add(String(row.content_item_id));
        }
        item.transcripts.push({
          id: built.id,
          kind: built.kind,
          languageCode: built.languageCode,
          sourceLanguageCode: built.sourceLanguageCode,
          status: built.status,
          segmentCount: built.segmentCount,
          createdAt: built.createdAt,
          updatedAt: built.updatedAt,
        });
      }
      const [jobRows] = await pool.query(
        `SELECT content_item_id, status, error_message
         FROM content_transcript_jobs
         WHERE content_item_id IN (${placeholders})`,
        contentIds
      );
      const jobsByContentId = new Map(
        (jobRows || []).map((row) => [String(row.content_item_id), row])
      );
      for (const item of itemsById.values()) {
        if (hasSourceTranscript.has(item.id)) {
          item.transcriptStatus = "ready";
          item.transcriptErrorMessage = "";
          continue;
        }
        const job = jobsByContentId.get(item.id);
        item.transcriptStatus = normalizeTranscriptJobStatus(job?.status, "none");
        item.transcriptErrorMessage = String(job?.error_message || "");
      }
    }

    return res.json({
      ok: true,
      items: Array.from(itemsById.values()),
      pageInfo,
    });
  } catch (e) {
    if (e?.code === "ER_NO_SUCH_TABLE") {
      return res.status(503).json({
        code: "CONTENT_SCHEMA_MISSING",
        message: "Content tables are not ready. Run the content migration.",
      });
    }
    console.error(e);
    return res.status(500).json({ message: "Failed to load user podcasts." });
  }
});

app.post("/content/podcasts", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const capability = await resolveUserVideoCapabilityById(userId);
    if (!capability.ok) {
      return res.status(404).json({ code: "USER_NOT_FOUND", message: "User not found." });
    }
    if (!capability.canPublishVideo) {
      return res.status(403).json({
        code: "CREATOR_ONLY",
        message: "Only content creators can publish podcasts.",
      });
    }
    const title = String(req.body?.title || "").trim().slice(0, 512);
    const summary = String(req.body?.summary || "").trim();
    const body = String(req.body?.body || "").trim() || null;
    const sourceLocale = String(req.body?.sourceLocale || "und").trim().slice(0, 16) || "und";
    const translationTargets = parseTranslationTargets(req.body?.translationTargets);
    const visibility = String(req.body?.visibility || "public").trim() === "unlisted"
      ? "unlisted"
      : "public";

    if (!title) {
      return res.status(400).json({ code: "TITLE_REQUIRED", message: "Title is required." });
    }
    if (!summary) {
      return res.status(400).json({
        code: "SUMMARY_REQUIRED",
        message: "A short description is required.",
      });
    }

    const [result] = await pool.query(
      `INSERT INTO content_items
       (user_id, kind, status, title, summary, body, visibility, source_locale, translation_targets_json)
       VALUES (?, 'podcast', 'draft', ?, ?, ?, ?, ?, ?)`,
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
        kind: "podcast",
        status: "draft",
        title,
        summary,
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
    return res.status(500).json({ message: "Failed to create podcast draft." });
  }
});

app.post(
  "/content/podcasts/:id/upload-cover",
  requireAuth,
  postMediaUpload.single("cover"),
  async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      const contentId = Number(req.params.id);
      if (!contentId) {
        return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid podcast id." });
      }
      if (!req.file) {
        return res.status(400).json({ code: "COVER_REQUIRED", message: "Cover image is required." });
      }
      const mimeType = String(req.file.mimetype || "").toLowerCase();
      if (!mimeType.startsWith("image/")) {
        return res.status(400).json({
          code: "INVALID_COVER_TYPE",
          message: "Expected an image file for the podcast cover.",
        });
      }

      const [rows] = await pool.query(
        `SELECT id, user_id, kind
         FROM content_items
         WHERE id = ?
         LIMIT 1`,
        [contentId]
      );
      const content = rows?.[0];
      if (!content) {
        return res.status(404).json({ code: "PODCAST_NOT_FOUND", message: "Podcast not found." });
      }
      if (Number(content.user_id) !== userId) {
        return res.status(403).json({ code: "NOT_OWNER", message: "Only the owner can upload a cover." });
      }
      if (String(content.kind || "") !== "podcast") {
        return res.status(400).json({ code: "NOT_A_PODCAST", message: "This content item is not a podcast." });
      }

      const publicUrl = `/uploads/${req.file.filename}`;
      await pool.query(
        `INSERT INTO content_assets
         (content_item_id, role, asset_order, storage_provider, storage_key, public_url, mime_type, byte_size)
         VALUES (?, 'podcast_cover', 0, 'local', ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           storage_key = VALUES(storage_key),
           public_url = VALUES(public_url),
           mime_type = VALUES(mime_type),
           byte_size = VALUES(byte_size)`,
        [
          contentId,
          req.file.path,
          publicUrl,
          req.file.mimetype,
          Number(req.file.size || 0),
        ]
      );

      return res.json({
        ok: true,
        asset: {
          role: "podcast_cover",
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
      return res.status(500).json({ message: "Failed to upload podcast cover." });
    }
  }
);

app.post(
  "/content/podcasts/:id/upload-audio",
  requireAuth,
  podcastAudioUpload.single("audio"),
  async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      const contentId = Number(req.params.id);
      if (!contentId) {
        return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid podcast id." });
      }
      if (!req.file) {
        return res.status(400).json({ code: "AUDIO_REQUIRED", message: "Audio file is required." });
      }
      const mimeType = String(req.file.mimetype || "").toLowerCase();
      if (!mimeType.startsWith("audio/")) {
        return res.status(400).json({
          code: "INVALID_AUDIO_TYPE",
          message: "Expected an audio file for the podcast.",
        });
      }

      const [rows] = await pool.query(
        `SELECT id, user_id, kind
         FROM content_items
         WHERE id = ?
         LIMIT 1`,
        [contentId]
      );
      const content = rows?.[0];
      if (!content) {
        return res.status(404).json({ code: "PODCAST_NOT_FOUND", message: "Podcast not found." });
      }
      if (Number(content.user_id) !== userId) {
        return res.status(403).json({ code: "NOT_OWNER", message: "Only the owner can upload podcast audio." });
      }
      if (String(content.kind || "") !== "podcast") {
        return res.status(400).json({ code: "NOT_A_PODCAST", message: "This content item is not a podcast." });
      }

      const publicUrl = `/uploads/${req.file.filename}`;
      const teaserDerivative = await buildAudioTeaserDerivative(req.file.path);
      await pool.query(
        `INSERT INTO content_assets
         (content_item_id, role, asset_order, storage_provider, storage_key, public_url, mime_type, byte_size)
         VALUES (?, 'podcast_audio', 0, 'local', ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           storage_key = VALUES(storage_key),
           public_url = VALUES(public_url),
           mime_type = VALUES(mime_type),
           byte_size = VALUES(byte_size)`,
        [
          contentId,
          req.file.path,
          publicUrl,
          req.file.mimetype,
          Number(req.file.size || 0),
        ]
      );
      if (teaserDerivative) {
        await upsertContentAsset({
          contentId,
          role: "audio_teaser",
          assetOrder: 0,
          storageKey: teaserDerivative.filePath,
          publicUrl: teaserDerivative.publicUrl,
          mimeType: teaserDerivative.mimeType,
          byteSize: teaserDerivative.byteSize,
        });
      }

      return res.json({
        ok: true,
        asset: {
          role: "podcast_audio",
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
      return res.status(500).json({ message: "Failed to upload podcast audio." });
    }
  }
);

app.post("/content/podcasts/:id/publish", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid podcast id." });
    }

    const [rows] = await pool.query(
      `SELECT id, user_id, kind, title, summary
       FROM content_items
       WHERE id = ?
       LIMIT 1`,
      [contentId]
    );
    const content = rows?.[0];
    if (!content) {
      return res.status(404).json({ code: "PODCAST_NOT_FOUND", message: "Podcast not found." });
    }
    if (Number(content.user_id) !== userId) {
      return res.status(403).json({ code: "NOT_OWNER", message: "Only the owner can publish this podcast." });
    }
    if (String(content.kind || "") !== "podcast") {
      return res.status(400).json({ code: "NOT_A_PODCAST", message: "This content item is not a podcast." });
    }
    if (!String(content.title || "").trim()) {
      return res.status(400).json({ code: "TITLE_REQUIRED", message: "Title is required." });
    }
    if (!String(content.summary || "").trim()) {
      return res.status(400).json({
        code: "SUMMARY_REQUIRED",
        message: "A short description is required.",
      });
    }

    const [assetRows] = await pool.query(
      `SELECT role
       FROM content_assets
       WHERE content_item_id = ?
         AND role IN ('podcast_cover', 'podcast_audio')`,
      [contentId]
    );
    const roles = new Set((assetRows || []).map((row) => String(row.role || "")));
    if (!roles.has("podcast_cover")) {
      return res.status(400).json({
        code: "PODCAST_COVER_REQUIRED",
        message: "A podcast cover image is required before publishing.",
      });
    }
    if (!roles.has("podcast_audio")) {
      return res.status(400).json({
        code: "PODCAST_AUDIO_REQUIRED",
        message: "A podcast audio file is required before publishing.",
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
      content: { id: String(contentId), kind: "podcast", status: "published" },
    });
  } catch (e) {
    if (e?.code === "ER_NO_SUCH_TABLE") {
      return res.status(503).json({
        code: "CONTENT_SCHEMA_MISSING",
        message: "Content tables are not ready. Run the content migration.",
      });
    }
    console.error(e);
    return res.status(500).json({ message: "Failed to publish podcast." });
  }
});

app.get("/content/podcasts", requireAuth, async (req, res) => {
  try {
    const viewerId = Number(req.user.sub);
    const limit = parseBoundedInt(req.query?.limit, 20, 1, 50);
    const cursor = decodeContentCursor(req.query?.cursor);
    const cursorFilter = buildCursorFilter({
      cursor,
      timeExpression: "COALESCE(c.published_at, c.created_at)",
      idExpression: "c.id",
    });
    const [rawRows] = await pool.query(
      `SELECT c.id, c.user_id, c.kind, c.title, c.summary, c.body, c.source_locale, c.created_at, c.published_at,
              COALESCE(c.published_at, c.created_at) AS cursor_timestamp,
              u.display_name, u.username, u.profile_photo_url,
              (COALESCE(like_counts.like_count, 0) + COALESCE(synthetic_like_counts.count_value, 0)) AS like_count,
              COALESCE(comment_counts.comment_count, 0) AS comment_count,
              (COALESCE(view_counts.view_count, 0) + COALESCE(synthetic_view_counts.count_value, 0)) AS view_count,
              CASE WHEN viewer_likes.user_id IS NULL THEN 0 ELSE 1 END AS liked_by_me,
              CASE WHEN viewer_saves.user_id IS NULL THEN 0 ELSE 1 END AS saved_by_me
       FROM content_items c
       INNER JOIN users u ON u.id = c.user_id
       LEFT JOIN (
         SELECT content_item_id, COUNT(*) AS like_count
         FROM content_likes
         GROUP BY content_item_id
       ) like_counts ON like_counts.content_item_id = c.id
     LEFT JOIN synthetic_metric_adjustments synthetic_like_counts
       ON synthetic_like_counts.target_type = 'content'
      AND synthetic_like_counts.metric = 'likes'
      AND synthetic_like_counts.target_id = c.id
       LEFT JOIN (
         SELECT content_item_id, COUNT(*) AS comment_count
         FROM content_comments
         WHERE deleted_at IS NULL
         GROUP BY content_item_id
       ) comment_counts ON comment_counts.content_item_id = c.id
       LEFT JOIN (
         SELECT content_item_id, COUNT(*) AS view_count
         FROM content_views
         GROUP BY content_item_id
       ) view_counts ON view_counts.content_item_id = c.id
     LEFT JOIN synthetic_metric_adjustments synthetic_view_counts
       ON synthetic_view_counts.target_type = 'content'
      AND synthetic_view_counts.metric = 'views'
      AND synthetic_view_counts.target_id = c.id
       LEFT JOIN content_likes viewer_likes
         ON viewer_likes.content_item_id = c.id
        AND viewer_likes.user_id = ?
       LEFT JOIN content_saves viewer_saves
         ON viewer_saves.content_item_id = c.id
        AND viewer_saves.user_id = ?
       WHERE c.status = 'published'
         AND c.deleted_at IS NULL
         AND (
           COALESCE(u.can_publish_video, 0) = 1
           OR LOWER(COALESCE(u.role, '')) = 'creator'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM content_hides h
           WHERE h.content_item_id = c.id
             AND h.user_id = ?
         )
         AND (
           c.kind = 'podcast'
           OR (
             c.kind = 'audio'
             AND EXISTS (
               SELECT 1
               FROM content_assets a
               WHERE a.content_item_id = c.id
                 AND a.role = 'audio_track'
             )
           )
       )${cursorFilter.sql}
       ORDER BY c.published_at DESC, c.id DESC
       LIMIT ?`,
      [viewerId, viewerId, viewerId, ...cursorFilter.params, limit + 1]
    );
    const { items: rows, pageInfo } = takePageRows(rawRows, limit);
    const itemsById = new Map();
    for (const row of rows) {
      const id = String(row.id);
      itemsById.set(id, {
        id,
        userId: String(row.user_id),
        kind: "podcast",
        authorName: row.display_name || "User",
        authorUsername: row.username || "",
        authorProfilePhotoUrl: row.profile_photo_url || "",
        title: row.title || "",
        summary: row.summary || "",
        body: row.body || "",
        sourceLocale: row.source_locale || "und",
        coverUrl: "",
        audioUrl: "",
        audioMimeType: "",
        transcriptStatus: "none",
        transcriptErrorMessage: "",
        transcripts: [],
        likeCount: Number(row.like_count || 0),
        commentCount: Number(row.comment_count || 0),
        viewCount: Number(row.view_count || 0),
        likedByMe: Number(row.liked_by_me || 0) === 1,
        savedByMe: Number(row.saved_by_me || 0) === 1,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
      });
    }
    if (rows.length > 0) {
      const contentIds = rows.map((row) => Number(row.id)).filter(Boolean);
      const placeholders = contentIds.map(() => "?").join(",");
      const [assetRows] = await pool.query(
        `SELECT content_item_id, role, public_url, mime_type
         FROM content_assets
         WHERE content_item_id IN (${placeholders})
           AND role IN ('podcast_cover', 'podcast_audio', 'audio_track')
         ORDER BY content_item_id ASC,
                  CASE role
                    WHEN 'podcast_cover' THEN 0
                    WHEN 'podcast_audio' THEN 1
                    WHEN 'audio_track' THEN 2
                    ELSE 9
                  END,
                  id ASC`,
        contentIds
      );
      for (const row of assetRows) {
        const item = itemsById.get(String(row.content_item_id));
        if (!item || !row.public_url) continue;
        const role = String(row.role || "");
        if (role === "podcast_cover" && !item.coverUrl) {
          item.coverUrl = row.public_url || "";
        }
        if ((role === "podcast_audio" || role === "audio_track") && !item.audioUrl) {
          item.audioUrl = row.public_url || "";
          item.audioMimeType = row.mime_type || "";
        }
      }
      const [transcriptRows] = await pool.query(
        `SELECT id, content_item_id, kind, language_code, source_language_code, status, segments_json, created_at, updated_at
         FROM content_transcripts
         WHERE content_item_id IN (${placeholders})
         ORDER BY kind ASC, language_code ASC, id ASC`,
        contentIds
      );
      const hasSourceTranscript = new Set();
      for (const row of transcriptRows || []) {
        const item = itemsById.get(String(row.content_item_id));
        if (!item) continue;
        const built = buildTranscriptTrackResponse(row);
        if (built.kind === "source") {
          hasSourceTranscript.add(String(row.content_item_id));
        }
        item.transcripts.push({
          id: built.id,
          kind: built.kind,
          languageCode: built.languageCode,
          sourceLanguageCode: built.sourceLanguageCode,
          status: built.status,
          segmentCount: built.segmentCount,
          createdAt: built.createdAt,
          updatedAt: built.updatedAt,
        });
      }
      const [jobRows] = await pool.query(
        `SELECT content_item_id, status, error_message
         FROM content_transcript_jobs
         WHERE content_item_id IN (${placeholders})`,
        contentIds
      );
      const jobsByContentId = new Map(
        (jobRows || []).map((row) => [String(row.content_item_id), row])
      );
      for (const item of itemsById.values()) {
        if (hasSourceTranscript.has(item.id)) {
          item.transcriptStatus = "ready";
          item.transcriptErrorMessage = "";
          continue;
        }
        const job = jobsByContentId.get(item.id);
        item.transcriptStatus = normalizeTranscriptJobStatus(job?.status, "none");
        item.transcriptErrorMessage = String(job?.error_message || "");
      }
    }
    return res.json({
      ok: true,
      items: Array.from(itemsById.values()),
      pageInfo,
    });
  } catch (e) {
    if (e?.code === "ER_NO_SUCH_TABLE") {
      return res.status(503).json({
        code: "CONTENT_SCHEMA_MISSING",
        message: "Content tables are not ready. Run the content migration.",
      });
    }
    console.error(e);
    return res.status(500).json({ message: "Failed to load podcasts." });
  }
});

app.post("/content/items/:id/view", requireAuth, async (req, res) => {
  try {
    const viewerId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid content id." });
    }
    const item = await getContentItemById(contentId);
    if (!isContentItemVisibleForEngagement(item)) {
      return res.status(404).json({ code: "CONTENT_NOT_FOUND", message: "Content not found." });
    }
    await pool.query(
      `INSERT IGNORE INTO content_views (content_item_id, user_id) VALUES (?, ?)`,
      [contentId, viewerId]
    );
    const viewCount = await getContentMetricCountWithSynthetic(contentId, "views");
    return res.json({ ok: true, viewCount: viewCount.total });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to record content view." });
  }
});

app.post("/content/items/:id/like", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid content id." });
    }
    const item = await getContentItemById(contentId);
    if (!isContentItemVisibleForEngagement(item)) {
      return res.status(404).json({ code: "CONTENT_NOT_FOUND", message: "Content not found." });
    }
    const [likeResult] = await pool.query(
      `INSERT IGNORE INTO content_likes (content_item_id, user_id) VALUES (?, ?)`,
      [contentId, userId]
    );
    if (Number(likeResult?.affectedRows || 0) > 0 && Number(item.user_id) !== userId) {
      const actor = await loadNotificationActor(userId);
      const label = contentNotificationLabel(item);
      await createUserNotification({
        userId: Number(item.user_id),
        type: `${contentNotificationKind(item)}_like`,
        title: `New ${label} like`,
        body: `${actor.displayName} liked your ${label}.`,
        fromUserId: userId,
        fromDisplayName: actor.displayName,
        fromPhotoUrl: actor.profilePhotoUrl,
        targetId: String(contentId),
      });
    }
    const likeCount = await getContentMetricCountWithSynthetic(contentId, "likes");
    return res.json({
      ok: true,
      likedByMe: true,
      likeCount: likeCount.total,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to like content." });
  }
});

app.delete("/content/items/:id/like", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid content id." });
    }
    await pool.query(
      `DELETE FROM content_likes WHERE content_item_id = ? AND user_id = ?`,
      [contentId, userId]
    );
    const likeCount = await getContentMetricCountWithSynthetic(contentId, "likes");
    return res.json({
      ok: true,
      likedByMe: false,
      likeCount: likeCount.total,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to unlike content." });
  }
});

app.post("/content/items/:id/hide", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid content id." });
    }
    const item = await getContentItemById(contentId);
    if (!isContentItemVisibleForEngagement(item)) {
      return res.status(404).json({ code: "CONTENT_NOT_FOUND", message: "Content not found." });
    }
    await pool.query(
      `INSERT IGNORE INTO content_hides (content_item_id, user_id) VALUES (?, ?)`,
      [contentId, userId]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to hide content." });
  }
});

app.get("/content/items/:id", requireAuth, async (req, res) => {
  try {
    const viewerId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid content id." });
    }
    const item = await getPublishedContentItemDetail(contentId, viewerId);
    if (!item) {
      return res.status(404).json({ code: "CONTENT_NOT_FOUND", message: "Content not found." });
    }
    return res.json({ ok: true, item });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load content." });
  }
});

app.get("/me/content/saved-ids", requireAuth, async (req, res) => {
  try {
    const viewerId = Number(req.user.sub);
    const limit = parseBoundedInt(req.query?.limit, 200, 1, 1000);
    const [rows] = await pool.query(
      `SELECT s.content_item_id
       FROM content_saves s
       INNER JOIN content_items c
         ON c.id = s.content_item_id
       WHERE s.user_id = ?
         AND c.status = 'published'
         AND c.deleted_at IS NULL
       ORDER BY s.created_at DESC, s.content_item_id DESC
       LIMIT ?`,
      [viewerId, limit]
    );
    return res.json({
      ok: true,
      ids: rows.map((row) => String(row.content_item_id)),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load saved content." });
  }
});

app.post("/content/items/:id/save", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid content id." });
    }
    const item = await getContentItemById(contentId);
    if (!isContentItemVisibleForEngagement(item)) {
      return res.status(404).json({ code: "CONTENT_NOT_FOUND", message: "Content not found." });
    }
    await pool.query(
      `INSERT IGNORE INTO content_saves (content_item_id, user_id) VALUES (?, ?)`,
      [contentId, userId]
    );
    return res.json({ ok: true, savedByMe: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to save content." });
  }
});

app.delete("/content/items/:id/save", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid content id." });
    }
    await pool.query(
      `DELETE FROM content_saves WHERE content_item_id = ? AND user_id = ?`,
      [contentId, userId]
    );
    return res.json({ ok: true, savedByMe: false });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to unsave content." });
  }
});

app.post("/content/items/:id/share-link", requireAuth, async (req, res) => {
  try {
    const viewerId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({
        code: "INVALID_CONTENT_ID",
        message: "Invalid content id.",
      });
    }

    const item = await getContentItemById(contentId);
    if (!isContentItemVisibleForEngagement(item)) {
      return res.status(404).json({
        code: "CONTENT_NOT_FOUND",
        message: "Content not found.",
      });
    }

    const shareLink = await getOrCreateContentShareLink({
      contentId,
      createdByUserId: viewerId,
    });
    const preview = await buildPublicSharedContentPreview({
      contentId,
      token: shareLink.public_token,
      shareLink,
    });

    if (!preview) {
      return res.status(404).json({
        code: "CONTENT_NOT_FOUND",
        message: "Content not found.",
      });
    }

    return res.json({
      ok: true,
      share: {
        token: String(shareLink.public_token || ""),
        shareUrl: preview.shareUrl,
        webPreviewUrl: preview.webPreviewUrl,
        appShareUrl: preview.appShareUrl,
        nativeAppUrl: preview.nativeAppUrl,
        previewSeconds: Number(preview.previewSeconds || publicSharePreviewSeconds),
        entityType: preview.entityType,
        entityId: preview.entityId,
        shareKind: preview.shareKind,
        contentId: preview.contentId,
        canonicalRoute: buildAuthenticatedSharedContentRoute(preview.shareKind, preview.contentId),
      },
      item: preview,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to create share link." });
  }
});

app.post("/share/live/:broadcastId", requireAuth, async (req, res) => {
  try {
    const viewerId = Number(req.user.sub);
    const broadcastId = String(req.params.broadcastId || "").trim();
    if (!broadcastId) {
      return res.status(400).json({
        code: "INVALID_BROADCAST_ID",
        message: "Invalid broadcast id.",
      });
    }
    const isPrivate = req.body?.isPrivate === true;
    const expiresAt = isPrivate
      ? new Date(Date.now() + 24 * 60 * 60 * 1000)
      : null;
    const metadata = {
      title: String(req.body?.title || "").trim().slice(0, 160),
      description: String(req.body?.description || "").trim().slice(0, 500),
      roomType: String(req.body?.roomType || "").trim().slice(0, 32),
      hostName: String(req.body?.hostName || "").trim().slice(0, 160),
      hostProfilePhotoUrl: String(req.body?.hostProfilePhotoUrl || "").trim().slice(0, 500),
      isPrivate,
    };
    const shareLink = await getOrCreateGenericShareLink({
      entityType: "live",
      entityId: broadcastId,
      createdByUserId: viewerId,
      metadata,
      expiresAt,
    });
    const canonicalRoute = buildLiveCanonicalRoute(broadcastId);
    return res.json({
      ok: true,
      share: buildShareResponse(shareLink, {
        shareKind: "live",
        canonicalRoute,
      }),
      item: buildLiveSharePreview(shareLink),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to create live share link." });
  }
});

app.post("/share/profile/:userId", requireAuth, async (req, res) => {
  try {
    const viewerId = Number(req.user.sub);
    const profileUserId = Number(req.params.userId);
    if (!profileUserId) {
      return res.status(400).json({
        code: "INVALID_PROFILE_ID",
        message: "Invalid profile id.",
      });
    }
    const [[user]] = await pool.query(
      `SELECT id
       FROM users
       WHERE id = ?
         AND deleted_at IS NULL
       LIMIT 1`,
      [profileUserId]
    );
    if (!user?.id) {
      return res.status(404).json({
        code: "PROFILE_NOT_FOUND",
        message: "Profile was not found.",
      });
    }
    const shareLink = await getOrCreateGenericShareLink({
      entityType: "profile",
      entityId: String(profileUserId),
      createdByUserId: viewerId,
    });
    const preview = await buildProfileSharePreview(shareLink);
    return res.json({
      ok: true,
      share: buildShareResponse(shareLink, {
        shareKind: "profile",
        canonicalRoute: buildProfileCanonicalRoute(profileUserId),
      }),
      item: preview,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to create profile share link." });
  }
});

app.get("/content/items/:id/comments", requireAuth, async (req, res) => {
  try {
    const viewerId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid content id." });
    }
    const item = await getContentItemById(contentId);
    if (!isContentItemVisibleForEngagement(item)) {
      return res.status(404).json({ code: "CONTENT_NOT_FOUND", message: "Content not found." });
    }
    const [rows] = await pool.query(
      `SELECT c.id,
              c.user_id,
              c.body,
              c.created_at,
              c.parent_comment_id,
              u.display_name,
              parent_u.display_name AS reply_to_name,
              COALESCE(comment_like_counts.like_count, 0) AS like_count,
              CASE WHEN viewer_comment_likes.user_id IS NULL THEN 0 ELSE 1 END AS liked_by_me
       FROM content_comments c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN content_comments parent_c
         ON parent_c.id = c.parent_comment_id
        AND parent_c.deleted_at IS NULL
       LEFT JOIN users parent_u ON parent_u.id = parent_c.user_id
       LEFT JOIN (
         SELECT comment_id, COUNT(*) AS like_count
         FROM content_comment_likes
         GROUP BY comment_id
       ) comment_like_counts ON comment_like_counts.comment_id = c.id
       LEFT JOIN content_comment_likes viewer_comment_likes
         ON viewer_comment_likes.comment_id = c.id
        AND viewer_comment_likes.user_id = ?
       WHERE c.content_item_id = ?
         AND c.deleted_at IS NULL
       ORDER BY c.created_at ASC, c.id ASC`,
      [viewerId, contentId]
    );
    return res.json({
      ok: true,
      items: rows.map((row) => ({
        id: String(row.id),
        userId: String(row.user_id),
        authorName: row.display_name || "User",
        body: row.body || "",
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        parentId: row.parent_comment_id == null ? null : String(row.parent_comment_id),
        replyToName: row.reply_to_name || null,
        likeCount: Number(row.like_count || 0),
        likedByMe: Number(row.liked_by_me || 0) === 1,
      })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load comments." });
  }
});

app.post("/content/items/:id/comments", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    const body = String(req.body?.body || "").trim();
    const parentIdRaw = req.body?.parentId;
    const parentId = parentIdRaw == null || String(parentIdRaw).trim().isEmpty
      ? null
      : Number(parentIdRaw);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid content id." });
    }
    if (!body) {
      return res.status(400).json({ code: "COMMENT_REQUIRED", message: "Comment cannot be empty." });
    }
    if (parentId != null && !Number.isFinite(parentId)) {
      return res.status(400).json({ code: "INVALID_PARENT_COMMENT_ID", message: "Invalid parent comment id." });
    }
    const item = await getContentItemById(contentId);
    if (!isContentItemVisibleForEngagement(item)) {
      return res.status(404).json({ code: "CONTENT_NOT_FOUND", message: "Content not found." });
    }
    let replyToName = null;
    let replyOwnerId = null;
    if (parentId != null) {
      const [[parentRow]] = await pool.query(
        `SELECT c.id, c.user_id, u.display_name
         FROM content_comments c
         LEFT JOIN users u ON u.id = c.user_id
         WHERE c.id = ?
           AND c.content_item_id = ?
           AND c.deleted_at IS NULL
         LIMIT 1`,
        [parentId, contentId]
      );
      if (!parentRow?.id) {
        return res.status(404).json({
          code: "PARENT_COMMENT_NOT_FOUND",
          message: "Reply target not found.",
        });
      }
      replyToName = parentRow.display_name || "User";
      replyOwnerId = Number(parentRow.user_id || 0) || null;
    }
    const [result] = await pool.query(
      `INSERT INTO content_comments (content_item_id, user_id, parent_comment_id, body) VALUES (?, ?, ?, ?)`,
      [contentId, userId, parentId, body.slice(0, 2000)]
    );
    const [[commentRow]] = await pool.query(
      `SELECT c.id,
              c.user_id,
              c.body,
              c.created_at,
              c.parent_comment_id,
              u.display_name,
              parent_u.display_name AS reply_to_name
       FROM content_comments c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN content_comments parent_c
         ON parent_c.id = c.parent_comment_id
        AND parent_c.deleted_at IS NULL
       LEFT JOIN users parent_u ON parent_u.id = parent_c.user_id
       WHERE c.id = ?
       LIMIT 1`,
      [result.insertId]
    );
    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS count
       FROM content_comments
       WHERE content_item_id = ?
         AND deleted_at IS NULL`,
      [contentId]
    );
    const actor = await loadNotificationActor(userId);
    const label = contentNotificationLabel(item);
    if (Number(item.user_id) !== userId) {
      await createUserNotification({
        userId: Number(item.user_id),
        type: `${contentNotificationKind(item)}_comment`,
        title: `New ${label} comment`,
        body: `${actor.displayName} commented on your ${label}.`,
        fromUserId: userId,
        fromDisplayName: actor.displayName,
        fromPhotoUrl: actor.profilePhotoUrl,
        targetId: String(contentId),
      });
    }
    if (
      replyOwnerId != null &&
      replyOwnerId !== userId &&
      replyOwnerId !== Number(item.user_id)
    ) {
      await createUserNotification({
        userId: replyOwnerId,
        type: `${contentNotificationKind(item)}_comment_reply`,
        title: "New reply",
        body: `${actor.displayName} replied to your comment.`,
        fromUserId: userId,
        fromDisplayName: actor.displayName,
        fromPhotoUrl: actor.profilePhotoUrl,
        targetId: String(contentId),
      });
    }
    return res.status(201).json({
      ok: true,
      comment: {
        id: String(commentRow.id),
        userId: String(commentRow.user_id),
        authorName: commentRow.display_name || "User",
        body: commentRow.body || "",
        createdAt: commentRow.created_at ? new Date(commentRow.created_at).toISOString() : null,
        parentId: commentRow.parent_comment_id == null ? null : String(commentRow.parent_comment_id),
        replyToName: commentRow.reply_to_name || replyToName,
        likeCount: 0,
        likedByMe: false,
      },
      commentCount: Number(countRow?.count || 0),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to add comment." });
  }
});

app.post("/content/comments/:id/like", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const commentId = Number(req.params.id);
    if (!commentId) {
      return res.status(400).json({ code: "INVALID_COMMENT_ID", message: "Invalid comment id." });
    }
    const [[commentRow]] = await pool.query(
      `SELECT c.id, c.content_item_id, c.user_id
       FROM content_comments c
       WHERE c.id = ?
         AND c.deleted_at IS NULL
       LIMIT 1`,
      [commentId]
    );
    if (!commentRow?.id) {
      return res.status(404).json({ code: "COMMENT_NOT_FOUND", message: "Comment not found." });
    }
    const item = await getContentItemById(Number(commentRow.content_item_id));
    if (!isContentItemVisibleForEngagement(item)) {
      return res.status(404).json({ code: "CONTENT_NOT_FOUND", message: "Content not found." });
    }
    const [likeResult] = await pool.query(
      `INSERT IGNORE INTO content_comment_likes (comment_id, user_id) VALUES (?, ?)`,
      [commentId, userId]
    );
    if (Number(likeResult?.affectedRows || 0) > 0 && Number(commentRow.user_id) !== userId) {
      const actor = await loadNotificationActor(userId);
      await createUserNotification({
        userId: Number(commentRow.user_id),
        type: `${contentNotificationKind(item)}_comment_like`,
        title: "New comment like",
        body: `${actor.displayName} liked your comment.`,
        fromUserId: userId,
        fromDisplayName: actor.displayName,
        fromPhotoUrl: actor.profilePhotoUrl,
        targetId: String(item.id),
      });
    }
    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS count FROM content_comment_likes WHERE comment_id = ?`,
      [commentId]
    );
    return res.json({
      ok: true,
      likedByMe: true,
      likeCount: Number(countRow?.count || 0),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to like comment." });
  }
});

app.delete("/content/comments/:id/like", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const commentId = Number(req.params.id);
    if (!commentId) {
      return res.status(400).json({ code: "INVALID_COMMENT_ID", message: "Invalid comment id." });
    }
    await pool.query(
      `DELETE FROM content_comment_likes WHERE comment_id = ? AND user_id = ?`,
      [commentId, userId]
    );
    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS count FROM content_comment_likes WHERE comment_id = ?`,
      [commentId]
    );
    return res.json({
      ok: true,
      likedByMe: false,
      likeCount: Number(countRow?.count || 0),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to unlike comment." });
  }
});

app.patch("/content/items/:id", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid content id." });
    }
    const item = await getContentItemById(contentId);
    if (!item || item.deleted_at) {
      return res.status(404).json({ code: "CONTENT_NOT_FOUND", message: "Content not found." });
    }
    if (Number(item.user_id) !== userId) {
      return res.status(403).json({ code: "NOT_OWNER", message: "Only the owner can edit this content." });
    }
    const title = String(req.body?.title ?? item.title ?? "").trim().slice(0, 512);
    const summary = String(req.body?.summary ?? item.summary ?? "").trim() || null;
    const body = String(req.body?.body ?? item.body ?? "").trim() || null;
    if (!title) {
      return res.status(400).json({ code: "TITLE_REQUIRED", message: "Title is required." });
    }
    if (String(item.kind || "") === "podcast" && !summary) {
      return res.status(400).json({
        code: "SUMMARY_REQUIRED",
        message: "A short description is required.",
      });
    }
    await pool.query(
      `UPDATE content_items
       SET title = ?, summary = ?, body = ?
       WHERE id = ?
       LIMIT 1`,
      [title, summary, body, contentId]
    );
    return res.json({
      ok: true,
      content: {
        id: String(contentId),
        title,
        summary: summary || "",
        body: body || "",
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to edit content." });
  }
});

app.delete("/content/items/:id", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid content id." });
    }
    const item = await getContentItemById(contentId);
    if (!item || item.deleted_at) {
      return res.status(404).json({ code: "CONTENT_NOT_FOUND", message: "Content not found." });
    }
    if (Number(item.user_id) !== userId) {
      return res.status(403).json({ code: "NOT_OWNER", message: "Only the owner can delete this content." });
    }
    await pool.query(
      `UPDATE content_items
       SET deleted_at = NOW(), status = 'deleted'
       WHERE id = ?
       LIMIT 1`,
      [contentId]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to delete content." });
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

app.get("/share/:token/resolve", optionalAuth, async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) {
      return res.status(400).json({
        code: "INVALID_SHARE_TOKEN",
        message: "Invalid share token.",
      });
    }

    const shareLink = await getActiveContentShareLinkByToken(token);
    if (shareLink?.content_item_id) {
      const preview = await buildPublicSharedContentPreview({
        contentId: Number(shareLink.content_item_id),
        token,
        shareLink,
      });
      if (!preview) {
        return res.status(404).json({
          code: "SHARE_NOT_FOUND",
          message: "Shared content was not found.",
        });
      }

      const canonicalRoute = buildAuthenticatedSharedContentRoute(preview.shareKind, preview.contentId);
      const viewerId = Number(req.user?.sub || 0);

      if (viewerId > 0) {
        const detail = await getPublishedContentItemDetail(Number(preview.contentId), viewerId);
        if (detail) {
          return res.json({
            ok: true,
            resolution: {
              mode: "full_access",
              entityType: "content",
              entityId: preview.contentId,
              shareKind: preview.shareKind,
              contentId: preview.contentId,
              canonicalRoute,
              shareUrl: preview.shareUrl,
              webPreviewUrl: preview.webPreviewUrl,
              appShareUrl: preview.appShareUrl,
              nativeAppUrl: preview.nativeAppUrl,
            },
          });
        }
      }

      return res.json({
        ok: true,
        resolution: {
          mode: "preview_only",
          entityType: "content",
          entityId: preview.contentId,
          shareKind: preview.shareKind,
          contentId: preview.contentId,
          canonicalRoute,
          shareUrl: preview.shareUrl,
          webPreviewUrl: preview.webPreviewUrl,
          appShareUrl: preview.appShareUrl,
          nativeAppUrl: preview.nativeAppUrl,
        },
        item: preview,
      });
    }

    const genericShareLink = await getActiveGenericShareLinkByToken(token);
    if (!genericShareLink?.entity_id) {
      return res.status(404).json({
        code: "SHARE_NOT_FOUND",
        message: "Shared link was not found.",
      });
    }

    const entityType = normalizeShareEntityType(genericShareLink.entity_type);
    const preview = entityType === "profile"
      ? await buildProfileSharePreview(genericShareLink)
      : entityType === "live"
        ? buildLiveSharePreview(genericShareLink)
        : null;
    if (!preview) {
      return res.status(404).json({
        code: "SHARE_NOT_FOUND",
        message: "Shared link was not found.",
      });
    }

    const canonicalRoute = entityType === "profile"
      ? buildProfileCanonicalRoute(genericShareLink.entity_id)
      : buildLiveCanonicalRoute(genericShareLink.entity_id);
    const viewerId = Number(req.user?.sub || 0);

    if (viewerId > 0) {
      return res.json({
        ok: true,
        resolution: {
          mode: "full_access",
          entityType,
          entityId: String(genericShareLink.entity_id || ""),
          shareKind: entityType,
          contentId: "",
          canonicalRoute,
          shareUrl: preview.shareUrl,
          webPreviewUrl: preview.webPreviewUrl,
          appShareUrl: preview.appShareUrl,
          nativeAppUrl: preview.nativeAppUrl,
        },
      });
    }

    return res.json({
      ok: true,
      resolution: {
        mode: "preview_only",
        entityType,
        entityId: String(genericShareLink.entity_id || ""),
        shareKind: entityType,
        contentId: "",
        canonicalRoute,
        shareUrl: preview.shareUrl,
        webPreviewUrl: preview.webPreviewUrl,
        appShareUrl: preview.appShareUrl,
        nativeAppUrl: preview.nativeAppUrl,
      },
      item: preview,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to resolve shared content." });
  }
});

app.get("/share/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) {
      return res.status(400).json({
        code: "INVALID_SHARE_TOKEN",
        message: "Invalid share token.",
      });
    }

    const shareLink = await getActiveContentShareLinkByToken(token);
    if (shareLink?.content_item_id) {
      const preview = await buildPublicSharedContentPreview({
        contentId: Number(shareLink.content_item_id),
        token,
        shareLink,
      });
      if (!preview) {
        return res.status(404).json({
          code: "SHARE_NOT_FOUND",
          message: "Shared content was not found.",
        });
      }

      return res.json({
        ok: true,
        item: preview,
      });
    }

    const genericShareLink = await getActiveGenericShareLinkByToken(token);
    if (!genericShareLink?.entity_id) {
      return res.status(404).json({
        code: "SHARE_NOT_FOUND",
        message: "Shared link was not found.",
      });
    }

    const entityType = normalizeShareEntityType(genericShareLink.entity_type);
    const preview = entityType === "profile"
      ? await buildProfileSharePreview(genericShareLink)
      : entityType === "live"
        ? buildLiveSharePreview(genericShareLink)
        : null;
    if (!preview) {
      return res.status(404).json({
        code: "SHARE_NOT_FOUND",
        message: "Shared link was not found.",
      });
    }

    return res.json({
      ok: true,
      item: preview,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load shared content." });
  }
});

app.get("/content/videos", async (req, res) => {
  try {
    const limitRaw = Number(req.query?.limit || 20);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20;
    const [rows] = await pool.query(
      `SELECT c.id, c.title, c.summary, c.source_locale, c.created_at, c.published_at,
              COALESCE(stream_asset.public_url, original_asset.public_url, legacy_asset.public_url, '') AS video_url,
              COALESCE(stream_asset.mime_type, original_asset.mime_type, legacy_asset.mime_type, '') AS video_mime_type,
              COALESCE(poster_asset.public_url, '') AS poster_url
       FROM content_items c
       INNER JOIN users u ON u.id = c.user_id
       LEFT JOIN content_assets stream_asset
         ON stream_asset.content_item_id = c.id
        AND stream_asset.role = 'video_stream'
        AND stream_asset.asset_order = 0
       LEFT JOIN content_assets original_asset
         ON original_asset.content_item_id = c.id
        AND original_asset.role = 'video_original'
        AND original_asset.asset_order = 0
       LEFT JOIN content_assets legacy_asset
         ON legacy_asset.content_item_id = c.id
        AND legacy_asset.role = 'gallery_item'
        AND legacy_asset.asset_order = 0
       LEFT JOIN content_assets poster_asset
         ON poster_asset.content_item_id = c.id
        AND poster_asset.role = 'video_poster'
        AND poster_asset.asset_order = 0
       WHERE c.kind = 'video'
         AND c.status = 'published'
         AND c.deleted_at IS NULL
         AND (
           COALESCE(u.can_publish_video, 0) = 1
           OR LOWER(COALESCE(u.role, '')) = 'creator'
         )
       ORDER BY c.published_at DESC, c.id DESC
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
        videoUrl: row.video_url || "",
        posterUrl: row.poster_url || "",
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
    await upsertContentAsset({
      contentId,
      role: "video_original",
      assetOrder: 0,
      storageKey: req.file.path,
      publicUrl,
      mimeType: req.file.mimetype,
      byteSize: Number(req.file.size || 0),
    });
    try {
      const derivatives = await buildVideoDerivatives(req.file, { assetOrder: 0 });
      if (derivatives) {
        await upsertContentAsset({
          contentId,
          role: "video_stream",
          assetOrder: 0,
          storageKey: derivatives.streamPath,
          publicUrl: derivatives.streamPublicUrl,
          mimeType: derivatives.streamMimeType,
          byteSize: derivatives.streamByteSize,
        });
        await upsertContentAsset({
          contentId,
          role: "video_poster",
          assetOrder: 0,
          storageKey: derivatives.posterPath,
          publicUrl: derivatives.posterPublicUrl,
          mimeType: derivatives.posterMimeType,
          byteSize: derivatives.posterByteSize,
        });
        await upsertContentAsset({
          contentId,
          role: "video_teaser",
          assetOrder: 0,
          storageKey: derivatives.teaserPath,
          publicUrl: derivatives.teaserPublicUrl,
          mimeType: derivatives.teaserMimeType,
          byteSize: derivatives.teaserByteSize,
        });
      }
    } catch (videoProcessingError) {
      console.error("Failed to build creator video derivatives", videoProcessingError);
    }

    await pool.query(
      `UPDATE content_items
       SET status='ready'
       WHERE id = ?
       LIMIT 1`,
      [contentId]
    );
    const sourceAsset = await getTranscriptSourceAsset(contentId);
    if (sourceAsset?.storage_key) {
      await queueSourceTranscriptJob({
        contentId,
        requestedByUserId: userId,
        sourceAssetId: Number(sourceAsset.id || 0) || null,
      });
    }

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
    const sourceAsset = await getTranscriptSourceAsset(contentId);
    if (sourceAsset?.storage_key) {
      await queueSourceTranscriptJob({
        contentId,
        requestedByUserId: userId,
        sourceAssetId: Number(sourceAsset.id || 0) || null,
      });
    }

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
      `SELECT c.id, c.user_id, c.title, c.summary, c.body, c.source_locale, c.status, c.published_at, c.created_at,
              u.display_name
       FROM content_items c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.id = ? AND c.kind = 'video' AND c.deleted_at IS NULL
       LIMIT 1`,
      [contentId]
    );
    const row = rows?.[0];
    if (!row || String(row.status) !== "published") {
      return res.status(404).json({ code: "VIDEO_NOT_FOUND", message: "Video not found." });
    }
    const [assetRows] = await pool.query(
      `SELECT role, public_url, mime_type, byte_size
       FROM content_assets
       WHERE content_item_id = ?
         AND role IN ('video_stream', 'video_original', 'gallery_item', 'video_poster')
         AND asset_order = 0
       ORDER BY CASE role
                  WHEN 'video_stream' THEN 0
                  WHEN 'video_original' THEN 1
                  WHEN 'gallery_item' THEN 2
                  WHEN 'video_poster' THEN 3
                  ELSE 9
                END
       LIMIT 4`,
      [contentId]
    );
    let playbackAsset = null;
    let posterAsset = null;
    for (const assetRow of assetRows || []) {
      const role = String(assetRow.role || "");
      if (!playbackAsset && (role === "video_stream" || role === "video_original" || role === "gallery_item")) {
        playbackAsset = assetRow;
      }
      if (!posterAsset && role === "video_poster") {
        posterAsset = assetRow;
      }
    }
    const transcriptRows = await listTranscriptTrackRows(contentId);
    const sourceTranscript = transcriptRows.find(
      (track) => String(track?.kind || "") === "source"
    );
    const transcriptJobRow = await getTranscriptJobRow(contentId);
    const transcriptStatus = sourceTranscript
      ? "ready"
      : normalizeTranscriptJobStatus(transcriptJobRow?.status, "none");
    return res.json({
      ok: true,
      item: {
        id: String(row.id),
        userId: String(row.user_id),
        authorName: row.display_name || "User",
        title: row.title || "",
        summary: row.summary || "",
        body: row.body || "",
        sourceLocale: row.source_locale || "und",
        status: row.status || "published",
        videoUrl: playbackAsset?.public_url || "",
        posterUrl: posterAsset?.public_url || "",
        mimeType: playbackAsset?.mime_type || "",
        byteSize: Number(playbackAsset?.byte_size || 0),
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
        transcriptStatus,
        transcriptErrorMessage: sourceTranscript
          ? ""
          : String(transcriptJobRow?.error_message || ""),
        transcripts: transcriptRows.map((track) => {
          const built = buildTranscriptTrackResponse(track);
          return {
            id: built.id,
            kind: built.kind,
            languageCode: built.languageCode,
            sourceLanguageCode: built.sourceLanguageCode,
            status: built.status,
            segmentCount: built.segmentCount,
            createdAt: built.createdAt,
            updatedAt: built.updatedAt,
          };
        }),
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

app.get("/content/videos/:id/transcripts", requireAuth, async (req, res) => {
  try {
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid video id." });
    }
    const item = await getContentItemById(contentId);
    if (!item || item.deleted_at) {
      return res.status(404).json({ code: "VIDEO_NOT_FOUND", message: "Video not found." });
    }
    const viewerId = Number(req.user.sub);
    if (String(item.status || "") !== "published" && Number(item.user_id) !== viewerId) {
      return res.status(404).json({ code: "VIDEO_NOT_FOUND", message: "Video not found." });
    }
    const rows = await listTranscriptTrackRows(contentId);
    return res.json({
      ok: true,
      items: rows.map((track) => buildTranscriptTrackResponse(track)),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load transcripts." });
  }
});

app.get("/content/videos/:id/transcripts/:language", requireAuth, async (req, res) => {
  try {
    const contentId = Number(req.params.id);
    const languageCode = normalizeLanguageCode(req.params.language);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid video id." });
    }
    const item = await getContentItemById(contentId);
    if (!item || item.deleted_at) {
      return res.status(404).json({ code: "VIDEO_NOT_FOUND", message: "Video not found." });
    }
    const viewerId = Number(req.user.sub);
    if (String(item.status || "") !== "published" && Number(item.user_id) !== viewerId) {
      return res.status(404).json({ code: "VIDEO_NOT_FOUND", message: "Video not found." });
    }
    let track =
      (await getTranscriptTrackRow(contentId, languageCode, "translation")) ||
      (await getTranscriptTrackRow(contentId, languageCode, "source"));
    if (!track) {
      return res.status(404).json({
        code: "TRANSCRIPT_NOT_FOUND",
        message: "Transcript track not found for that language.",
      });
    }
    return res.json({
      ok: true,
      track: buildTranscriptTrackResponse(track),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load transcript." });
  }
});

app.patch("/content/videos/:id/transcripts/:language", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    const languageCode = normalizeLanguageCode(req.params.language);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid video id." });
    }
    const item = await getContentItemById(contentId);
    if (!item || item.deleted_at || String(item.kind || "") !== "video") {
      return res.status(404).json({ code: "VIDEO_NOT_FOUND", message: "Video not found." });
    }
    if (Number(item.user_id) !== userId) {
      return res.status(403).json({
        code: "NOT_OWNER",
        message: "Only the owner can edit subtitles.",
      });
    }
    const existingTrack =
      (await getTranscriptTrackRow(contentId, languageCode, "translation")) ||
      (await getTranscriptTrackRow(contentId, languageCode, "source"));
    if (!existingTrack) {
      return res.status(404).json({
        code: "TRANSCRIPT_NOT_FOUND",
        message: "Transcript track not found for that language.",
      });
    }
    const expectedUpdatedAt = String(req.body?.expectedUpdatedAt || "").trim();
    const currentUpdatedAt = existingTrack.updated_at
      ? new Date(existingTrack.updated_at).toISOString()
      : "";
    if (expectedUpdatedAt && currentUpdatedAt && expectedUpdatedAt !== currentUpdatedAt) {
      return res.status(409).json({
        code: "TRANSCRIPT_CONFLICT",
        message: "This transcript changed before your save completed. Reload and try again.",
      });
    }
    if (!Array.isArray(req.body?.segments)) {
      return res.status(400).json({
        code: "INVALID_TRANSCRIPT_SEGMENTS",
        message: "Subtitle segments are required.",
      });
    }
    const sanitizedSegments = validateEditableTranscriptSegments(req.body.segments);
    await pool.query(
      `UPDATE content_transcripts
       SET segments_json = ?, status = 'ready', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
       LIMIT 1`,
      [JSON.stringify(sanitizedSegments), Number(existingTrack.id)]
    );
    const refreshedTrack =
      (await getTranscriptTrackRow(contentId, languageCode, "translation")) ||
      (await getTranscriptTrackRow(contentId, languageCode, "source"));
    return res.json({
      ok: true,
      track: buildTranscriptTrackResponse(refreshedTrack),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      message: String(e?.message || "Failed to update transcript."),
    });
  }
});

app.post("/content/videos/:id/transcript/generate", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid video id." });
    }
    const item = await getContentItemById(contentId);
    if (!item || item.deleted_at || String(item.kind || "") !== "video") {
      return res.status(404).json({ code: "VIDEO_NOT_FOUND", message: "Video not found." });
    }
    const isOwner = Number(item.user_id) === userId;
    if (String(item.status || "") !== "published" && !isOwner) {
      return res.status(404).json({ code: "VIDEO_NOT_FOUND", message: "Video not found." });
    }
    const existingTrack = await getSourceTranscriptTrackRow(contentId);
    if (existingTrack) {
      await markSourceTranscriptJobReady({
        contentId,
        requestedByUserId: userId,
      });
      return res.json({
        ok: true,
        status: "ready",
        track: buildTranscriptTrackResponse(existingTrack),
      });
    }
    if (!isOpenAiTranslationEnabled()) {
      return res.status(503).json({
        code: "TRANSCRIPTION_NOT_CONFIGURED",
        message: "OpenAI transcription is not configured.",
      });
    }
    const asset = await getTranscriptSourceAsset(contentId);
    if (!asset?.storage_key) {
      return res.status(409).json({
        code: "VIDEO_SOURCE_ASSET_REQUIRED",
        message: "A video source file is required before generating a transcript.",
      });
    }
    const queued = await queueSourceTranscriptJob({
      contentId,
      requestedByUserId: userId,
      sourceAssetId: Number(asset.id || 0) || null,
    });
    if (queued.track) {
      return res.json({
        ok: true,
        status: "ready",
        track: buildTranscriptTrackResponse(queued.track),
      });
    }
    return res.status(202).json({
      ok: true,
      status: normalizeTranscriptJobStatus(queued.job?.status, "pending"),
      job: buildTranscriptJobResponse(queued.job),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      message: String(e?.message || "Failed to queue transcript generation."),
    });
  }
});

app.post("/content/videos/:id/transcripts/:language/translate", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    const targetLanguage = normalizeLanguageCode(req.params.language);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid video id." });
    }
    const item = await getContentItemById(contentId);
    if (!item || item.deleted_at || String(item.kind || "") !== "video") {
      return res.status(404).json({ code: "VIDEO_NOT_FOUND", message: "Video not found." });
    }
    if (Number(item.user_id) !== userId) {
      return res.status(403).json({ code: "NOT_OWNER", message: "Only the owner can translate transcripts." });
    }
    const sourceRows = await listTranscriptTrackRows(contentId);
    const sourceTrack =
      sourceRows
        .map((row) => buildTranscriptTrackResponse(row))
        .find((track) => track.kind === "source") || null;
    if (!sourceTrack) {
      return res.status(409).json({
        code: "SOURCE_TRANSCRIPT_REQUIRED",
        message: "Generate the source transcript before translating it.",
      });
    }
    if (sourceTrack.languageCode === targetLanguage) {
      return res.json({ ok: true, track: sourceTrack });
    }
    const existingTranslation =
      await getTranscriptTrackRow(contentId, targetLanguage, "translation");
    if (existingTranslation) {
      return res.json({
        ok: true,
        track: buildTranscriptTrackResponse(existingTranslation),
      });
    }
    const translatedSegments = await translateTranscriptSegmentsWithOpenAi({
      segments: sourceTrack.segments,
      sourceLanguage: sourceTrack.languageCode,
      targetLanguage,
    });
    await pool.query(
      `INSERT INTO content_transcripts
       (content_item_id, kind, language_code, source_language_code, status, segments_json)
       VALUES (?, 'translation', ?, ?, 'ready', ?)
       ON DUPLICATE KEY UPDATE
         source_language_code = VALUES(source_language_code),
         status = VALUES(status),
         segments_json = VALUES(segments_json),
         updated_at = CURRENT_TIMESTAMP`,
      [
        contentId,
        targetLanguage,
        sourceTrack.languageCode,
        JSON.stringify(translatedSegments),
      ]
    );
    const trackRow = await getTranscriptTrackRow(
      contentId,
      targetLanguage,
      "translation"
    );
    return res.json({
      ok: true,
      track: buildTranscriptTrackResponse(trackRow),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: String(e?.message || "Failed to translate transcript.") });
  }
});

app.get("/content/podcasts/:id/transcripts", requireAuth, async (req, res) => {
  try {
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid podcast id." });
    }
    const item = await getContentItemById(contentId);
    const itemKind = String(item?.kind || "").toLowerCase();
    if (!item || item.deleted_at || (itemKind !== "podcast" && itemKind !== "audio")) {
      return res.status(404).json({ code: "PODCAST_NOT_FOUND", message: "Podcast not found." });
    }
    const viewerId = Number(req.user.sub);
    if (String(item.status || "") !== "published" && Number(item.user_id) !== viewerId) {
      return res.status(404).json({ code: "PODCAST_NOT_FOUND", message: "Podcast not found." });
    }
    const rows = await listTranscriptTrackRows(contentId);
    return res.json({
      ok: true,
      items: rows.map((track) => buildTranscriptTrackResponse(track)),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load podcast transcripts." });
  }
});

app.get("/content/podcasts/:id/transcripts/:language", requireAuth, async (req, res) => {
  try {
    const contentId = Number(req.params.id);
    const languageCode = normalizeLanguageCode(req.params.language);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid podcast id." });
    }
    const item = await getContentItemById(contentId);
    const itemKind = String(item?.kind || "").toLowerCase();
    if (!item || item.deleted_at || (itemKind !== "podcast" && itemKind !== "audio")) {
      return res.status(404).json({ code: "PODCAST_NOT_FOUND", message: "Podcast not found." });
    }
    const viewerId = Number(req.user.sub);
    if (String(item.status || "") !== "published" && Number(item.user_id) !== viewerId) {
      return res.status(404).json({ code: "PODCAST_NOT_FOUND", message: "Podcast not found." });
    }
    let track =
      (await getTranscriptTrackRow(contentId, languageCode, "translation")) ||
      (await getTranscriptTrackRow(contentId, languageCode, "source"));
    if (!track) {
      return res.status(404).json({
        code: "TRANSCRIPT_NOT_FOUND",
        message: "Transcript track not found for that language.",
      });
    }
    return res.json({
      ok: true,
      track: buildTranscriptTrackResponse(track),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load podcast transcript." });
  }
});

app.patch("/content/podcasts/:id/transcripts/:language", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    const languageCode = normalizeLanguageCode(req.params.language);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid podcast id." });
    }
    const item = await getContentItemById(contentId);
    const itemKind = String(item?.kind || "").toLowerCase();
    if (!item || item.deleted_at || (itemKind !== "podcast" && itemKind !== "audio")) {
      return res.status(404).json({ code: "PODCAST_NOT_FOUND", message: "Podcast not found." });
    }
    if (Number(item.user_id) !== userId) {
      return res.status(403).json({
        code: "NOT_OWNER",
        message: "Only the owner can edit podcast subtitles.",
      });
    }
    const existingTrack =
      (await getTranscriptTrackRow(contentId, languageCode, "translation")) ||
      (await getTranscriptTrackRow(contentId, languageCode, "source"));
    if (!existingTrack) {
      return res.status(404).json({
        code: "TRANSCRIPT_NOT_FOUND",
        message: "Transcript track not found for that language.",
      });
    }
    const expectedUpdatedAt = String(req.body?.expectedUpdatedAt || "").trim();
    const currentUpdatedAt = existingTrack.updated_at
      ? new Date(existingTrack.updated_at).toISOString()
      : "";
    if (expectedUpdatedAt && currentUpdatedAt && expectedUpdatedAt !== currentUpdatedAt) {
      return res.status(409).json({
        code: "TRANSCRIPT_CONFLICT",
        message: "This transcript changed before your save completed. Reload and try again.",
      });
    }
    if (!Array.isArray(req.body?.segments)) {
      return res.status(400).json({
        code: "INVALID_TRANSCRIPT_SEGMENTS",
        message: "Subtitle segments are required.",
      });
    }
    const sanitizedSegments = validateEditableTranscriptSegments(req.body.segments);
    await pool.query(
      `UPDATE content_transcripts
       SET segments_json = ?, status = 'ready', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
       LIMIT 1`,
      [JSON.stringify(sanitizedSegments), Number(existingTrack.id)]
    );
    const refreshedTrack =
      (await getTranscriptTrackRow(contentId, languageCode, "translation")) ||
      (await getTranscriptTrackRow(contentId, languageCode, "source"));
    return res.json({
      ok: true,
      track: buildTranscriptTrackResponse(refreshedTrack),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      message: String(e?.message || "Failed to update podcast transcript."),
    });
  }
});

app.post("/content/podcasts/:id/transcript/generate", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid podcast id." });
    }
    const item = await getContentItemById(contentId);
    const itemKind = String(item?.kind || "").toLowerCase();
    if (!item || item.deleted_at || (itemKind !== "podcast" && itemKind !== "audio")) {
      return res.status(404).json({ code: "PODCAST_NOT_FOUND", message: "Podcast not found." });
    }
    const isOwner = Number(item.user_id) === userId;
    if (String(item.status || "") !== "published" && !isOwner) {
      return res.status(404).json({ code: "PODCAST_NOT_FOUND", message: "Podcast not found." });
    }
    const existingTrack = await getSourceTranscriptTrackRow(contentId);
    if (existingTrack) {
      await markSourceTranscriptJobReady({
        contentId,
        requestedByUserId: userId,
      });
      return res.json({
        ok: true,
        status: "ready",
        track: buildTranscriptTrackResponse(existingTrack),
      });
    }
    if (!isOpenAiTranslationEnabled()) {
      return res.status(503).json({
        code: "TRANSCRIPTION_NOT_CONFIGURED",
        message: "OpenAI transcription is not configured.",
      });
    }
    const asset = await getTranscriptSourceAsset(contentId);
    if (!asset?.storage_key) {
      return res.status(409).json({
        code: "PODCAST_SOURCE_ASSET_REQUIRED",
        message: "A podcast audio file is required before generating a transcript.",
      });
    }
    const queued = await queueSourceTranscriptJob({
      contentId,
      requestedByUserId: userId,
      sourceAssetId: Number(asset.id || 0) || null,
    });
    if (queued.track) {
      return res.json({
        ok: true,
        status: "ready",
        track: buildTranscriptTrackResponse(queued.track),
      });
    }
    return res.status(202).json({
      ok: true,
      status: normalizeTranscriptJobStatus(queued.job?.status, "pending"),
      job: buildTranscriptJobResponse(queued.job),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      message: String(e?.message || "Failed to queue podcast transcript generation."),
    });
  }
});

app.post("/content/podcasts/:id/transcripts/:language/translate", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const contentId = Number(req.params.id);
    const targetLanguage = normalizeLanguageCode(req.params.language);
    if (!contentId) {
      return res.status(400).json({ code: "INVALID_CONTENT_ID", message: "Invalid podcast id." });
    }
    const item = await getContentItemById(contentId);
    const itemKind = String(item?.kind || "").toLowerCase();
    if (!item || item.deleted_at || (itemKind !== "podcast" && itemKind !== "audio")) {
      return res.status(404).json({ code: "PODCAST_NOT_FOUND", message: "Podcast not found." });
    }
    if (Number(item.user_id) !== userId) {
      return res.status(403).json({ code: "NOT_OWNER", message: "Only the owner can translate podcast transcripts." });
    }
    const sourceRows = await listTranscriptTrackRows(contentId);
    const sourceTrack =
      sourceRows
        .map((row) => buildTranscriptTrackResponse(row))
        .find((track) => track.kind === "source") || null;
    if (!sourceTrack) {
      return res.status(409).json({
        code: "SOURCE_TRANSCRIPT_REQUIRED",
        message: "Generate the source transcript before translating it.",
      });
    }
    if (sourceTrack.languageCode === targetLanguage) {
      return res.json({ ok: true, track: sourceTrack });
    }
    const existingTranslation =
      await getTranscriptTrackRow(contentId, targetLanguage, "translation");
    if (existingTranslation) {
      return res.json({
        ok: true,
        track: buildTranscriptTrackResponse(existingTranslation),
      });
    }
    const translatedSegments = await translateTranscriptSegmentsWithOpenAi({
      segments: sourceTrack.segments,
      sourceLanguage: sourceTrack.languageCode,
      targetLanguage,
    });
    await pool.query(
      `INSERT INTO content_transcripts
       (content_item_id, kind, language_code, source_language_code, status, segments_json)
       VALUES (?, 'translation', ?, ?, 'ready', ?)
       ON DUPLICATE KEY UPDATE
         source_language_code = VALUES(source_language_code),
         status = VALUES(status),
         segments_json = VALUES(segments_json),
         updated_at = CURRENT_TIMESTAMP`,
      [
        contentId,
        targetLanguage,
        sourceTrack.languageCode,
        JSON.stringify(translatedSegments),
      ]
    );
    const trackRow = await getTranscriptTrackRow(
      contentId,
      targetLanguage,
      "translation"
    );
    return res.json({
      ok: true,
      track: buildTranscriptTrackResponse(trackRow),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: String(e?.message || "Failed to translate podcast transcript.") });
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
        canPublishVideo: isContentCreatorRow(row),
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
       ${includeDisabled ? "" : "WHERE u.can_publish_video = 1 OR LOWER(COALESCE(u.role, '')) = 'creator'"}
       ORDER BY (u.can_publish_video = 1 OR LOWER(COALESCE(u.role, '')) = 'creator') DESC, u.id DESC`
    );

    return res.json({
      ok: true,
      users: rows.map((row) => ({
        id: String(row.id),
        email: row.email || "",
        username: row.username || "",
        displayName: row.display_name || "",
        role: row.role || "user",
        canPublishVideo: isContentCreatorRow(row),
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

app.get("/admin/users/:id/direct-call/devices", requireAuth, requireAdmin, async (req, res) => {
  try {
    const targetUserId = Number(req.params.id);
    if (!targetUserId) {
      return res.status(400).json({ code: "INVALID_USER_ID", message: "Invalid user id." });
    }

    const [userRows] = await pool.query(
      `SELECT id, email, display_name, username, role, plan, trial_ends_at, pro_ends_at,
              receive_voice_calls, receive_video_calls
         FROM users
        WHERE id = ?
        LIMIT 1`,
      [targetUserId]
    );
    const userRow = userRows?.[0];
    if (!userRow) {
      return res.status(404).json({ code: "USER_NOT_FOUND", message: "User not found." });
    }

    const effective = computeEffectivePlan(userRow);
    const [deviceRows] = await pool.query(
      `SELECT id, platform, push_provider, device_token, app_bundle, device_label, enabled,
              last_seen_at, last_verified_at, last_push_success_at, last_push_failure_at,
              last_push_error, consecutive_failures, created_at, updated_at
         FROM direct_call_devices
        WHERE user_id = ?
        ORDER BY updated_at DESC, id DESC`,
      [targetUserId]
    );
    const devices = (deviceRows || []).map(serializeDirectCallDevice);

    return res.json({
      ok: true,
      user: {
        id: String(userRow.id),
        email: userRow.email || "",
        displayName: userRow.display_name || "",
        username: userRow.username || "",
        role: effective.role,
        plan: effective.plan,
        receiveVoiceCalls: Number(userRow.receive_voice_calls ?? 1) === 1,
        receiveVideoCalls: Number(userRow.receive_video_calls ?? 1) === 1,
      },
      summary: summarizeDirectCallDevices(devices),
      devices,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load direct-call diagnostics." });
  }
});

app.get("/me/profile/username-availability", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const normalized = normalizeUsernameValue(req.query?.username);
    if (!normalized) {
      return res.status(400).json({ message: "Username is required." });
    }
    if (!isValidUsernameValue(normalized)) {
      return res.json({
        ok: true,
        username: normalized,
        available: false,
        reason:
          "Username must be 3-20 characters using lowercase letters, numbers, dots, or underscores.",
      });
    }

    const [rows] = await pool.query(
      "SELECT id FROM users WHERE username = ? LIMIT 1",
      [normalized]
    );
    const row = rows?.[0];
    const available = !row || Number(row.id) === userId;
    return res.json({ ok: true, username: normalized, available });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to check username." });
  }
});

app.patch("/me/profile", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const [rows] = await pool.query(
      `SELECT id, username, display_name, from_country,
              first_language, learn_language, meet_languages_json,
              relationship_status, relationship_status_visible,
              bio_text, dob, gender
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [userId]
    );
    const current = rows?.[0];
    if (!current) {
      return res.status(404).json({ message: "User not found." });
    }

    const displayName = String(
      req.body?.displayName ?? current.display_name ?? ""
    ).trim();
    const username = normalizeUsernameValue(
      req.body?.username ?? current.username ?? ""
    );
    const nationalityCode = String(
      req.body?.nationalityCode ?? current.from_country ?? ""
    )
      .trim()
      .toUpperCase();
    const firstLanguage = String(
      req.body?.firstLanguage ?? current.first_language ?? ""
    ).trim();
    const learnLanguage = String(
      req.body?.learnLanguage ?? current.learn_language ?? ""
    ).trim();
    const bioText = String(req.body?.bioText ?? current.bio_text ?? "").trim();
    const dob = String(req.body?.dateOfBirth ?? current.dob ?? "").trim();
    const gender = String(req.body?.gender ?? current.gender ?? "")
      .trim()
      .toLowerCase();
    const requestedVisibleRaw = req.body?.relationshipStatusVisible;
    const requestedVisible =
      requestedVisibleRaw == null
        ? Number(current.relationship_status_visible || 0) === 1
        : requestedVisibleRaw === true ||
            requestedVisibleRaw === 1 ||
            String(requestedVisibleRaw).trim().toLowerCase() === "true";
    const relationshipStatus = normalizeRelationshipStatus(
      req.body?.relationshipStatus ?? current.relationship_status ?? ""
    );
    let meetLanguages = [];
    if (Array.isArray(req.body?.meetLanguages)) {
      meetLanguages = req.body.meetLanguages
        .map((item) => String(item || "").trim())
        .filter(Boolean);
    } else {
      try {
        meetLanguages = current.meet_languages_json
          ? JSON.parse(current.meet_languages_json)
          : [];
      } catch {
        meetLanguages = [];
      }
    }
    const normalizedMeetLanguages = Array.from(
      new Set([learnLanguage, ...meetLanguages.map((item) => String(item || "").trim())])
    )
      .filter(Boolean)
      .slice(0, 3);

    if (!displayName) {
      return res.status(400).json({ message: "Display name is required." });
    }
    if (displayName.length > 40) {
      return res.status(400).json({ message: "Display name must be 40 characters or less." });
    }
    if (!isValidUsernameValue(username)) {
      return res.status(400).json({
        message:
          "Username must be 3-20 characters using lowercase letters, numbers, dots, or underscores.",
      });
    }
    if (bioText.length > 150) {
      return res.status(400).json({ message: "Bio text must be 150 characters or less." });
    }
    if (!firstLanguage || !learnLanguage) {
      return res.status(400).json({ message: "Choose both first and learning languages." });
    }
    if (!nationalityCode) {
      return res.status(400).json({ message: "Nationality is required." });
    }
    if (!dob || !isOldEnoughDate(dob)) {
      return res.status(400).json({ message: "You must be at least 13 years old." });
    }
    if (!["male", "female"].includes(gender)) {
      return res.status(400).json({ message: "Gender must be male or female." });
    }
    if (requestedVisible && !relationshipStatus) {
      return res.status(400).json({ message: "Choose a relationship status before showing it." });
    }
    if (username !== String(current.username || "").trim().toLowerCase()) {
      const [usernameRows] = await pool.query(
        "SELECT id FROM users WHERE username = ? LIMIT 1",
        [username]
      );
      if (usernameRows.length > 0) {
        return res.status(409).json({ message: "That username is already taken." });
      }
    }

    await pool.query(
      `UPDATE users
       SET display_name = ?, username = ?, from_country = ?,
           first_language = ?, learn_language = ?, meet_languages_json = ?,
           relationship_status = ?, relationship_status_visible = ?,
           bio_text = ?, dob = ?, gender = ?
       WHERE id = ?
       LIMIT 1`,
      [
        displayName,
        username,
        nationalityCode,
        firstLanguage,
        learnLanguage,
        JSON.stringify(normalizedMeetLanguages),
        relationshipStatus || null,
        requestedVisible ? 1 : 0,
        bioText || null,
        dob,
        gender,
        userId,
      ]
    );

    return res.json({
      ok: true,
      user: {
        id: String(userId),
        displayName,
        username,
        nationalityCode,
        nationalityName: nationalityCode,
        firstLanguage,
        learnLanguage,
        meetLanguages: normalizedMeetLanguages,
        relationshipStatus,
        relationshipStatusVisible: requestedVisible,
        bioText,
        dateOfBirth: dob,
        age: computeAgeFromDob(dob),
        gender,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to update profile." });
  }
});

app.post("/me/profile-photo", requireAuth, upload.single("profilePhoto"), async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    if (!req.file) {
      return res.status(400).json({ message: "Attach a profile photo image to upload." });
    }
    const mimeType = String(req.file.mimetype || "").toLowerCase();
    if (!mimeType.startsWith("image/")) {
      return res.status(400).json({ message: "Profile photos must be image files." });
    }

    const [rows] = await pool.query(
      `SELECT id, profile_photo_url
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [userId]
    );
    const current = rows?.[0];
    if (!current) {
      return res.status(404).json({ message: "User not found." });
    }

    const nextUrl = `/uploads/${req.file.filename}`;
    const previousUrl = String(current.profile_photo_url || "").trim();
    await pool.query(
      `UPDATE users
       SET profile_photo_url = ?
       WHERE id = ?
       LIMIT 1`,
      [nextUrl, userId]
    );
    if (previousUrl && previousUrl !== nextUrl) {
      removeUploadByPublicUrl(previousUrl);
    }

    return res.json({ ok: true, profilePhotoUrl: nextUrl });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to update profile photo." });
  }
});

app.delete("/me/profile-photo", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const [rows] = await pool.query(
      `SELECT id, profile_photo_url
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [userId]
    );
    const current = rows?.[0];
    if (!current) {
      return res.status(404).json({ message: "User not found." });
    }
    const previousUrl = String(current.profile_photo_url || "").trim();
    await pool.query(
      `UPDATE users
       SET profile_photo_url = NULL
       WHERE id = ?
       LIMIT 1`,
      [userId]
    );
    if (previousUrl) {
      removeUploadByPublicUrl(previousUrl);
    }
    return res.json({ ok: true, profilePhotoUrl: "" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to remove profile photo." });
  }
});

app.post(
  "/me/profile-bio/audio",
  requireAuth,
  voiceBioUpload.single("audio"),
  async (req, res) => {
    try {
      const userId = Number(req.user.sub);
      if (!req.file) {
        return res.status(400).json({ message: "Attach an audio recording to upload." });
      }
      const mimeType = String(req.file.mimetype || "").toLowerCase();
      if (!mimeType.startsWith("audio/")) {
        return res.status(400).json({ message: "Voice bio must be an audio recording." });
      }
      const parsedDuration = Number(req.body?.durationSeconds || 0);
      const durationSeconds = Number.isFinite(parsedDuration)
        ? Math.floor(parsedDuration)
        : 0;
      if (durationSeconds < 1 || durationSeconds > 60) {
        return res.status(400).json({ message: "Voice bio must be 60 seconds or less." });
      }

      const [rows] = await pool.query(
        `SELECT id, bio_audio_url
         FROM users
         WHERE id = ?
         LIMIT 1`,
        [userId]
      );
      const current = rows?.[0];
      if (!current) {
        return res.status(404).json({ message: "User not found." });
      }

      const nextUrl = `/uploads/${req.file.filename}`;
      const previousUrl = String(current.bio_audio_url || "").trim();
      await pool.query(
        `UPDATE users
         SET bio_audio_url = ?, bio_audio_duration = ?
         WHERE id = ?
         LIMIT 1`,
        [nextUrl, durationSeconds, userId]
      );
      if (previousUrl && previousUrl !== nextUrl) {
        removeUploadByPublicUrl(previousUrl);
      }

      return res.json({
        ok: true,
        bioAudioUrl: nextUrl,
        bioAudioDuration: durationSeconds,
      });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: "Failed to update voice bio." });
    }
  }
);

app.delete("/me/profile-bio/audio", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user.sub);
    const [rows] = await pool.query(
      `SELECT id, bio_audio_url
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [userId]
    );
    const current = rows?.[0];
    if (!current) {
      return res.status(404).json({ message: "User not found." });
    }
    const previousUrl = String(current.bio_audio_url || "").trim();
    await pool.query(
      `UPDATE users
       SET bio_audio_url = NULL, bio_audio_duration = NULL
       WHERE id = ?
       LIMIT 1`,
      [userId]
    );
    if (previousUrl) {
      removeUploadByPublicUrl(previousUrl);
    }
    return res.json({ ok: true, bioAudioUrl: "", bioAudioDuration: 0 });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to remove voice bio." });
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
  const where = ["id <> ?", "LOWER(COALESCE(role, '')) NOT IN ('admin', 'superadmin')"];
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
    `SELECT id, display_name, username, first_language, learn_language, city, country, country_code, from_country, plan, role, profile_photo_url, bio_text
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
      bioText: u.bio_text || "",
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
      `SELECT id, display_name, username, city, country, country_code, from_country,
              first_language, learn_language, profile_photo_url, cover_photo_urls_json, cover_photo_thumb_urls_json,
              relationship_status, relationship_status_visible,
              bio_text, bio_audio_url, bio_audio_duration,
              show_country, show_flag,
              dob, gender,
              plan, role, can_publish_video, trial_ends_at, pro_ends_at
       FROM users
       WHERE id = ?
       LIMIT 1`,
      [targetId]
    );

    const u = rows?.[0];
    if (!u) return res.status(404).json({ message: "User not found" });

    const effective = computeEffectivePlan(u);
    const followersCount = await getFollowerCountWithSynthetic(targetId);
    const [[followingRow]] = await pool.query(`SELECT COUNT(*) AS count FROM follows WHERE follower_id = ?`, [targetId]);
    const [[followingMeRow]] = await pool.query(`SELECT COUNT(*) AS count FROM follows WHERE follower_id = ? AND following_id = ?`, [viewerId, targetId]);
    const postsCount = await countPublishedPostsForUser(targetId);
    const coverVisibility = buildCoverPhotoVisibility(u, viewerId, targetId);
    const relationshipStatusVisible = Number(u.relationship_status_visible || 0) === 1;
    const showCountry = Number(u.show_country || 0) === 1;
    const showFlag = Number(u.show_flag || 0) === 1;

    return res.json({
      ok: true,
      user: {
        id: u.id,
        displayName: u.display_name,
        username: u.username,
        city: showCountry ? u.city : "",
        country: showCountry ? u.country : "",
        countryCode: showCountry ? u.country_code : "",
        showCountry,
        showFlag,
        nationalityCode: showFlag ? u.from_country : "",
        nationalityName: showFlag ? u.from_country : "",
        firstLanguage: u.first_language,
        learnLanguage: u.learn_language,
        role: effective.role,
        plan: effective.plan,
        canPublishVideo: isContentCreatorRow(u),
        profilePhotoUrl: u.profile_photo_url,
        coverPhotoUrls: coverVisibility.coverPhotoUrls,
        coverPhotoThumbUrls: coverVisibility.coverPhotoThumbUrls,
        coverPhotosLocked: coverVisibility.coverPhotosLocked,
        relationshipStatus: relationshipStatusVisible
          ? normalizeRelationshipStatus(u.relationship_status)
          : "",
        relationshipStatusVisible: relationshipStatusVisible,
        bioText: u.bio_text || "",
        bioAudioUrl: u.bio_audio_url || "",
        bioAudioDuration: Number(u.bio_audio_duration || 0),
        age: computeAgeFromDob(u.dob),
        gender: u.gender || "",
        followersCount: followersCount.total,
        followingCount: Number(followingRow?.count || 0),
        postsCount,
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
      const actor = await loadNotificationActor(followerId);
      await createUserNotification({
        userId: followingId,
        type: "new_follower",
        title: "New follower",
        body: `${actor.displayName} followed you.`,
        fromUserId: followerId,
        fromDisplayName: actor.displayName,
        fromPhotoUrl: actor.profilePhotoUrl,
        targetId: String(followerId),
      });
    }

    const followersCount = await getFollowerCountWithSynthetic(followingId);
    const [[followingRow]] = await pool.query(`SELECT COUNT(*) AS count FROM follows WHERE follower_id=?`, [followingId]);

    return res.json({ ok: true, following, followersCount: followersCount.total, followingCount: Number(followingRow?.count || 0) });
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
  if (normalizedType === "file") return "📎 File";
  return "";
}

const directAttachmentMimes = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/rtf",
  "text/plain",
  "text/csv",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "audio/m4a",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "video/mp4",
  "video/quicktime",
]);

function normalizeDirectAttachmentMime(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function isAllowedDirectAttachment(file) {
  const mime = normalizeDirectAttachmentMime(file?.mimetype);
  return directAttachmentMimes.has(mime);
}

function directMessageTypeForMime(mime) {
  const normalized = normalizeDirectAttachmentMime(mime);
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("audio/")) return "audio";
  return "file";
}

function buildBasicLinkPreview(text) {
  const raw = String(text || "");
  const match = raw.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;
  const url = match[0].replace(/[),.;!?]+$/, "");
  try {
    const parsed = new URL(url);
    return { url: parsed.toString(), domain: parsed.hostname.replace(/^www\./i, "") };
  } catch {
    return null;
  }
}

function parseDirectLinkPreview(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function visibleDirectMessageClause(meId) {
  return `deleted_for_everyone_at IS NULL
      AND NOT (sender_id = ${Number(meId)} AND deleted_for_sender_at IS NOT NULL)
      AND NOT (receiver_id = ${Number(meId)} AND deleted_for_receiver_at IS NOT NULL)`;
}

async function decorateDirectMessages(rows, viewerId) {
  const messages = (rows || []).map((m) => ({
    id: String(m.id),
    threadId: m.thread_id,
    fromUserId: String(m.sender_id),
    toUserId: String(m.receiver_id),
    type: m.message_type || (m.audio_url ? "audio" : m.image_url ? "image" : m.file_url ? "file" : "text"),
    text: m.message_text || "",
    imageUrl: m.image_url || "",
    audioUrl: m.audio_url || "",
    audioDuration: Number(m.audio_duration || 0),
    fileUrl: m.file_url || "",
    fileName: m.file_name || "",
    fileSize: Number(m.file_size || 0),
    mimeType: m.mime_type || "",
    linkPreview: parseDirectLinkPreview(m.link_preview_json),
    reactions: {},
    myReaction: "",
    pinnedByMe: false,
    editedAt: m.edited_at ? new Date(m.edited_at).getTime() : null,
    replyToMessageId: m.reply_to_message_id ? String(m.reply_to_message_id) : "",
    status: m.message_status,
    createdAt: new Date(m.created_at).getTime(),
  }));
  const ids = messages.map((m) => Number(m.id)).filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) return messages;
  const placeholders = ids.map(() => "?").join(", ");
  const [reactionRows] = await pool.query(
    `SELECT message_id, emoji, COUNT(*) AS count
       FROM direct_message_reactions
      WHERE message_id IN (${placeholders})
      GROUP BY message_id, emoji`,
    ids
  );
  const [myReactionRows] = await pool.query(
    `SELECT message_id, emoji
       FROM direct_message_reactions
      WHERE message_id IN (${placeholders}) AND user_id = ?`,
    [...ids, viewerId]
  );
  const [pinRows] = await pool.query(
    `SELECT message_id
       FROM direct_message_pins
      WHERE message_id IN (${placeholders}) AND user_id = ?`,
    [...ids, viewerId]
  );
  const byId = new Map(messages.map((message) => [message.id, message]));
  for (const row of reactionRows || []) {
    const message = byId.get(String(row.message_id));
    if (!message) continue;
    message.reactions[String(row.emoji)] = Number(row.count || 0);
  }
  for (const row of myReactionRows || []) {
    const message = byId.get(String(row.message_id));
    if (message) message.myReaction = String(row.emoji || "");
  }
  for (const row of pinRows || []) {
    const message = byId.get(String(row.message_id));
    if (message) message.pinnedByMe = true;
  }
  return messages;
}

async function loadDirectMessageForViewer({ messageId, threadId, viewerId }) {
  const [rows] = await pool.query(
    `SELECT id, thread_id, sender_id, receiver_id, message_type, message_text, image_url, audio_url, audio_duration,
            file_url, file_name, file_size, mime_type, link_preview_json, edited_at, reply_to_message_id, message_status, created_at
       FROM direct_messages
      WHERE id = ? AND thread_id = ? AND ${visibleDirectMessageClause(viewerId)}
      LIMIT 1`,
    [messageId, threadId]
  );
  const messages = await decorateDirectMessages(rows, viewerId);
  return messages[0] || null;
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

function parseDirectCallLogCursor(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parts = raw.split(":");
  if (parts.length !== 2) return null;
  const initiatedAtMs = Number(parts[0]);
  const id = Number(parts[1]);
  if (!Number.isFinite(initiatedAtMs) || initiatedAtMs <= 0 || !Number.isFinite(id) || id <= 0) {
    return null;
  }
  return {
    initiatedAt: new Date(initiatedAtMs),
    id: Math.trunc(id),
  };
}

function buildDirectCallLogCursor(initiatedAtValue, idValue) {
  const initiatedAt = new Date(initiatedAtValue);
  const cursorId = Number(idValue);
  if (Number.isNaN(initiatedAt.getTime()) || !Number.isFinite(cursorId) || cursorId <= 0) {
    return "";
  }
  return `${initiatedAt.getTime()}:${Math.trunc(cursorId)}`;
}

function deriveDirectCallLogOutcome(row, viewerId) {
  const state = String(row?.state || "").trim().toLowerCase();
  const isIncoming = Number(row?.callee_id || 0) === Number(viewerId);
  if (state === "active" || state === "accepted" || state === "ringing") {
    return "ongoing";
  }
  if (state === "declined") {
    return "declined";
  }
  if (state === "cancelled") {
    return "cancelled";
  }
  if (state === "missed") {
    return isIncoming ? "missed" : "unanswered";
  }
  if (state === "ended") {
    if (row?.started_at || row?.answered_at) {
      return "answered";
    }
    return isIncoming ? "missed" : "cancelled";
  }
  return row?.started_at || row?.answered_at ? "answered" : "cancelled";
}

function buildDirectCallLogEntry(row, viewerId) {
  const requestedAt = row?.initiated_at ? new Date(row.initiated_at) : null;
  const answeredAt = row?.answered_at ? new Date(row.answered_at) : null;
  const startedAt = row?.started_at ? new Date(row.started_at) : null;
  const endedAt = row?.ended_at ? new Date(row.ended_at) : null;
  const durationSeconds =
    startedAt && !Number.isNaN(startedAt.getTime())
      ? Math.max(
          0,
          Math.round(
            (((endedAt && !Number.isNaN(endedAt.getTime()) ? endedAt : new Date()).getTime() -
              startedAt.getTime()) /
              1000)
          )
        )
      : 0;

  return {
    callId: String(row?.call_id || ""),
    threadId: String(row?.thread_id || ""),
    partnerId: String(row?.partner_id || ""),
    partnerDisplayName: String(row?.partner_display_name || "").trim() || "User",
    partnerUsername: String(row?.partner_username || "").trim(),
    partnerPhotoUrl: String(row?.partner_profile_photo_url || "").trim(),
    direction: Number(row?.caller_id || 0) === Number(viewerId) ? "outgoing" : "incoming",
    mode: Number(row?.wants_video || 0) === 1 ? "video" : "voice",
    outcome: deriveDirectCallLogOutcome(row, viewerId),
    requestedAt: requestedAt && !Number.isNaN(requestedAt.getTime()) ? requestedAt.toISOString() : null,
    answeredAt: answeredAt && !Number.isNaN(answeredAt.getTime()) ? answeredAt.toISOString() : null,
    startedAt: startedAt && !Number.isNaN(startedAt.getTime()) ? startedAt.toISOString() : null,
    endedAt: endedAt && !Number.isNaN(endedAt.getTime()) ? endedAt.toISOString() : null,
    durationSeconds,
    endedByUserId: row?.ended_by_user_id == null ? "" : String(row.ended_by_user_id),
  };
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

app.get("/me/call-logs", requireAuth, async (req, res) => {
  try {
    const meId = Number(req.user?.sub || 0);
    const parsedLimit = Number(req.query?.limit || 40);
    const limit = Math.min(Math.max(Number.isFinite(parsedLimit) ? Math.trunc(parsedLimit) : 40, 1), 50);
    const cursor = parseDirectCallLogCursor(req.query?.cursor);
    const queryParams = [meId, meId, meId, meId];
    let cursorClause = "";
    if (cursor) {
      cursorClause =
        " AND (s.initiated_at < ? OR (s.initiated_at = ? AND s.id < ?))";
      queryParams.push(cursor.initiatedAt, cursor.initiatedAt, cursor.id);
    }
    queryParams.push(limit + 1);

    const [rows] = await pool.query(
      `SELECT s.id, s.call_id, s.thread_id, s.caller_id, s.callee_id, s.wants_video, s.state,
              s.initiated_at, s.answered_at, s.started_at, s.ended_at, s.ended_by_user_id,
              u.id AS partner_id,
              u.display_name AS partner_display_name,
              u.username AS partner_username,
              u.profile_photo_url AS partner_profile_photo_url
         FROM direct_call_sessions s
         INNER JOIN users u
                 ON u.id = CASE
                             WHEN s.caller_id = ? THEN s.callee_id
                             ELSE s.caller_id
                           END
         LEFT JOIN direct_call_log_deletions d
                ON d.call_id = s.call_id
               AND d.user_id = ?
        WHERE (s.caller_id = ? OR s.callee_id = ?)
              AND d.id IS NULL
              ${cursorClause}
        ORDER BY s.initiated_at DESC, s.id DESC
        LIMIT ?`,
      queryParams
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows.length > 0 ? pageRows[pageRows.length - 1] : null;

    return res.json({
      ok: true,
      logs: pageRows.map((row) => buildDirectCallLogEntry(row, meId)),
      nextCursor:
        hasMore && lastRow
          ? buildDirectCallLogCursor(lastRow.initiated_at, lastRow.id)
          : "",
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load call logs" });
  }
});

app.delete("/me/call-logs/:callId", requireAuth, async (req, res) => {
  try {
    const meId = Number(req.user?.sub || 0);
    const callId = String(req.params.callId || "").trim();
    if (!meId || !callId) {
      return res.status(400).json({ message: "Invalid call log" });
    }

    const [rows] = await pool.query(
      `SELECT call_id
         FROM direct_call_sessions
        WHERE call_id = ?
          AND (caller_id = ? OR callee_id = ?)
        LIMIT 1`,
      [callId, meId, meId]
    );
    if (!rows?.length) {
      return res.status(404).json({ message: "Call log not found" });
    }

    await pool.query(
      `INSERT INTO direct_call_log_deletions (user_id, call_id)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE deleted_at = CURRENT_TIMESTAMP`,
      [meId, callId]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to delete call log" });
  }
});

app.delete("/me/call-logs", requireAuth, async (req, res) => {
  try {
    const meId = Number(req.user?.sub || 0);
    if (!meId) {
      return res.status(400).json({ message: "Invalid user" });
    }

    const [result] = await pool.query(
      `INSERT INTO direct_call_log_deletions (user_id, call_id)
       SELECT ?, s.call_id
         FROM direct_call_sessions s
        WHERE s.caller_id = ? OR s.callee_id = ?
       ON DUPLICATE KEY UPDATE deleted_at = CURRENT_TIMESTAMP`,
      [meId, meId, meId]
    );

    return res.json({ ok: true, deletedCount: Number(result?.affectedRows || 0) });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to clear call logs" });
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
      `SELECT id, thread_id, sender_id, receiver_id, message_type, message_text, image_url, audio_url, audio_duration,
              file_url, file_name, file_size, mime_type, link_preview_json, edited_at, reply_to_message_id, message_status, created_at
       FROM direct_messages
       WHERE thread_id=? AND ${visibleDirectMessageClause(meId)}
       ORDER BY created_at ASC, id ASC`,
      [threadId]
    );
    const messages = await decorateDirectMessages(rows, meId);
    return res.json({
      ok: true,
      threadId,
      blocked: blockState.blocked,
      youBlockedUser: blockState.youBlockedUser,
      blockedByUser: blockState.blockedByUser,
      supportsTranslation: isOpenAiTranslationEnabled(),
      supportsCorrection: false,
      messages,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load messages" });
  }
});

app.post("/translations/text", requireAuth, async (req, res) => {
  try {
    if (!isOpenAiTranslationEnabled()) {
      return res.status(503).json({
        message: "Translation service is not configured.",
      });
    }
    const text = String(req.body?.text || "").trim();
    const targetLanguage = String(req.body?.targetLanguage || "").trim();
    const sourceLanguage =
      String(req.body?.sourceLanguage || "auto").trim() || "auto";
    const context = String(req.body?.context || "general")
      .trim()
      .slice(0, 64);
    if (!text) {
      return res.status(400).json({ message: "Text is required." });
    }
    if (!targetLanguage) {
      return res.status(400).json({ message: "Target language is required." });
    }
    const translation = await translateTextWithOpenAi({
      text: text.slice(0, 4000),
      targetLanguage: targetLanguage.slice(0, 64),
      sourceLanguage: sourceLanguage.slice(0, 64),
      context,
    });
    return res.json({
      ok: true,
      translation,
      note: `Translated to ${targetLanguage.slice(0, 64)}.`,
      model: openAiTranslationModel,
    });
  } catch (e) {
    console.error("[translate:text]", e);
    return res.status(502).json({ message: "Translation failed." });
  }
});

app.get("/me/entitlements", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.sub || 0);
    const identity = await loadUserPlanIdentity(pool, userId);
    const limits = await readFreeUsageLimits(pool);
    const freeUsageLimits = serializeFreeUsageLimits(limits);
    const usage = {};
    if (!identity.isProLike) {
      for (const limit of freeUsageLimits) {
        usage[limit.key] = await getDailyUsageState(pool, {
          userId,
          usageKey: limit.key,
          limits,
        });
      }
    }
    return res.json({
      ok: true,
      plan: identity.plan,
      role: identity.role,
      isProLike: identity.isProLike,
      resetPolicy: "utc_daily",
      freeUsageLimits,
      usage,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load entitlements." });
  }
});

app.post("/me/usage/content-watch", requireAuth, async (req, res) => {
  try {
    const userId = Number(req.user?.sub || 0);
    const seconds = Math.max(1, Math.min(300, Math.round(Number(req.body?.seconds || 0))));
    const result = await consumeDailyUsage(pool, {
      userId,
      usageKey: FREE_USAGE_LIMIT_KEYS.contentWatchSeconds,
      amount: seconds,
    });
    if (!result.ok) {
      return res.status(402).json({
        ok: false,
        code: result.code,
        message: result.message,
        usage: result.usage,
      });
    }
    return res.json({ ok: true, usage: result.usage });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to record content watch time." });
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

app.get("/me/blocked-users", requireAuth, async (req, res) => {
  try {
    const blockerId = Number(req.user.sub);
    const [rows] = await pool.query(
      `SELECT u.id, u.display_name, u.username, u.profile_photo_url, ub.created_at
       FROM user_blocks ub
       INNER JOIN users u ON u.id = ub.blocked_id
       WHERE ub.blocker_id = ?
       ORDER BY ub.created_at DESC, ub.blocked_id DESC`,
      [blockerId]
    );
    return res.json({
      ok: true,
      users: (rows || []).map((row) => ({
        id: String(row.id),
        displayName: row.display_name || "User",
        username: row.username || "",
        profilePhotoUrl: row.profile_photo_url || "",
        blockedAt: row.created_at ? new Date(row.created_at).getTime() : 0,
      })),
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load blocked users" });
  }
});

app.post("/me/anonymous-reports", requireAuth, async (req, res) => {
  try {
    const reporterId = Number(req.user.sub);
    const reportedUserId = Number(req.body?.reportedUserId);
    const matchId = String(req.body?.matchId || "").trim().slice(0, 80);
    const reason = String(req.body?.reason || "").trim().slice(0, 80);
    const details = String(req.body?.details || "").trim().slice(0, 1000);
    const rawEvidence = Array.isArray(req.body?.evidence) ? req.body.evidence : [];
    if (!reportedUserId || reporterId === reportedUserId || !matchId) {
      return res.status(400).json({ message: "Invalid anonymous report target." });
    }
    if (!reason) {
      return res.status(400).json({ message: "A report reason is required." });
    }
    const evidence = rawEvidence
      .map((item) => ({
        name: String(item?.name || "proof.jpg").trim().slice(0, 120),
        mimeType: String(item?.mimeType || "image/jpeg").trim().slice(0, 80),
        dataUrl: String(item?.dataUrl || "").trim(),
      }))
      .filter((item) =>
        item.dataUrl.startsWith("data:image/") &&
        item.dataUrl.length <= 2200000
      )
      .slice(0, 3);
    if (evidence.length === 0) {
      return res.status(400).json({ message: "At least one proof photo is required." });
    }
    const [users] = await pool.query(
      `SELECT id FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
      [reportedUserId]
    );
    if (!users?.length) {
      return res.status(404).json({ message: "Reported user was not found." });
    }
    await pool.query(
      `INSERT INTO anonymous_match_reports
         (reporter_id, reported_user_id, match_id, reason, details, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        reporterId,
        reportedUserId,
        matchId,
        reason,
        details || null,
        JSON.stringify(evidence),
      ]
    );
    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to submit anonymous report." });
  }
});

app.post("/users/:id/report", requireAuth, async (req, res) => {
  try {
    const reporterId = Number(req.user.sub);
    const reportedUserId = Number(req.params.id);
    const reason = String(req.body?.reason || "").trim().slice(0, 80);
    const rawEvidence = Array.isArray(req.body?.evidence) ? req.body.evidence : [];
    if (!reportedUserId || reporterId === reportedUserId) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    if (!reason) {
      return res.status(400).json({ message: "A report reason is required" });
    }
    const evidence = rawEvidence
      .map((item) => ({
        name: String(item?.name || "proof.jpg").trim().slice(0, 120),
        mimeType: String(item?.mimeType || "image/jpeg").trim().slice(0, 80),
        dataUrl: String(item?.dataUrl || "").trim(),
      }))
      .filter((item) =>
        item.dataUrl.startsWith("data:image/") &&
        item.dataUrl.length <= 2200000
      )
      .slice(0, 3);
    if (evidence.length === 0) {
      return res.status(400).json({ message: "At least one proof photo is required." });
    }
    await pool.query(
      `INSERT INTO user_reports (reporter_id, reported_user_id, reason, evidence_json)
       VALUES (?, ?, ?, ?)`,
      [reporterId, reportedUserId, reason, JSON.stringify(evidence)]
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
  try {
    if (!isOpenAiTranslationEnabled()) {
      return res.status(503).json({
        message: "Translation service is not configured.",
      });
    }
    const meId = Number(req.user.sub);
    const otherId = Number(req.params.id);
    const messageId = Number(req.params.messageId);
    if (!otherId || !messageId) {
      return res.status(400).json({ message: "Invalid request." });
    }
    const threadId = getThreadIdForUsers(meId, otherId);
    const [rows] = await pool.query(
      `SELECT id, message_type, message_text
       FROM direct_messages
       WHERE id = ? AND thread_id = ?
       LIMIT 1`,
      [messageId, threadId]
    );
    const message = rows?.[0];
    if (!message) {
      return res.status(404).json({ message: "Message not found" });
    }
    if (String(message.message_type || "text").toLowerCase() !== "text") {
      return res.status(400).json({ message: "Only text messages can be translated." });
    }
    const text = String(req.body?.text || message.message_text || "").trim();
    if (!text) {
      return res.status(400).json({ message: "Text is required." });
    }
    const quota = await assertDailyUsageAvailable(pool, {
      userId: meId,
      usageKey: FREE_USAGE_LIMIT_KEYS.chatAiActions,
      amount: 1,
    });
    if (!quota.ok) {
      return res.status(402).json({
        ok: false,
        code: quota.code,
        message: quota.message,
        usage: quota.usage,
      });
    }
    const requestedTargetLanguage = String(
      req.body?.targetLanguage || ""
    ).trim();
    let targetLanguage = requestedTargetLanguage.slice(0, 64);
    if (!targetLanguage) {
      const [userRows] = await pool.query(
        `SELECT first_language
         FROM users
         WHERE id = ?
         LIMIT 1`,
        [meId]
      );
      targetLanguage =
        String(userRows?.[0]?.first_language || "").trim() || "English";
    }
    const translation = await translateTextWithOpenAi({
      text: text.slice(0, 4000),
      targetLanguage,
      sourceLanguage: "auto",
      context: "direct_chat_message",
    });
    const consumedQuota = await consumeDailyUsage(pool, {
      userId: meId,
      usageKey: FREE_USAGE_LIMIT_KEYS.chatAiActions,
      amount: 1,
    });
    if (!consumedQuota.ok) {
      return res.status(402).json({
        ok: false,
        code: consumedQuota.code,
        message: consumedQuota.message,
        usage: consumedQuota.usage,
      });
    }
    return res.json({
      ok: true,
      translation,
      targetLanguage,
      note: `Translated to ${targetLanguage}.`,
      model: openAiTranslationModel,
      usage: consumedQuota.usage,
    });
  } catch (e) {
    console.error("[translate:direct_message]", e);
    return res.status(502).json({ message: "Translation failed." });
  }
});

app.post("/users/:id/messages/:messageId/correct", requireAuth, async (req, res) => {
  return res.status(403).json({ message: "Correction is not enabled for direct chat." });
});

app.get("/users/:id/messages/search", requireAuth, async (req, res) => {
  try {
    const meId = Number(req.user.sub);
    const otherId = Number(req.params.id);
    const q = String(req.query?.q || "").trim();
    if (!otherId || q.length < 2) return res.json({ ok: true, messages: [] });
    const threadId = getThreadIdForUsers(meId, otherId);
    const like = `%${q.slice(0, 120)}%`;
    const [rows] = await pool.query(
      `SELECT id, thread_id, sender_id, receiver_id, message_type, message_text, image_url, audio_url, audio_duration,
              file_url, file_name, file_size, mime_type, link_preview_json, edited_at, reply_to_message_id, message_status, created_at
         FROM direct_messages
        WHERE thread_id = ?
          AND ${visibleDirectMessageClause(meId)}
          AND (message_text LIKE ? OR file_name LIKE ?)
        ORDER BY created_at DESC, id DESC
        LIMIT 50`,
      [threadId, like, like]
    );
    const messages = await decorateDirectMessages(rows, meId);
    return res.json({ ok: true, threadId, messages });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to search messages" });
  }
});

app.get("/users/:id/messages/shared", requireAuth, async (req, res) => {
  try {
    const meId = Number(req.user.sub);
    const otherId = Number(req.params.id);
    if (!otherId) return res.status(400).json({ message: "Invalid user id" });
    const threadId = getThreadIdForUsers(meId, otherId);
    const type = String(req.query?.type || "files").trim().toLowerCase();
    let typeClause = "message_type = 'file'";
    if (type === "media") typeClause = "message_type IN ('image', 'audio')";
    if (type === "links") typeClause = "link_preview_json IS NOT NULL";
    const [rows] = await pool.query(
      `SELECT id, thread_id, sender_id, receiver_id, message_type, message_text, image_url, audio_url, audio_duration,
              file_url, file_name, file_size, mime_type, link_preview_json, edited_at, reply_to_message_id, message_status, created_at
         FROM direct_messages
        WHERE thread_id = ?
          AND ${visibleDirectMessageClause(meId)}
          AND ${typeClause}
        ORDER BY created_at DESC, id DESC
        LIMIT 100`,
      [threadId]
    );
    const messages = await decorateDirectMessages(rows, meId);
    return res.json({ ok: true, threadId, messages });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to load shared messages" });
  }
});

app.post("/me/messages/forward", requireAuth, async (req, res) => {
  try {
    const senderId = Number(req.user.sub);
    const messageId = Number(req.body?.messageId);
    const rawRecipientIds = Array.isArray(req.body?.recipientIds)
      ? req.body.recipientIds
      : [];
    const recipientIds = [
      ...new Set(
        rawRecipientIds
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value) && value > 0 && value !== senderId)
      ),
    ].slice(0, 20);

    if (!messageId || recipientIds.length === 0) {
      return res.status(400).json({ message: "Select at least one chat to forward to." });
    }

    const [sourceRows] = await pool.query(
      `SELECT id, thread_id, sender_id, receiver_id, message_type, message_text, image_url, audio_url, audio_duration,
              file_url, file_name, file_size, mime_type, link_preview_json
         FROM direct_messages
        WHERE id = ?
          AND (sender_id = ? OR receiver_id = ?)
          AND ${visibleDirectMessageClause(senderId)}
        LIMIT 1`,
      [messageId, senderId, senderId]
    );
    const source = sourceRows?.[0];
    if (!source) {
      return res.status(404).json({ message: "Message not found" });
    }

    const actor = await loadNotificationActor(senderId);
    const forwardedMessages = [];
    const skippedRecipientIds = [];
    for (const receiverId of recipientIds) {
      const blockState = await getDirectBlockState(senderId, receiverId);
      if (blockState.blocked) {
        skippedRecipientIds.push(String(receiverId));
        continue;
      }

      const threadId = getThreadIdForUsers(senderId, receiverId);
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
        `INSERT INTO direct_messages (thread_id, sender_id, receiver_id, message_type, message_text, image_url, audio_url, audio_duration,
                                      file_url, file_name, file_size, mime_type, link_preview_json, message_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          threadId,
          senderId,
          receiverId,
          String(source.message_type || "text"),
          source.message_text || null,
          source.image_url || null,
          source.audio_url || null,
          source.audio_duration || null,
          source.file_url || null,
          source.file_name || null,
          source.file_size || null,
          source.mime_type || null,
          source.link_preview_json || null,
          messageStatus,
        ]
      );

      const message = await loadDirectMessageForViewer({
        messageId: result.insertId,
        threadId,
        viewerId: senderId,
      });
      if (!message) {
        skippedRecipientIds.push(String(receiverId));
        continue;
      }
      forwardedMessages.push(message);

      if (io) {
        try {
          const createdAt = Date.now();
          const fallbackText = buildDirectMessagePreview(message.type, message.text);
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

      await createUserNotification({
        userId: receiverId,
        type: "direct_message",
        title: actor.displayName,
        body: buildDirectMessagePreview(message.type, message.text) || "Sent you a message.",
        fromUserId: senderId,
        fromDisplayName: actor.displayName,
        fromPhotoUrl: actor.profilePhotoUrl,
        targetId: threadId,
      });
    }

    return res.status(201).json({
      ok: true,
      forwardedCount: forwardedMessages.length,
      skippedRecipientIds,
      messages: forwardedMessages,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to forward message" });
  }
});

app.post("/users/:id/messages/file", requireAuth, directMessageUpload.single("file"), async (req, res) => {
  try {
    const senderId = Number(req.user.sub);
    const receiverId = Number(req.params.id);
    if (!receiverId || senderId === receiverId) return res.status(400).json({ message: "Invalid user id" });
    if (!req.file) return res.status(400).json({ message: "File is required" });
    if (!isAllowedDirectAttachment(req.file)) {
      return res.status(400).json({ message: "This file type is not allowed in direct chat." });
    }
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
    const replyToMessageId = req.body?.replyToMessageId ? Number(req.body.replyToMessageId) : null;
    if (replyToMessageId) {
      const [replyRows] = await pool.query(
        `SELECT id FROM direct_messages WHERE id = ? AND thread_id = ? LIMIT 1`,
        [replyToMessageId, threadId]
      );
      if (!replyRows?.[0]) return res.status(400).json({ message: "Reply target is not available in this chat." });
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
    const mimeType = normalizeDirectAttachmentMime(req.file.mimetype);
    const messageType = directMessageTypeForMime(mimeType);
    const publicUrl = `/uploads/${req.file.filename}`;
    const audioDuration = Number(req.body?.audioDuration || 0) || null;
    const fileName = String(req.file.originalname || "attachment").trim().slice(0, 255);
    const [result] = await pool.query(
      `INSERT INTO direct_messages (thread_id, sender_id, receiver_id, message_type, message_text, image_url, audio_url, audio_duration,
                                    file_url, file_name, file_size, mime_type, reply_to_message_id, message_status)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        threadId,
        senderId,
        receiverId,
        messageType,
        messageType === "image" ? publicUrl : null,
        messageType === "audio" ? publicUrl : null,
        messageType === "audio" ? audioDuration : null,
        publicUrl,
        fileName,
        Number(req.file.size || 0),
        mimeType,
        replyToMessageId,
        messageStatus,
      ]
    );
    const message = await loadDirectMessageForViewer({ messageId: result.insertId, threadId, viewerId: senderId });
    if (message) message.clientMessageId = req.body?.clientMessageId ? String(req.body.clientMessageId) : "";
    const createdAt = Date.now();
    if (io && message) {
      try {
        const fallbackText = buildDirectMessagePreview(message.type, message.text);
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
    if (message) {
      const actor = await loadNotificationActor(senderId);
      await createUserNotification({
        userId: receiverId,
        type: "direct_message",
        title: actor.displayName,
        body: buildDirectMessagePreview(message.type, message.text) || "Sent you a file.",
        fromUserId: senderId,
        fromDisplayName: actor.displayName,
        fromPhotoUrl: actor.profilePhotoUrl,
        targetId: threadId,
      });
    }
    return res.status(201).json({ ok: true, message });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to save file message" });
  }
});

app.patch("/users/:id/messages/:messageId", requireAuth, async (req, res) => {
  try {
    const meId = Number(req.user.sub);
    const otherId = Number(req.params.id);
    const messageId = Number(req.params.messageId);
    const text = String(req.body?.text || "").trim();
    if (!otherId || !messageId || !text) return res.status(400).json({ message: "Invalid edit request." });
    const threadId = getThreadIdForUsers(meId, otherId);
    const [rows] = await pool.query(
      `SELECT id, sender_id, message_type FROM direct_messages WHERE id = ? AND thread_id = ? LIMIT 1`,
      [messageId, threadId]
    );
    const row = rows?.[0];
    if (!row) return res.status(404).json({ message: "Message not found" });
    if (Number(row.sender_id) !== meId) return res.status(403).json({ message: "You can only edit your own messages." });
    if (String(row.message_type || "text") !== "text") return res.status(400).json({ message: "Only text messages can be edited." });
    const linkPreview = buildBasicLinkPreview(text);
    await pool.query(
      `UPDATE direct_messages
          SET message_text = ?, link_preview_json = ?, edited_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [text.slice(0, 10000), linkPreview ? JSON.stringify(linkPreview) : null, messageId]
    );
    const message = await loadDirectMessageForViewer({ messageId, threadId, viewerId: meId });
    if (io && message) io.to(`dm:${threadId}`).emit("dm:message:edit", message);
    return res.json({ ok: true, message });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to edit message" });
  }
});

app.delete("/users/:id/messages/:messageId", requireAuth, async (req, res) => {
  try {
    const meId = Number(req.user.sub);
    const otherId = Number(req.params.id);
    const messageId = Number(req.params.messageId);
    const scope = String(req.body?.scope || req.query?.scope || "me").trim().toLowerCase();
    if (!otherId || !messageId) return res.status(400).json({ message: "Invalid delete request." });
    const threadId = getThreadIdForUsers(meId, otherId);
    const [rows] = await pool.query(
      `SELECT id, sender_id, receiver_id FROM direct_messages WHERE id = ? AND thread_id = ? LIMIT 1`,
      [messageId, threadId]
    );
    const row = rows?.[0];
    if (!row) return res.status(404).json({ message: "Message not found" });
    if (scope === "everyone") {
      if (Number(row.sender_id) !== meId) return res.status(403).json({ message: "You can only delete your own messages for everyone." });
      await pool.query(`UPDATE direct_messages SET deleted_for_everyone_at = CURRENT_TIMESTAMP WHERE id = ?`, [messageId]);
      if (io) io.to(`dm:${threadId}`).emit("dm:message:delete", { threadId, messageId: String(messageId), scope: "everyone" });
      return res.json({ ok: true });
    }
    const column = Number(row.sender_id) === meId ? "deleted_for_sender_at" : "deleted_for_receiver_at";
    await pool.query(`UPDATE direct_messages SET ${column} = CURRENT_TIMESTAMP WHERE id = ?`, [messageId]);
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to delete message" });
  }
});

app.post("/users/:id/messages/:messageId/reaction", requireAuth, async (req, res) => {
  try {
    const meId = Number(req.user.sub);
    const otherId = Number(req.params.id);
    const messageId = Number(req.params.messageId);
    const emoji = String(req.body?.emoji || "").trim().slice(0, 32);
    if (!otherId || !messageId || !emoji) return res.status(400).json({ message: "Invalid reaction." });
    const threadId = getThreadIdForUsers(meId, otherId);
    const [rows] = await pool.query(`SELECT id FROM direct_messages WHERE id = ? AND thread_id = ? LIMIT 1`, [messageId, threadId]);
    if (!rows?.[0]) return res.status(404).json({ message: "Message not found" });
    await pool.query(
      `INSERT INTO direct_message_reactions (message_id, user_id, emoji)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE emoji = VALUES(emoji), created_at = CURRENT_TIMESTAMP`,
      [messageId, meId, emoji]
    );
    const [reactionRows] = await pool.query(
      `SELECT emoji, COUNT(*) AS count FROM direct_message_reactions WHERE message_id = ? GROUP BY emoji`,
      [messageId]
    );
    const reactions = {};
    for (const row of reactionRows || []) reactions[String(row.emoji)] = Number(row.count || 0);
    if (io) io.to(`dm:${threadId}`).emit("dm:message:reaction", { threadId, messageId: String(messageId), reactions });
    return res.json({ ok: true, reactions, myReaction: emoji });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to save reaction" });
  }
});

app.delete("/users/:id/messages/:messageId/reaction", requireAuth, async (req, res) => {
  try {
    const meId = Number(req.user.sub);
    const otherId = Number(req.params.id);
    const messageId = Number(req.params.messageId);
    if (!otherId || !messageId) return res.status(400).json({ message: "Invalid reaction." });
    const threadId = getThreadIdForUsers(meId, otherId);
    await pool.query(`DELETE FROM direct_message_reactions WHERE message_id = ? AND user_id = ?`, [messageId, meId]);
    const [reactionRows] = await pool.query(
      `SELECT emoji, COUNT(*) AS count FROM direct_message_reactions WHERE message_id = ? GROUP BY emoji`,
      [messageId]
    );
    const reactions = {};
    for (const row of reactionRows || []) reactions[String(row.emoji)] = Number(row.count || 0);
    if (io) io.to(`dm:${threadId}`).emit("dm:message:reaction", { threadId, messageId: String(messageId), reactions });
    return res.json({ ok: true, reactions, myReaction: "" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Failed to remove reaction" });
  }
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
    const fileUrl = req.body?.fileUrl ? String(req.body.fileUrl) : null;
    const fileName = req.body?.fileName ? String(req.body.fileName).trim().slice(0, 255) : null;
    const fileSize = Number(req.body?.fileSize || 0) || null;
    const mimeType = req.body?.mimeType ? String(req.body.mimeType) : null;
    const clientMessageId = req.body?.clientMessageId ? String(req.body.clientMessageId) : null;
    const replyToMessageId = req.body?.replyToMessageId ? Number(req.body.replyToMessageId) : null;
    if (!receiverId) return res.status(400).json({ message: "Invalid user id" });
    if (senderId === receiverId) return res.status(400).json({ message: "Invalid user id" });
    if (type === "text" && !textBody) return res.status(400).json({ message: "Message text is required" });
    if (type === "image" && !imageUrl) return res.status(400).json({ message: "Image is required" });
    if (type === "audio" && !audioUrl) return res.status(400).json({ message: "Audio is required" });
    if (type === "file" && !fileUrl) return res.status(400).json({ message: "File is required" });

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
    const linkPreview = type === "text" ? buildBasicLinkPreview(textBody) : null;
    const [result] = await pool.query(
      `INSERT INTO direct_messages (thread_id, sender_id, receiver_id, message_type, message_text, image_url, audio_url, audio_duration,
                                    file_url, file_name, file_size, mime_type, link_preview_json, reply_to_message_id, message_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent')`,
      [
        threadId,
        senderId,
        receiverId,
        type,
        textBody || null,
        imageUrl,
        audioUrl,
        audioDuration,
        fileUrl,
        fileName,
        fileSize,
        mimeType,
        linkPreview ? JSON.stringify(linkPreview) : null,
        replyToMessageId,
      ]
    );
    if (messageStatus !== "sent") {
      await pool.query(
        `UPDATE direct_messages SET message_status=? WHERE id=?`,
        [messageStatus, result.insertId]
      );
    }
    const createdAt = Date.now();
    const message =
      (await loadDirectMessageForViewer({ messageId: result.insertId, threadId, viewerId: senderId })) || {
        id: String(result.insertId),
        threadId,
        fromUserId: String(senderId),
        toUserId: String(receiverId),
        type,
        text: textBody || "",
        imageUrl: imageUrl || "",
        audioUrl: audioUrl || "",
        audioDuration: audioDuration || 0,
        fileUrl: fileUrl || "",
        fileName: fileName || "",
        fileSize: fileSize || 0,
        mimeType: mimeType || "",
        linkPreview: linkPreview || {},
        reactions: {},
        myReaction: "",
        pinnedByMe: false,
        editedAt: null,
        replyToMessageId: replyToMessageId ? String(replyToMessageId) : "",
        status: messageStatus,
        createdAt,
      };
    message.clientMessageId = clientMessageId || "";

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

    const actor = await loadNotificationActor(senderId);
    await createUserNotification({
      userId: receiverId,
      type: "direct_message",
      title: actor.displayName,
      body: buildDirectMessagePreview(message.type, message.text) || "Sent you a message.",
      fromUserId: senderId,
      fromDisplayName: actor.displayName,
      fromPhotoUrl: actor.profilePhotoUrl,
      targetId: threadId,
    });

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
      
      const { token, sessionId } = issueSessionToken({
        userId: created.id,
        email: created.email,
        username: created.username,
        role: "user",
        plan: "free",
        canPublishVideo: false,
      });

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
      
      return res.status(201).json({ ok: true, token, sessionId });
    } catch (e) {
      console.error(e);
      res.status(500).json({ message: "Server error during signup." });
    }
  });

app.post("/admin/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!normalizedEmail || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }

    const [adminAccountRows] = await pool.query(
      `SELECT id, email, password_hash, display_name, role, status
       FROM admin_accounts
       WHERE email = ?
         AND deleted_at IS NULL
       LIMIT 1`,
      [normalizedEmail]
    );
    const adminAccount = adminAccountRows?.[0];
    if (adminAccount && String(adminAccount.status || "").toLowerCase() === "active") {
      const matches = adminAccount.password_hash
        ? await bcrypt.compare(String(password), adminAccount.password_hash)
        : false;
      if (!matches) {
        return res.status(401).json({ message: "Invalid email or password." });
      }
      const role = normalizeAdminAccountRole(adminAccount.role);
      if (!role) {
        return res.status(403).json({ message: "Admin privileges required." });
      }
      await pool.query(
        `UPDATE admin_accounts
         SET last_login_at = NOW()
         WHERE id = ?
         LIMIT 1`,
        [Number(adminAccount.id)]
      );
      const ip = getClientIp(req);
      const { token, sessionId } = issueAdminSessionToken({
        adminAccountId: Number(adminAccount.id),
        email: adminAccount.email,
        displayName: adminAccount.display_name || "",
        role,
      });
      await insertAdminAuditLog({
        adminAccountId: Number(adminAccount.id),
        action: "admin-login",
        targetType: "admin_account",
        targetId: Number(adminAccount.id),
        details: { note: "Authenticated to standalone admin panel", ip: ip || null },
      });
      return res.json({
        ok: true,
        token,
        sessionId,
        user: {
          id: Number(adminAccount.id),
          accountType: "admin_account",
          email: adminAccount.email || "",
          displayName: adminAccount.display_name || "",
          username: "",
          role,
        },
      });
    }

    const [rows] = await pool.query(
      `SELECT id, email, password_hash, display_name, username, role
       FROM users
       WHERE email = ?
       LIMIT 1`,
      [normalizedEmail]
    );
    const user = rows?.[0];
    if (!user) {
      return res.status(401).json({ message: "Invalid email or password." });
    }
    const role = String(user.role || "").toLowerCase();
    if (role !== "admin" && role !== "superadmin") {
      return res.status(403).json({ message: "Admin privileges required." });
    }
    const matches = await bcrypt.compare(String(password), user.password_hash);
    if (!matches) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

    const ip = getClientIp(req);
    try {
      await pool.query(
        `UPDATE users
         SET last_login_at = NOW(),
             last_login_ip = ?
         WHERE id = ?
         LIMIT 1`,
        [ip || null, Number(user.id)]
      );
    } catch (updateError) {
      if (updateError?.code !== "ER_BAD_FIELD_ERROR") {
        console.error(updateError);
      }
    }

    const { token, sessionId } = issueAdminSessionToken({
      userId: Number(user.id),
      email: user.email,
      username: user.username,
      role,
    });
    await insertAdminAuditLog({
      adminId: Number(user.id),
      action: "admin-login",
      targetType: "user",
      targetId: Number(user.id),
      details: { note: "Authenticated to standalone admin panel", ip: ip || null },
    });
    return res.json({
      ok: true,
      token,
      sessionId,
      user: {
        id: Number(user.id),
        email: user.email || "",
        displayName: user.display_name || "",
        username: user.username || "",
        role,
      },
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error during admin login." });
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
      "SELECT id, email, password_hash, display_name, username, role, plan, trial_ends_at, pro_ends_at, location_updated_at, receive_voice_calls, receive_video_calls FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1",
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

    const { token, sessionId } = issueSessionToken({
      userId: user.id,
      email: user.email,
      username: user.username,
      role: effective.role,
      plan: effective.plan,
      canPublishVideo: capability.canPublishVideo,
    });

    return res.json({
      token,
      sessionId,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        username: user.username,
        role: effective.role,
        plan: effective.plan,
        receiveVoiceCalls: Number(user.receive_voice_calls ?? 1) === 1,
        receiveVideoCalls: Number(user.receive_video_calls ?? 1) === 1,
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

const io = attachSocket(server, pool, {
  allowedOrigins,
  createUserNotification,
});

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
  scheduleSourceTranscriptJobPump(1000);
});
