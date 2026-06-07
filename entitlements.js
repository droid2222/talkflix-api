const DAILY_USAGE_TABLE = "user_daily_usage";

export const FREE_USAGE_LIMIT_KEYS = Object.freeze({
  contentWatchSeconds: "content_watch_seconds_daily",
  liveAudienceSeconds: "live_audience_seconds_daily",
  liveHostSeconds: "live_host_seconds_daily",
  liveStageSeconds: "live_stage_seconds_daily",
  directCallSeconds: "direct_call_seconds_daily",
  chatAiActions: "chat_ai_actions_daily",
});

export const DEFAULT_FREE_USAGE_LIMITS = Object.freeze({
  [FREE_USAGE_LIMIT_KEYS.contentWatchSeconds]: 15 * 60,
  [FREE_USAGE_LIMIT_KEYS.liveAudienceSeconds]: 30 * 60,
  [FREE_USAGE_LIMIT_KEYS.liveHostSeconds]: 60 * 60,
  [FREE_USAGE_LIMIT_KEYS.liveStageSeconds]: 5 * 60,
  [FREE_USAGE_LIMIT_KEYS.directCallSeconds]: 5 * 60,
  [FREE_USAGE_LIMIT_KEYS.chatAiActions]: 10,
});

const FREE_USAGE_LIMIT_SETTING_PREFIX = "free_usage_limit.";
const FREE_USAGE_LIMIT_LABELS = Object.freeze({
  [FREE_USAGE_LIMIT_KEYS.contentWatchSeconds]: "Video and podcast watch time",
  [FREE_USAGE_LIMIT_KEYS.liveAudienceSeconds]: "Live room audience time",
  [FREE_USAGE_LIMIT_KEYS.liveHostSeconds]: "Live room hosting time",
  [FREE_USAGE_LIMIT_KEYS.liveStageSeconds]: "Live room stage time",
  [FREE_USAGE_LIMIT_KEYS.directCallSeconds]: "Direct call initiation time",
  [FREE_USAGE_LIMIT_KEYS.chatAiActions]: "Direct chat AI actions",
});
const FREE_USAGE_LIMIT_UNITS = Object.freeze({
  [FREE_USAGE_LIMIT_KEYS.contentWatchSeconds]: "seconds",
  [FREE_USAGE_LIMIT_KEYS.liveAudienceSeconds]: "seconds",
  [FREE_USAGE_LIMIT_KEYS.liveHostSeconds]: "seconds",
  [FREE_USAGE_LIMIT_KEYS.liveStageSeconds]: "seconds",
  [FREE_USAGE_LIMIT_KEYS.directCallSeconds]: "seconds",
  [FREE_USAGE_LIMIT_KEYS.chatAiActions]: "actions",
});
const FREE_USAGE_LIMIT_MAXIMUMS = Object.freeze({
  [FREE_USAGE_LIMIT_KEYS.contentWatchSeconds]: 24 * 60 * 60,
  [FREE_USAGE_LIMIT_KEYS.liveAudienceSeconds]: 24 * 60 * 60,
  [FREE_USAGE_LIMIT_KEYS.liveHostSeconds]: 24 * 60 * 60,
  [FREE_USAGE_LIMIT_KEYS.liveStageSeconds]: 24 * 60 * 60,
  [FREE_USAGE_LIMIT_KEYS.directCallSeconds]: 24 * 60 * 60,
  [FREE_USAGE_LIMIT_KEYS.chatAiActions]: 10000,
});

export function freeUsageSettingKey(limitKey) {
  return `${FREE_USAGE_LIMIT_SETTING_PREFIX}${limitKey}`;
}

export function isKnownFreeUsageLimitKey(limitKey) {
  return Object.prototype.hasOwnProperty.call(DEFAULT_FREE_USAGE_LIMITS, String(limitKey || ""));
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(Math.round(parsed), max));
}

function todayUtcDateKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function parsePlanIdentity(row = {}) {
  const role = String(row.role || "user").trim().toLowerCase();
  if (role === "admin" || role === "superadmin") {
    return { role, plan: "pro", isProLike: true };
  }
  const rawPlan = String(row.plan || "free").trim().toLowerCase();
  const now = Date.now();
  if (rawPlan === "trial") {
    const ends = row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : 0;
    return ends && ends > now
      ? { role, plan: "trial", isProLike: true }
      : { role, plan: "free", isProLike: false };
  }
  if (rawPlan === "pro") {
    const ends = row.pro_ends_at ? new Date(row.pro_ends_at).getTime() : 0;
    return !row.pro_ends_at || ends > now
      ? { role, plan: "pro", isProLike: true }
      : { role, plan: "free", isProLike: false };
  }
  return { role, plan: "free", isProLike: false };
}

export async function ensureEntitlementTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${DAILY_USAGE_TABLE} (
      user_id INT NOT NULL,
      usage_key VARCHAR(80) NOT NULL,
      usage_date DATE NOT NULL,
      used_amount INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, usage_key, usage_date),
      KEY idx_user_daily_usage_date_key (usage_date, usage_key),
      CONSTRAINT fk_user_daily_usage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

export async function readFreeUsageLimits(pool) {
  const defaults = { ...DEFAULT_FREE_USAGE_LIMITS };
  const keys = Object.keys(defaults);
  const settingKeys = keys.map(freeUsageSettingKey);
  try {
    const placeholders = settingKeys.map(() => "?").join(",");
    const [rows] = await pool.query(
      `SELECT setting_key, setting_value
       FROM app_settings
       WHERE setting_key IN (${placeholders})`,
      settingKeys
    );
    for (const row of rows || []) {
      const settingKey = String(row.setting_key || "");
      const limitKey = settingKey.startsWith(FREE_USAGE_LIMIT_SETTING_PREFIX)
        ? settingKey.slice(FREE_USAGE_LIMIT_SETTING_PREFIX.length)
        : "";
      if (!isKnownFreeUsageLimitKey(limitKey)) continue;
      defaults[limitKey] = clampInteger(
        row.setting_value,
        defaults[limitKey],
        0,
        FREE_USAGE_LIMIT_MAXIMUMS[limitKey]
      );
    }
  } catch (error) {
    if (
      error?.code !== "ER_NO_SUCH_TABLE" &&
      error?.code !== "ER_BAD_FIELD_ERROR"
    ) {
      console.error("[entitlements] failed to read free usage limits", error);
    }
  }
  return defaults;
}

export function serializeFreeUsageLimits(limits) {
  return Object.keys(DEFAULT_FREE_USAGE_LIMITS).map((key) => {
    const unit = FREE_USAGE_LIMIT_UNITS[key];
    const amount = clampInteger(
      limits?.[key],
      DEFAULT_FREE_USAGE_LIMITS[key],
      0,
      FREE_USAGE_LIMIT_MAXIMUMS[key]
    );
    return {
      key,
      label: FREE_USAGE_LIMIT_LABELS[key],
      unit,
      amount,
      minutes: unit === "seconds" ? Math.round((amount / 60) * 100) / 100 : null,
      unlimitedForPro: true,
    };
  });
}

export function normalizeFreeUsageLimitUpdate(body = {}) {
  const updates = {};
  for (const key of Object.keys(DEFAULT_FREE_USAGE_LIMITS)) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const unit = FREE_USAGE_LIMIT_UNITS[key];
    const rawValue = body[key];
    const amount = unit === "seconds" && typeof rawValue === "object"
      ? Number(rawValue.seconds ?? Number(rawValue.minutes || 0) * 60)
      : Number(rawValue);
    if (!Number.isFinite(amount)) {
      throw new Error(`${key} must be a number.`);
    }
    updates[key] = clampInteger(amount, DEFAULT_FREE_USAGE_LIMITS[key], 0, FREE_USAGE_LIMIT_MAXIMUMS[key]);
  }
  return updates;
}

export async function loadUserPlanIdentity(pool, userId) {
  const resolvedUserId = Number(userId || 0);
  if (!resolvedUserId) return { role: "guest", plan: "free", isProLike: false };
  const [rows] = await pool.query(
    `SELECT id, role, plan, trial_ends_at, pro_ends_at
     FROM users
     WHERE id = ?
       AND deleted_at IS NULL
     LIMIT 1`,
    [resolvedUserId]
  );
  if (!rows?.length) return { role: "guest", plan: "free", isProLike: false };
  return parsePlanIdentity(rows[0]);
}

export async function getDailyUsageState(pool, { userId, usageKey, limits = null } = {}) {
  const resolvedUserId = Number(userId || 0);
  const key = String(usageKey || "").trim();
  if (!resolvedUserId || !isKnownFreeUsageLimitKey(key)) {
    throw new Error("Invalid daily usage lookup.");
  }
  const resolvedLimits = limits || await readFreeUsageLimits(pool);
  const limitAmount = clampInteger(
    resolvedLimits[key],
    DEFAULT_FREE_USAGE_LIMITS[key],
    0,
    FREE_USAGE_LIMIT_MAXIMUMS[key]
  );
  const usageDate = todayUtcDateKey();
  const [rows] = await pool.query(
    `SELECT used_amount
     FROM ${DAILY_USAGE_TABLE}
     WHERE user_id = ?
       AND usage_key = ?
       AND usage_date = ?
     LIMIT 1`,
    [resolvedUserId, key, usageDate]
  );
  const usedAmount = Math.max(0, Number(rows?.[0]?.used_amount || 0));
  return {
    key,
    usageDate,
    unit: FREE_USAGE_LIMIT_UNITS[key],
    limitAmount,
    usedAmount,
    remainingAmount: Math.max(0, limitAmount - usedAmount),
    unlimited: false,
  };
}

export async function assertDailyUsageAvailable(pool, { userId, usageKey, amount = 1 } = {}) {
  const identity = await loadUserPlanIdentity(pool, userId);
  const key = String(usageKey || "").trim();
  if (identity.isProLike) {
    return {
      ok: true,
      pro: true,
      usage: {
        key,
        unlimited: true,
        limitAmount: null,
        usedAmount: null,
        remainingAmount: null,
        unit: FREE_USAGE_LIMIT_UNITS[key] || "units",
      },
    };
  }
  const state = await getDailyUsageState(pool, { userId, usageKey: key });
  const required = Math.max(1, Math.round(Number(amount || 1)));
  if (state.remainingAmount < required) {
    return {
      ok: false,
      pro: false,
      code: "FREE_USAGE_LIMIT_REACHED",
      message: buildUsageLimitMessage(state),
      usage: state,
    };
  }
  return { ok: true, pro: false, usage: state };
}

export async function consumeDailyUsage(pool, { userId, usageKey, amount = 1 } = {}) {
  const identity = await loadUserPlanIdentity(pool, userId);
  const key = String(usageKey || "").trim();
  if (identity.isProLike) {
    return {
      ok: true,
      pro: true,
      usage: {
        key,
        unlimited: true,
        limitAmount: null,
        usedAmount: null,
        remainingAmount: null,
        unit: FREE_USAGE_LIMIT_UNITS[key] || "units",
      },
    };
  }

  const resolvedUserId = Number(userId || 0);
  if (!resolvedUserId || !isKnownFreeUsageLimitKey(key)) {
    throw new Error("Invalid daily usage consumption.");
  }
  const increment = Math.max(1, Math.round(Number(amount || 1)));
  const limits = await readFreeUsageLimits(pool);
  const limitAmount = clampInteger(
    limits[key],
    DEFAULT_FREE_USAGE_LIMITS[key],
    0,
    FREE_USAGE_LIMIT_MAXIMUMS[key]
  );
  const usageDate = todayUtcDateKey();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO ${DAILY_USAGE_TABLE} (user_id, usage_key, usage_date, used_amount)
       VALUES (?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE used_amount = used_amount`,
      [resolvedUserId, key, usageDate]
    );
    const [rows] = await connection.query(
      `SELECT used_amount
       FROM ${DAILY_USAGE_TABLE}
       WHERE user_id = ?
         AND usage_key = ?
         AND usage_date = ?
       FOR UPDATE`,
      [resolvedUserId, key, usageDate]
    );
    const usedAmount = Math.max(0, Number(rows?.[0]?.used_amount || 0));
    if (usedAmount + increment > limitAmount) {
      await connection.rollback();
      const usage = {
        key,
        usageDate,
        unit: FREE_USAGE_LIMIT_UNITS[key],
        limitAmount,
        usedAmount,
        remainingAmount: Math.max(0, limitAmount - usedAmount),
        unlimited: false,
      };
      return {
        ok: false,
        pro: false,
        code: "FREE_USAGE_LIMIT_REACHED",
        message: buildUsageLimitMessage(usage),
        usage,
      };
    }
    await connection.query(
      `INSERT INTO ${DAILY_USAGE_TABLE} (user_id, usage_key, usage_date, used_amount)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE used_amount = used_amount + VALUES(used_amount)`,
      [resolvedUserId, key, usageDate, increment]
    );
    await connection.commit();
    const nextUsedAmount = usedAmount + increment;
    return {
      ok: true,
      pro: false,
      usage: {
        key,
        usageDate,
        unit: FREE_USAGE_LIMIT_UNITS[key],
        limitAmount,
        usedAmount: nextUsedAmount,
        remainingAmount: Math.max(0, limitAmount - nextUsedAmount),
        unlimited: false,
      },
    };
  } catch (error) {
    try {
      await connection.rollback();
    } catch {}
    throw error;
  } finally {
    connection.release();
  }
}

export function buildUsageLimitMessage(usage) {
  const label = FREE_USAGE_LIMIT_LABELS[usage?.key] || "This feature";
  const unit = usage?.unit || "units";
  if (unit === "seconds") {
    const minutes = Math.max(0, Math.round(Number(usage?.limitAmount || 0) / 60));
    return `${label} is limited to ${minutes} minutes per day on the free plan. Upgrade to Talkflix Pro for unlimited access.`;
  }
  return `${label} is limited to ${Number(usage?.limitAmount || 0)} per day on the free plan. Upgrade to Talkflix Pro for unlimited access.`;
}
