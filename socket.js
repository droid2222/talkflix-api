import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import crypto from "crypto";
import http2 from "http2";

const isProduction =
  String(process.env.NODE_ENV || "").trim().toLowerCase() === "production";
const anonCallDebugLoggingEnabled =
  !isProduction &&
  String(process.env.ANON_CALL_DEBUG_LOGS || "1").trim() !== "0";

function logAnonCallDebug(eventName, payload) {
  if (!anonCallDebugLoggingEnabled) return;
  console.log(`[anon-call] ${eventName}`, payload);
}

function logAnonMatch(eventName, payload = {}) {
  console.log(
    `[anon-match] ${eventName}`,
    JSON.stringify({
      ts: Date.now(),
      ...payload,
    })
  );
}

function parseBooleanSettingValue(value, fallback) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function defaultAnonymousMatchZeroCooldownEnabled() {
  return !isProduction;
}

async function refreshAnonymousMatchCooldownSetting(pool, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - anonymousMatchSettingLoadedAt < ANONYMOUS_MATCH_SETTING_CACHE_MS) {
    return anonymousMatchZeroCooldownEnabled;
  }
  anonymousMatchSettingLoadedAt = now;

  try {
    const [rows] = await pool.query(
      `SELECT setting_value
       FROM app_settings
       WHERE setting_key = ?
       LIMIT 1`,
      [ANONYMOUS_MATCH_ZERO_COOLDOWN_SETTING_KEY]
    );
    const fallback = defaultAnonymousMatchZeroCooldownEnabled();
    anonymousMatchZeroCooldownEnabled = rows?.length
      ? parseBooleanSettingValue(rows[0].setting_value, fallback)
      : fallback;
  } catch (error) {
    if (
      error?.code !== "ER_NO_SUCH_TABLE" &&
      error?.code !== "ER_BAD_FIELD_ERROR"
    ) {
      console.error("[match] failed to load anonymous cooldown setting", error);
    }
  }

  return anonymousMatchZeroCooldownEnabled;
}

function getAnonymousRematchCooldownMs() {
  return anonymousMatchZeroCooldownEnabled ? 0 : PRODUCTION_REMATCH_COOLDOWN_MS;
}

function getAnonymousSkipCooldownMs() {
  return anonymousMatchZeroCooldownEnabled ? 0 : PRODUCTION_SKIP_COOLDOWN_MS;
}

// === In-memory state (MVP) ===
const queue = []; // waiting users
const activeMatches = new Map(); // matchId -> { aUserId, bUserId, aSocketId, bSocketId, endsAt, timer }
const pendingCalls = new Map(); // matchId -> { timer, fromUserId, requestedAt }
const pendingDirectCalls = new Map(); // threadId -> { timer, fromUserId, requestedAt }
const liveBroadcasts = new Map(); // broadcastId -> room state
const liveUserSockets = new Map(); // userId -> socketId
const presenceWatchers = new Map(); // watchedUserId -> Set(socketId)
const recentPairs = new Map(); // userId -> Map(otherUserId -> ts)

const ANONYMOUS_MATCH_ZERO_COOLDOWN_SETTING_KEY = "anonymous_match_zero_cooldown";
const ANONYMOUS_MATCH_SETTING_CACHE_MS = 15 * 1000;
const PRODUCTION_REMATCH_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const PRODUCTION_SKIP_COOLDOWN_MS = 30 * 60 * 1000;
const MATCH_DURATION_MS = 10 * 60 * 1000;
const recentSkips = new Map(); // userId -> Map(otherUserId -> ts)
let anonymousMatchZeroCooldownEnabled = defaultAnonymousMatchZeroCooldownEnabled();
let anonymousMatchSettingLoadedAt = 0;
const DIRECT_CALL_TERMINAL_STATES = new Set([
  "declined",
  "cancelled",
  "ended",
  "missed",
  "failed",
]);

let livekitRoomService = null;
const LIVE_STAGE_SLOT_COUNT = 12;
const LIVE_STAGE_SPEAKER_CAPACITY = LIVE_STAGE_SLOT_COUNT - 1;
const DEFAULT_LIVE_BACKGROUND_THEME = "gold";
const DEFAULT_LIVE_COMMENT_THEME = "glass";
const DEFAULT_LIVE_MIC_EFFECT = "pulse";
const LIVE_BACKGROUND_THEMES = new Set(["gold", "red", "blue"]);
const LIVE_COMMENT_THEMES = new Set(["glass", "soft", "aqua", "berry", "mint"]);
const LIVE_MIC_EFFECTS = new Set(["pulse", "halo", "echo", "spotlight"]);
const LIVE_POLL_OPTION_LIMIT = 5;
const LIVE_POLL_DURATION_MS = 60 * 1000;
const LIVE_POLL_RESULT_DISPLAY_MS = 6 * 1000;
const LIVE_GUEST_PREVIEW_MS = 45 * 1000;
const LIVE_GUEST_PREVIEW_GRACE_MS = 5 * 1000;

const GUEST_LIVE_EVENTS = new Set([
  "live:broadcasts:get",
  "live:broadcast:guest-preview:join",
  "live:media:session:get",
]);

async function notifyFollowersOfLiveBroadcast(pool, createUserNotification, room) {
  if (typeof createUserNotification !== "function" || !room?.hostUserId) return;
  const hostUserId = Number(room.hostUserId);
  if (!Number.isFinite(hostUserId) || hostUserId <= 0) return;
  const [rows] = await pool.query(
    `SELECT follower_id
       FROM follows
      WHERE following_id = ?
      LIMIT 1000`,
    [hostUserId]
  );
  const type = String(room.type || "audio").trim().toLowerCase() === "video" ? "video" : "audio";
  const title = type === "video" ? "Live video started" : "Audio room started";
  const hostName = String(room.host || "Someone you follow").trim() || "Someone you follow";
  const roomTitle = String(room.title || "").trim();
  const body = roomTitle
    ? `${hostName} started "${roomTitle}".`
    : `${hostName} started a live ${type === "video" ? "video" : "audio room"}.`;
  for (const row of rows || []) {
    const followerId = Number(row.follower_id);
    if (!Number.isFinite(followerId) || followerId === hostUserId) continue;
    await createUserNotification({
      userId: followerId,
      type: "live_broadcast",
      title,
      body,
      fromUserId: hostUserId,
      fromDisplayName: hostName,
      fromPhotoUrl: room.hostPhoto || "",
      targetId: String(room.id || ""),
    });
  }
}

function normalizeLiveBackgroundTheme(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return LIVE_BACKGROUND_THEMES.has(normalized)
    ? normalized
    : DEFAULT_LIVE_BACKGROUND_THEME;
}

function normalizeLiveCommentTheme(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return LIVE_COMMENT_THEMES.has(normalized)
    ? normalized
    : DEFAULT_LIVE_COMMENT_THEME;
}

function normalizeLiveMicEffect(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return LIVE_MIC_EFFECTS.has(normalized)
    ? normalized
    : DEFAULT_LIVE_MIC_EFFECT;
}

function serializeLivePoll(poll) {
  if (!poll || typeof poll !== "object") return null;
  const options = Array.isArray(poll.options) ? poll.options : [];
  const status = String(poll.status || "active");
  return {
    id: String(poll.id || ""),
    question: String(poll.question || ""),
    options: options.map((option) => ({
      id: String(option.id || ""),
      text: String(option.text || ""),
      votes: Number(option.votes || 0),
    })),
    totalVotes: options.reduce((sum, option) => sum + Number(option.votes || 0), 0),
    status,
    createdAt: Number(poll.createdAt || 0),
    endsAt: Number(poll.endsAt || 0),
    concludedAt: Number(poll.concludedAt || 0),
  };
}

function clearLivePollTimers(room) {
  if (!room) return;
  if (room.activePollTimer) {
    clearTimeout(room.activePollTimer);
    room.activePollTimer = null;
  }
  if (room.activePollClearTimer) {
    clearTimeout(room.activePollClearTimer);
    room.activePollClearTimer = null;
  }
}

function clearLiveRoomState(room) {
  clearLivePollTimers(room);
}

function concludeLivePoll(io, broadcastId, pollId) {
  const room = liveBroadcasts.get(broadcastId);
  const poll = room?.activePoll;
  if (!room || !poll || String(poll.id) !== String(pollId)) return;
  poll.status = "concluded";
  poll.concludedAt = Date.now();
  clearLivePollTimers(room);
  bumpLiveRoomVersion(room);
  const serializedPoll = serializeLivePoll(poll);
  io.to(`live:${broadcastId}`).emit("live:poll:update", {
    broadcastId,
    poll: serializedPoll,
  });
  emitLiveRoom(io, broadcastId);
  emitLiveBroadcastList(io);
  room.activePollClearTimer = setTimeout(() => {
    const latestRoom = liveBroadcasts.get(broadcastId);
    if (!latestRoom || String(latestRoom.activePoll?.id || "") !== String(pollId)) {
      return;
    }
    latestRoom.activePoll = null;
    clearLivePollTimers(latestRoom);
    bumpLiveRoomVersion(latestRoom);
    io.to(`live:${broadcastId}`).emit("live:poll:update", {
      broadcastId,
      poll: null,
    });
    emitLiveRoom(io, broadcastId);
    emitLiveBroadcastList(io);
  }, LIVE_POLL_RESULT_DISPLAY_MS);
}

function getLivekitPublicUrl() {
  const explicit = String(process.env.LIVEKIT_URL || "").trim();
  if (explicit) return explicit;
  const apiBase = String(process.env.PUBLIC_API_BASE_URL || "").trim().replace(/\/$/, "");
  if (!apiBase) return "";
  return `${apiBase.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}/livekit`;
}

function getLivekitApiHost() {
  const explicit = String(process.env.LIVEKIT_API_HOST || "").trim();
  if (explicit) return explicit;
  const publicUrl = getLivekitPublicUrl();
  if (!publicUrl) return "";
  return publicUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

function hasLivekitConfig() {
  return (
    getLivekitPublicUrl().length > 0 &&
    getLivekitApiHost().length > 0 &&
    String(process.env.LIVEKIT_API_KEY || "").trim().length > 0 &&
    String(process.env.LIVEKIT_API_SECRET || "").trim().length > 0
  );
}

function getLivekitRoomService() {
  if (!hasLivekitConfig()) return null;
  if (!livekitRoomService) {
    livekitRoomService = new RoomServiceClient(
      getLivekitApiHost(),
      String(process.env.LIVEKIT_API_KEY || "").trim(),
      String(process.env.LIVEKIT_API_SECRET || "").trim()
    );
  }
  return livekitRoomService;
}

function isLiveSpeaker(room, userId) {
  return (room?.speakers || []).some(
    (speaker) => speaker && String(speaker.userId) === String(userId)
  );
}

function canPublishLiveAudio(room, userId) {
  if (!room || room.type !== "audio") return false;
  return room.hostUserId === String(userId) || isLiveSpeaker(room, userId);
}

function isLiveRoomMember(room, userId) {
  const resolvedUserId = String(userId || "");
  if (!room || !resolvedUserId) return false;
  if (room.hostUserId === resolvedUserId) return true;
  if (isLiveSpeaker(room, resolvedUserId)) return true;
  return (room.audienceMembers || []).some(
    (member) => String(member.userId) === resolvedUserId
  );
}

function normalizeLiveStageSlots(room) {
  if (!room) return;
  const hostUserId = String(room.hostUserId || "");
  const rawSpeakers = Array.isArray(room.speakers) ? room.speakers : [];
  let hostSpeaker = null;
  const stageSpeakers = [];

  for (const speaker of rawSpeakers) {
    if (!speaker) continue;
    if (
      hostSpeaker == null &&
      hostUserId.length > 0 &&
      String(speaker.userId || "") === hostUserId
    ) {
      hostSpeaker = {
        ...speaker,
        role: "Host",
      };
      continue;
    }
    stageSpeakers.push(speaker);
  }

  if (!hostSpeaker) {
    hostSpeaker = {
      id: `host-${hostUserId}`,
      userId: hostUserId,
      name: String(room.host || "Host"),
      photo: room.hostPhoto || "",
      role: "Host",
      muted: false,
    };
  }

  room.speakers = [hostSpeaker, ...stageSpeakers.slice(0, LIVE_STAGE_SPEAKER_CAPACITY)];
  while (room.speakers.length < LIVE_STAGE_SLOT_COUNT) {
    room.speakers.push(null);
  }
}

function resolveLiveParticipantName(room, userId, fallbackName = "") {
  const resolvedFallback = String(fallbackName || "").trim();
  if (!room) return resolvedFallback || `User ${userId}`;
  if (room.hostUserId === String(userId)) {
    return String(room.host || resolvedFallback || `User ${userId}`);
  }
  const speaker = (room.speakers || []).find(
    (item) => item && String(item.userId) === String(userId)
  );
  if (speaker?.name) return String(speaker.name);
  const audience = (room.audienceMembers || []).find(
    (item) => String(item.userId) === String(userId)
  );
  if (audience?.name) return String(audience.name);
  return resolvedFallback || `User ${userId}`;
}

function findLiveParticipant(room, userId) {
  const resolvedUserId = String(userId || "");
  if (!room || !resolvedUserId) return null;
  if (String(room.hostUserId || "") === resolvedUserId) {
    return {
      userId: resolvedUserId,
      name: String(room.host || `User ${resolvedUserId}`),
      photo: room.hostPhoto || "",
    };
  }
  const collections = [
    room.speakers || [],
    room.audienceMembers || [],
    room.joinRequests || [],
    room.pendingStageApprovals || [],
    room.moderators || [],
  ];
  for (const collection of collections) {
    const match = collection.find(
      (item) => item && String(item.userId || "") === resolvedUserId
    );
    if (match) {
      return {
        userId: resolvedUserId,
        name: String(match.name || `User ${resolvedUserId}`),
        photo: match.photo || "",
      };
    }
  }
  return null;
}

function resolveLiveParticipantRole(room, userId) {
  const resolvedUserId = String(userId || "");
  if (!room || !resolvedUserId) return "";
  if (String(room.hostUserId || "") === resolvedUserId) return "host";
  if (
    (room.moderators || []).some(
      (moderator) => String(moderator?.userId || "") === resolvedUserId
    )
  ) {
    return "moderator";
  }
  if (isLiveSpeaker(room, resolvedUserId)) return "speaker";
  if (
    (room.audienceMembers || []).some(
      (member) => String(member?.userId || "") === resolvedUserId
    )
  ) {
    return "listener";
  }
  return "";
}

function resolveLiveCommentTheme(socket, value) {
  if (!isProLike(socket.user || {})) return DEFAULT_LIVE_COMMENT_THEME;
  return normalizeLiveCommentTheme(value);
}

async function buildLiveMediaSession({
  room,
  userId,
  participantName,
  canPublish,
  ttl,
}) {
  if (!hasLivekitConfig() || !room || room.type !== "audio") return null;
  const apiKey = String(process.env.LIVEKIT_API_KEY || "").trim();
  const apiSecret = String(process.env.LIVEKIT_API_SECRET || "").trim();
  const tokenOptions = {
    identity: String(userId),
    name: resolveLiveParticipantName(room, userId, participantName),
  };
  if (ttl) tokenOptions.ttl = ttl;
  const accessToken = new AccessToken(apiKey, apiSecret, tokenOptions);
  accessToken.addGrant({
    roomJoin: true,
    room: String(room.id),
    canSubscribe: true,
    canPublish: Boolean(canPublish),
    canPublishData: true,
  });
  return {
    url: getLivekitPublicUrl(),
    token: await accessToken.toJwt(),
    canPublish: Boolean(canPublish),
  };
}

function clearGuestLivePreviewTimer(socket) {
  if (socket?.data?.liveGuestPreviewTimer) {
    clearTimeout(socket.data.liveGuestPreviewTimer);
    socket.data.liveGuestPreviewTimer = null;
  }
}

async function removeLivekitPreviewParticipant(roomId, userId) {
  const roomService = getLivekitRoomService();
  if (!roomService || !roomId || !userId) return;
  try {
    await roomService.removeParticipant(String(roomId), String(userId));
  } catch (error) {
    const message = String(error?.message || error || "");
    if (!message.toLowerCase().includes("not found")) {
      console.error("[livekit] guest preview removeParticipant failed", {
        roomId,
        userId,
        error: message,
      });
    }
  }
}

function endGuestLivePreview(io, socket, broadcastId, reason = "preview_ended") {
  const roomId = String(broadcastId || socket?.data?.liveBroadcastId || "");
  const userId = String(socket?.user?.userId || "");
  clearGuestLivePreviewTimer(socket);
  socket.emit("live:guest-preview:ended", {
    broadcastId: roomId,
    reason,
    signUpRequired: true,
  });
  socket.leave(`live:${roomId}`);
  socket.data.liveBroadcastId = null;
  socket.data.liveBroadcastRole = null;
  void removeLivekitPreviewParticipant(roomId, userId);
}

async function emitLiveMediaSession(io, room, userId, participantName = "") {
  const mediaSession = await buildLiveMediaSession({
    room,
    userId,
    participantName,
    canPublish: canPublishLiveAudio(room, userId),
  });
  if (mediaSession) {
    io.to(`user:${userId}`).emit("live:media:session", {
      broadcastId: room.id,
      mediaSession,
    });
  }
  return mediaSession;
}

async function updateLivekitParticipantPermission(room, userId, canPublish) {
  const roomService = getLivekitRoomService();
  if (!roomService || !room || room.type !== "audio") return false;
  try {
    await roomService.updateParticipant(
      String(room.id),
      String(userId),
      undefined,
      {
        canPublish: Boolean(canPublish),
        canSubscribe: true,
        canPublishData: true,
      }
    );
    return true;
  } catch (error) {
    console.error("[livekit] updateParticipant failed", {
      roomId: room.id,
      userId: String(userId),
      canPublish: Boolean(canPublish),
      error: error?.message || error,
    });
    return false;
  }
}

function rememberSkip(a, b) {
  const now = Date.now();
  if (!recentSkips.has(a)) recentSkips.set(a, new Map());
  if (!recentSkips.has(b)) recentSkips.set(b, new Map());
  recentSkips.get(a).set(b, now);
  recentSkips.get(b).set(a, now);
}

function hasRecentSkip(a, b) {
  const now = Date.now();
  const m = recentSkips.get(a);
  const ts = m?.get(b);
  if (!ts) return false;
  return now - ts < getAnonymousSkipCooldownMs();
}

function cleanupSkips() {
  const now = Date.now();
  const cooldownMs = getAnonymousSkipCooldownMs();
  for (const [u, m] of recentSkips.entries()) {
    for (const [v, ts] of m.entries()) {
      if (now - ts >= cooldownMs) m.delete(v);
    }
    if (m.size === 0) recentSkips.delete(u);
  }
}





function isProLike({ role, plan }) {
  return role === "admin" || plan === "pro" || plan === "trial";
}

function resolveExpectedSocketIdentity(payload = {}) {
  return {
    expectedUserId: String(payload?.expectedUserId || "").trim(),
    expectedSessionId: String(payload?.expectedSessionId || "").trim(),
  };
}

function socketIdentityMatches(socket, payload = {}) {
  const { expectedUserId, expectedSessionId } = resolveExpectedSocketIdentity(payload);
  if (!expectedUserId && !expectedSessionId) return true;
  if (expectedUserId && expectedUserId !== String(socket.user?.userId || "")) {
    return false;
  }
  if (expectedSessionId && expectedSessionId !== String(socket.user?.sessionId || "")) {
    return false;
  }
  return true;
}

function rememberPair(a, b) {
  const now = Date.now();
  if (!recentPairs.has(a)) recentPairs.set(a, new Map());
  if (!recentPairs.has(b)) recentPairs.set(b, new Map());
  recentPairs.get(a).set(b, now);
  recentPairs.get(b).set(a, now);
}

function hasRecentPair(a, b) {
  const now = Date.now();
  const m = recentPairs.get(a);
  const ts = m?.get(b);
  if (!ts) return false;
  return now - ts < getAnonymousRematchCooldownMs();
}

function cleanupRecentPairs() {
  const now = Date.now();
  const cooldownMs = getAnonymousRematchCooldownMs();
  for (const [u, m] of recentPairs.entries()) {
    for (const [v, ts] of m.entries()) {
      if (now - ts >= cooldownMs) m.delete(v);
    }
    if (m.size === 0) recentPairs.delete(u);
  }
}

export function resetAnonymousMatchHistory({ actor = {} } = {}) {
  const recentPairUsers = recentPairs.size;
  const recentSkipUsers = recentSkips.size;
  let recentPairEntries = 0;
  let recentSkipEntries = 0;

  for (const matches of recentPairs.values()) {
    recentPairEntries += matches.size;
  }
  for (const skips of recentSkips.values()) {
    recentSkipEntries += skips.size;
  }

  recentPairs.clear();
  recentSkips.clear();

  logAnonMatch("history_reset", {
    actorAdminId: actor.adminId || null,
    actorAdminAccountId: actor.adminAccountId || null,
    recentPairUsers,
    recentPairEntries,
    recentSkipUsers,
    recentSkipEntries,
    queueSize: queue.length,
    activeMatchCount: activeMatches.size,
  });

  return {
    recentPairUsers,
    recentPairEntries,
    recentSkipUsers,
    recentSkipEntries,
    queueSize: queue.length,
    activeMatchCount: activeMatches.size,
  };
}

function ensureLiveRoomVersionState(room) {
  if (!room) return;
  normalizeLiveStageSlots(room);
  if (!Number.isFinite(room.roomVersion)) room.roomVersion = 1;
  if (!Number.isFinite(room.speakerVersion)) room.speakerVersion = 1;
  if (!Number.isFinite(room.speakingSeq)) room.speakingSeq = 0;
}

function bumpLiveRoomVersion(room) {
  ensureLiveRoomVersionState(room);
  room.roomVersion += 1;
  return room.roomVersion;
}

function bumpLiveSpeakerVersion(room) {
  ensureLiveRoomVersionState(room);
  room.speakerVersion += 1;
  room.roomVersion += 1;
  return room.speakerVersion;
}

function nextLiveSpeakingSeq(room) {
  ensureLiveRoomVersionState(room);
  room.speakingSeq += 1;
  return room.speakingSeq;
}

function liveAckError(code, message, extra = {}) {
  return {
    ok: false,
    code,
    message,
    ...extra,
  };
}

function auditLiveModeration(action, details) {
  console.info(
    "[live][moderation]",
    JSON.stringify({
      action,
      ts: Date.now(),
      ...details,
    })
  );
}

function yearsOld(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

// Mutual match check (fast, no “native/learner” priority)
function mutualCriteria(a, b) {
  if (String(a.userId) === String(b.userId)) return false;
  if (a.criteria.language !== b.criteria.language) return false;

  // gender filter
  if (a.criteria.gender !== "any" && b.gender && b.gender !== a.criteria.gender) return false;
  if (b.criteria.gender !== "any" && a.gender && a.gender !== b.criteria.gender) return false;

  // age filter
  if (b.age != null && (b.age < a.criteria.ageMin || b.age > a.criteria.ageMax)) return false;
  if (a.age != null && (a.age < b.criteria.ageMin || a.age > b.criteria.ageMax)) return false;

  return true;
}

function removeFromQueue(socketId) {
  const idx = queue.findIndex((q) => q.socketId === socketId);
  if (idx >= 0) {
    const [removed] = queue.splice(idx, 1);
    logAnonMatch("queue_remove", {
      socketId,
      userId: removed?.userId || "",
      queueSize: queue.length,
    });
  }
}

function removeUserFromQueue(userId, exceptSocketId = "") {
  const normalizedUserId = String(userId || "");
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const entry = queue[i];
    if (
      String(entry.userId) === normalizedUserId &&
      (!exceptSocketId || entry.socketId !== exceptSocketId)
    ) {
      queue.splice(i, 1);
      logAnonMatch("queue_remove_duplicate_user", {
        userId: normalizedUserId,
        socketId: entry.socketId,
        keptSocketId: exceptSocketId || "",
        queueSize: queue.length,
      });
    }
  }
}

function isUserInActiveMatch(userId) {
  const normalizedUserId = String(userId || "");
  if (!normalizedUserId) return false;
  for (const match of activeMatches.values()) {
    if (
      String(match.aUserId) === normalizedUserId ||
      String(match.bUserId) === normalizedUserId
    ) {
      return true;
    }
  }
  return false;
}

function isSocketInMatch(socket, matchId) {
  const normalizedMatchId = String(matchId || "").trim();
  if (!normalizedMatchId || String(socket?.data?.matchId || "") !== normalizedMatchId) {
    return false;
  }
  const info = activeMatches.get(normalizedMatchId);
  if (!info) return false;
  return (
    info.aSocketId === socket.id ||
    info.bSocketId === socket.id
  );
}

function rejectIfNotInMatch(socket, matchId, ack, eventName) {
  if (isSocketInMatch(socket, matchId)) return false;
  logAnonMatch("stale_match_event_rejected", {
    eventName,
    matchId: String(matchId || ""),
    userId: socket.user?.userId || "",
    socketId: socket.id,
    socketMatchId: socket.data?.matchId || "",
  });
  ack?.({ ok: false, message: "match not active" });
  return true;
}

function clearPendingCall(io, matchId) {
  const pending = pendingCalls.get(matchId);
  if (pending?.timer) clearTimeout(pending.timer);
  pendingCalls.delete(matchId);
}

function clearPendingDirectCall(io, threadId) {
  const pending = pendingDirectCalls.get(threadId);
  if (pending?.timer) clearTimeout(pending.timer);
  pendingDirectCalls.delete(threadId);
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
  if (ids.length !== 2) return false;
  return ids.includes(String(userId));
}

function getOtherDirectThreadUserId(threadId, userId) {
  const ids = parseDirectThreadMemberIds(threadId);
  if (ids.length !== 2) return "";
  return ids.find((id) => id !== String(userId)) || "";
}

async function getDirectBlockState(pool, viewerId, otherId) {
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
    if (String(row.blocker_id) === String(viewerId) && String(row.blocked_id) === String(otherId)) {
      youBlockedUser = true;
    }
    if (String(row.blocker_id) === String(otherId) && String(row.blocked_id) === String(viewerId)) {
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

async function getDirectCallPermissionState(pool, ownerUserId, peerUserId) {
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
    globalReceiveVoiceCalls,
    globalReceiveVideoCalls,
    receiveVoiceCalls:
      rawReceiveVoiceCalls == null
        ? globalReceiveVoiceCalls
        : rawReceiveVoiceCalls,
    receiveVideoCalls:
      rawReceiveVideoCalls == null
        ? globalReceiveVideoCalls
        : rawReceiveVideoCalls,
  };
}

function buildDirectCallPermissionMessage({ video }) {
  return video
    ? "Ask this user to enable video call permission for you before calling."
    : "Ask this user to enable voice call permission for you before calling.";
}

function base64UrlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function normalizePemValue(rawValue) {
  const trimmed = String(rawValue || "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/\\n/g, "\n");
}

function createUuidV4Fallback() {
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function createDirectCallId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : createUuidV4Fallback();
}

function safeJsonStringify(value) {
  try {
    return value == null ? null : JSON.stringify(value);
  } catch {
    return null;
  }
}

async function recordDirectCallEvent(
  pool,
  {
    callId,
    threadId,
    eventType,
    userId = null,
    actorUserId = null,
    deliveryChannel = null,
    success = true,
    errorMessage = null,
    payload = null,
  } = {}
) {
  if (!callId || !threadId || !eventType) return;
  await pool.query(
    `INSERT INTO direct_call_events
       (call_id, thread_id, event_type, user_id, actor_user_id, delivery_channel, success, error_message, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(callId),
      String(threadId),
      String(eventType),
      userId == null ? null : Number(userId),
      actorUserId == null ? null : Number(actorUserId),
      deliveryChannel ? String(deliveryChannel) : null,
      success ? 1 : 0,
      errorMessage ? String(errorMessage).slice(0, 512) : null,
      safeJsonStringify(payload),
    ]
  );
}

function getDirectCallApnsConfig() {
  const teamId = String(process.env.APNS_TEAM_ID || "").trim();
  const keyId = String(process.env.APNS_KEY_ID || "").trim();
  const privateKey = normalizePemValue(process.env.APNS_PRIVATE_KEY || "");
  const bundleId = String(process.env.APNS_BUNDLE_ID || process.env.IOS_BUNDLE_ID || "").trim();
  if (!teamId || !keyId || !privateKey || !bundleId) return null;
  return {
    teamId,
    keyId,
    privateKey,
    bundleId,
    voipTopic: String(process.env.APNS_VOIP_TOPIC || `${bundleId}.voip`).trim(),
    authority:
      String(process.env.APNS_USE_SANDBOX || "").trim() === "1"
        ? "https://api.sandbox.push.apple.com"
        : "https://api.push.apple.com",
  };
}

function createApnsJwtToken(config) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64UrlEncode(JSON.stringify({ iss: config.teamId, iat: issuedAt }));
  const unsigned = `${header}.${claims}`;
  const signer = crypto.createSign("sha256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(config.privateKey);
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

function getDirectCallFcmConfig() {
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
      console.error("[direct-call] Failed to parse FCM_SERVICE_ACCOUNT_JSON", error);
    }
  }
  const projectId = String(process.env.FCM_PROJECT_ID || "").trim();
  const clientEmail = String(process.env.FCM_CLIENT_EMAIL || "").trim();
  const privateKey = normalizePemValue(process.env.FCM_PRIVATE_KEY || "");
  if (!projectId || !clientEmail || !privateKey) return null;
  return { projectId, clientEmail, privateKey };
}

let cachedFcmAccessToken = "";
let cachedFcmAccessTokenExpiresAt = 0;

async function getFcmAccessToken() {
  const config = getDirectCallFcmConfig();
  if (!config) return null;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (cachedFcmAccessToken && cachedFcmAccessTokenExpiresAt - 60 > nowSeconds) {
    return cachedFcmAccessToken;
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
  cachedFcmAccessToken = String(payload.access_token);
  cachedFcmAccessTokenExpiresAt = nowSeconds + Number(payload.expires_in || 3600);
  return cachedFcmAccessToken;
}

async function fetchDirectCallUserProfile(pool, userId) {
  if (!userId) return null;
  const [rows] = await pool.query(
    `SELECT id, display_name, profile_photo_url
       FROM users
      WHERE id = ?
      LIMIT 1`,
    [Number(userId)]
  );
  const row = rows?.[0];
  if (!row) return null;
  return {
    id: String(row.id),
    displayName: String(row.display_name || ""),
    photoUrl: String(row.profile_photo_url || ""),
  };
}

async function fetchDirectCallDevices(pool, userId) {
  if (!userId) return [];
  const [rows] = await pool.query(
    `SELECT id, user_id, platform, push_provider, device_token, app_bundle, device_label,
            enabled, last_seen_at, last_verified_at, last_push_success_at,
            last_push_failure_at, last_push_error, consecutive_failures
       FROM direct_call_devices
      WHERE user_id = ?
        AND enabled = 1`,
    [Number(userId)]
  );
  return rows || [];
}

function supportsBackgroundDirectCallPush(device) {
  const channel = String(device?.push_provider || "").trim().toLowerCase();
  return channel === "voip_apns" || channel === "fcm";
}

const DIRECT_CALL_DEVICE_VERIFIED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const DIRECT_CALL_MAX_CONSECUTIVE_FAILURES = 3;

function parseDirectCallTimestampMs(value) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isHealthyBackgroundDirectCallDevice(device) {
  if (Number(device?.enabled || 0) !== 1) return false;
  if (!supportsBackgroundDirectCallPush(device)) return false;
  const verifiedMs = parseDirectCallTimestampMs(device?.last_verified_at || device?.last_seen_at);
  if (!verifiedMs) return false;
  if (Date.now() - verifiedMs > DIRECT_CALL_DEVICE_VERIFIED_WINDOW_MS) {
    return false;
  }
  const failureMs = parseDirectCallTimestampMs(device?.last_push_failure_at);
  const successMs = parseDirectCallTimestampMs(device?.last_push_success_at);
  const failures = Number(device?.consecutive_failures || 0);
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

function directCallRelayAvailable() {
  const isTurnRelayUrl = (url) => {
    const value = String(url || "").toLowerCase();
    return value.startsWith("turn:") || value.startsWith("turns:");
  };
  const rawJson = String(process.env.RTC_ICE_SERVERS_JSON || "").trim();
  if (rawJson) {
    try {
      const decoded = JSON.parse(rawJson);
      if (
        Array.isArray(decoded) &&
        decoded.some((server) =>
          (Array.isArray(server?.urls) ? server.urls : [server?.urls]).some((url) =>
            isTurnRelayUrl(url)
          )
        )
      ) {
        return true;
      }
    } catch (error) {
      console.error("[direct-call] Failed to parse RTC_ICE_SERVERS_JSON", error);
    }
  }
  const turnUrl = String(process.env.RTC_TURN_URL || "").trim().toLowerCase();
  const turnUsername = String(process.env.RTC_TURN_USERNAME || "").trim();
  const turnCredential = String(process.env.RTC_TURN_CREDENTIAL || "").trim();
  return isTurnRelayUrl(turnUrl) && turnUsername.length > 0 && turnCredential.length > 0;
}

function hasLiveUserSocket(io, userId) {
  if (!io || !userId) return false;
  return (io.sockets.adapter.rooms.get(`user:${userId}`)?.size || 0) > 0;
}

async function resolveDirectCallReachability(io, pool, userId) {
  const devices = await fetchDirectCallDevices(pool, userId);
  return {
    hasLiveSocket: hasLiveUserSocket(io, userId),
    devices,
    callableDevices: devices.filter((device) =>
      isHealthyBackgroundDirectCallDevice(device)
    ),
  };
}

async function updateDirectCallDevicePushHealth(pool, device, result) {
  if (!pool || !device?.id || result?.skipped === true) return;
  if (result?.ok === true) {
    await pool.query(
      `UPDATE direct_call_devices
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
    `UPDATE direct_call_devices
        SET last_push_failure_at = NOW(),
            last_push_error = ?,
            consecutive_failures = COALESCE(consecutive_failures, 0) + 1
      WHERE id = ?`,
    [errorMessage || "push_failed", Number(device.id)]
  );
}

async function sendVoipApnsPush(deviceToken, payload) {
  const config = getDirectCallApnsConfig();
  if (!config) {
    return { ok: false, skipped: true, error: "missing_apns_config" };
  }
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
      authorization: `bearer ${createApnsJwtToken(config)}`,
      "apns-topic": config.voipTopic,
      "apns-push-type": "voip",
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

async function sendFcmPush(deviceToken, payload, session) {
  const config = getDirectCallFcmConfig();
  if (!config) {
    return { ok: false, skipped: true, error: "missing_fcm_config" };
  }
  const accessToken = await getFcmAccessToken();
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
          data: Object.fromEntries(
            Object.entries(payload).map(([key, value]) => [key, String(value ?? "")])
          ),
          android: {
            priority: "high",
            ttl: "30s",
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

async function sendDirectCallDevicePushes(
  pool,
  { session, targetUserId, actorUserId = null, eventType, payload }
) {
  if (!session || !targetUserId || !eventType) return [];
  const devices = await fetchDirectCallDevices(pool, targetUserId);
  const results = [];
  for (const device of devices) {
    const channel = String(device.push_provider || "").trim().toLowerCase();
    let result = { ok: false, skipped: true, error: "unsupported_provider" };
    try {
      if (channel === "voip_apns") {
        result = await sendVoipApnsPush(device.device_token, payload);
      } else if (channel === "fcm") {
        result = await sendFcmPush(device.device_token, payload, session);
      } else {
        result = { ok: false, skipped: true, error: "unsupported_provider" };
      }
    } catch (error) {
      result = { ok: false, error: error?.message || String(error) };
    }
    results.push({ channel, result });
    void updateDirectCallDevicePushHealth(pool, device, result).catch((error) => {
      console.error("[direct-call] Failed to update device push health", error);
    });
    void recordDirectCallEvent(pool, {
      callId: session.callId,
      threadId: session.threadId,
      eventType,
      userId: targetUserId,
      actorUserId,
      deliveryChannel: channel,
      success: result.ok === true,
      errorMessage:
        result.ok === true
          ? null
          : result.error || result.reason || (result.skipped ? "skipped" : "push_failed"),
      payload: {
        skipped: result.skipped === true,
        statusCode: result.statusCode || null,
        body: result.body || "",
      },
    }).catch((error) => {
      console.error("[direct-call] Failed to persist device push event", error);
    });
  }
  return results;
}

async function notifyIncomingDirectCall(pool, session) {
  if (!session) return;
  const caller = await fetchDirectCallUserProfile(pool, session.callerId);
  const payload = {
    event: "incoming",
    id: session.callId,
    callId: session.callId,
    threadId: session.threadId,
    fromUserId: session.callerId,
    nameCaller: caller?.displayName || "Talkflix",
    handle: "Talkflix",
    isVideo: session.wantsVideo ? "1" : "0",
    avatar: caller?.photoUrl || "",
  };
  await sendDirectCallDevicePushes(pool, {
    session,
    targetUserId: session.calleeId,
    actorUserId: session.callerId,
    eventType: "push.incoming",
    payload,
  });
}

async function notifyDirectCallLifecyclePush(pool, session, eventName, actorUserId) {
  if (!session || !eventName) return;
  const actor = String(actorUserId || "");
  const targetUserId =
    actor && String(session.callerId) === actor ? session.calleeId : session.callerId;
  if (!targetUserId) return;
  await sendDirectCallDevicePushes(pool, {
    session,
    targetUserId,
    actorUserId,
    eventType: `push.${eventName}`,
    payload: {
      event: eventName,
      id: session.callId,
      callId: session.callId,
      threadId: session.threadId,
      fromUserId: actor,
    },
  });
}

function normalizeDirectCallSessionRow(row) {
  if (!row) return null;
  return {
    callId: String(row.call_id || ""),
    threadId: String(row.thread_id || ""),
    callerId: String(row.caller_id || ""),
    calleeId: String(row.callee_id || ""),
    wantsVideo: Number(row.wants_video || 0) === 1,
    state: String(row.state || ""),
    sessionVersion: Number(row.session_version || 1),
    initiatedAt: row.initiated_at ? new Date(row.initiated_at).getTime() : null,
    answeredAt: row.answered_at ? new Date(row.answered_at).getTime() : null,
    startedAt: row.started_at ? new Date(row.started_at).getTime() : null,
    endedAt: row.ended_at ? new Date(row.ended_at).getTime() : null,
    endedByUserId:
      row.ended_by_user_id == null ? null : String(row.ended_by_user_id),
    lastOfferAt: row.last_offer_at ? new Date(row.last_offer_at).getTime() : null,
    lastAnswerAt: row.last_answer_at
      ? new Date(row.last_answer_at).getTime()
      : null,
    lastIceAt: row.last_ice_at ? new Date(row.last_ice_at).getTime() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
  };
}

async function fetchDirectCallSessionByCallId(pool, callId) {
  if (!callId) return null;
  const [rows] = await pool.query(
    `SELECT call_id, thread_id, caller_id, callee_id, wants_video, state,
            session_version, initiated_at, answered_at, started_at, ended_at,
            ended_by_user_id, last_offer_at, last_answer_at, last_ice_at, updated_at
       FROM direct_call_sessions
      WHERE call_id = ?
      LIMIT 1`,
    [String(callId)]
  );
  return normalizeDirectCallSessionRow(rows?.[0]);
}

async function fetchLatestDirectCallSessionForThread(pool, threadId) {
  if (!threadId) return null;
  const [rows] = await pool.query(
    `SELECT call_id, thread_id, caller_id, callee_id, wants_video, state,
            session_version, initiated_at, answered_at, started_at, ended_at,
            ended_by_user_id, last_offer_at, last_answer_at, last_ice_at, updated_at
       FROM direct_call_sessions
      WHERE thread_id = ?
      ORDER BY id DESC
      LIMIT 1`,
    [String(threadId)]
  );
  return normalizeDirectCallSessionRow(rows?.[0]);
}

async function resolveDirectCallSession(pool, { callId, threadId }) {
  if (callId) {
    const byId = await fetchDirectCallSessionByCallId(pool, callId);
    if (byId) return byId;
  }
  if (threadId) {
    return fetchLatestDirectCallSessionForThread(pool, threadId);
  }
  return null;
}

async function createDirectCallSession(pool, { threadId, callerId, calleeId, wantsVideo }) {
  const callId = createDirectCallId();
  await pool.query(
    `INSERT INTO direct_call_sessions
       (call_id, thread_id, caller_id, callee_id, wants_video, state, metadata_json)
     VALUES (?, ?, ?, ?, ?, 'ringing', NULL)`,
    [callId, String(threadId), Number(callerId), Number(calleeId), wantsVideo ? 1 : 0]
  );
  return fetchDirectCallSessionByCallId(pool, callId);
}

async function updateDirectCallSession(pool, callId, patch = {}) {
  if (!callId) return null;
  const assignments = [];
  const values = [];

  if (patch.state) {
    assignments.push("state = ?");
    values.push(String(patch.state));
  }
  if (patch.answeredAtNow) assignments.push("answered_at = COALESCE(answered_at, CURRENT_TIMESTAMP)");
  if (patch.startedAtNow) assignments.push("started_at = COALESCE(started_at, CURRENT_TIMESTAMP)");
  if (patch.endedAtNow) assignments.push("ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP)");
  if (patch.lastOfferAtNow) assignments.push("last_offer_at = CURRENT_TIMESTAMP");
  if (patch.lastAnswerAtNow) assignments.push("last_answer_at = CURRENT_TIMESTAMP");
  if (patch.lastIceAtNow) assignments.push("last_ice_at = CURRENT_TIMESTAMP");
  if (patch.endedByUserId !== undefined) {
    assignments.push("ended_by_user_id = ?");
    values.push(patch.endedByUserId == null ? null : Number(patch.endedByUserId));
  }
  assignments.push("session_version = session_version + 1");
  if (assignments.length === 0) return fetchDirectCallSessionByCallId(pool, callId);

  let sql = `UPDATE direct_call_sessions SET ${assignments.join(", ")} WHERE call_id = ?`;
  values.push(String(callId));
  if (Array.isArray(patch.allowedStates) && patch.allowedStates.length > 0) {
    sql += ` AND state IN (${patch.allowedStates.map(() => "?").join(", ")})`;
    values.push(...patch.allowedStates.map((value) => String(value)));
  }
  await pool.query(sql, values);
  return fetchDirectCallSessionByCallId(pool, callId);
}

function buildDirectCallEventPayload(session, extra = {}) {
  if (!session) return { ...extra };
  return {
    callId: session.callId,
    threadId: session.threadId,
    video: session.wantsVideo,
    wantsVideo: session.wantsVideo,
    state: session.state,
    sessionVersion: session.sessionVersion,
    requestedAt: session.initiatedAt,
    acceptedAt: session.answeredAt,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    ...extra,
  };
}

function leaveMatch(io, socket, matchId, reason = "ended") {
  if (!matchId) return;

  const info = activeMatches.get(matchId);
  logAnonMatch("match_end", {
    matchId,
    reason,
    actorUserId: socket.user?.userId || "",
    actorSocketId: socket.id || "",
    aUserId: info?.aUserId || "",
    bUserId: info?.bUserId || "",
    aSocketId: info?.aSocketId || "",
    bSocketId: info?.bSocketId || "",
  });

  // Notify room
  io.to(matchId).emit("match:ended", { matchId, reason });
  clearPendingCall(io, matchId);

  if (info) {
    const sa = io.sockets.sockets.get(info.aSocketId);
    const sb = io.sockets.sockets.get(info.bSocketId);

    sa?.leave(matchId);
    sb?.leave(matchId);
    if (sa) sa.data.matchId = null;
    if (sb) sb.data.matchId = null;

    clearTimeout(info.timer);
    activeMatches.delete(matchId);
    return;
  }

  socket.leave(matchId);
  socket.data.matchId = null;
}

function serializeBroadcast(room) {
  ensureLiveRoomVersionState(room);
  const stageCount = (room.speakers || []).filter(Boolean).length;
  const syntheticAudienceCount =
    room.synthetic === true && Number.isFinite(Number(room.syntheticAudienceCount))
      ? Math.max(0, Math.trunc(Number(room.syntheticAudienceCount)))
      : null;
  const speakers = (room.speakers || []).map((speaker) =>
    speaker ? { ...speaker, muted: speaker.muted === true } : null
  );
  const moderators = (room.moderators || []).map((moderator) => ({
    userId: String(moderator.userId || ""),
    name: String(moderator.name || ""),
    photo: moderator.photo || "",
  }));
  return {
    id: room.id,
    type: room.type,
    isPrivate: room.isPrivate === true,
    lang: room.lang,
    lang2: room.lang2 || "",
    description: room.description || "",
    title: room.title,
    hostUserId: room.hostUserId,
    host: room.host,
    hostPhoto: room.hostPhoto || "",
    hostNationalityCode: room.hostNationalityCode || "",
    attendees: syntheticAudienceCount == null
      ? stageCount + (room.audienceMembers?.length || 0)
      : syntheticAudienceCount,
    audienceCount: syntheticAudienceCount == null
      ? room.audienceMembers?.length || 0
      : Math.max(0, syntheticAudienceCount - stageCount),
    audienceMembers: room.audienceMembers || [],
    speakers,
    moderators,
    joinRequests: room.joinRequests || [],
    comments: room.comments || [],
    activeNotice: room.activeNotice || null,
    activePoll: serializeLivePoll(room.activePoll),
    backgroundTheme: room.backgroundTheme || DEFAULT_LIVE_BACKGROUND_THEME,
    commentTheme: room.commentTheme || DEFAULT_LIVE_COMMENT_THEME,
    micEffect: room.micEffect || DEFAULT_LIVE_MIC_EFFECT,
    createdAt: room.createdAt,
    roomVersion: room.roomVersion,
    speakerVersion: room.speakerVersion,
    synthetic: room.synthetic === true,
    joinBlocked: room.joinBlocked === true,
    capacityMessage: room.capacityMessage || "",
  };
}

function emitLiveBroadcastList(io) {
  const list = Array.from(liveBroadcasts.values())
    .map(serializeBroadcast)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  io.emit("live:broadcasts", { broadcasts: list });
}

function emitLiveRoom(io, roomId) {
  const room = liveBroadcasts.get(roomId);
  if (!room) return;
  ensureLiveRoomVersionState(room);
  // Broadcast room changes globally so non-joined users' active list stays live.
  io.emit("live:broadcast:update", { broadcast: serializeBroadcast(room) });
}

function emitLiveSpeaking(io, room, userId, speaking) {
  if (!room) return;
  ensureLiveRoomVersionState(room);
  io.to(`live:${room.id}`).emit("live:speaking", {
    broadcastId: room.id,
    userId,
    speaking: Boolean(speaking),
    speakerVersion: room.speakerVersion,
    speakingSeq: nextLiveSpeakingSeq(room),
  });
}

export function listSyntheticLiveBroadcasts() {
  return Array.from(liveBroadcasts.values())
    .filter((room) => room.synthetic === true)
    .map(serializeBroadcast)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

export function createSyntheticLiveBroadcast(io, payload = {}) {
  const cleanTitle = String(payload.title || "Featured audio room").trim().slice(0, 55);
  if (!cleanTitle) {
    const error = new Error("Title is required.");
    error.statusCode = 400;
    throw error;
  }
  const cleanDescription = String(payload.description || "").trim().slice(0, 160);
  const hostName = String(payload.host || "Talkflix Host").trim().slice(0, 80) || "Talkflix Host";
  const hostPhotoUrl = String(payload.hostPhotoUrl || payload.hostPhoto || "").trim().slice(0, 500);
  const lang = String(payload.lang || "English").trim().slice(0, 40) || "English";
  const lang2 = String(payload.lang2 || "").trim().slice(0, 40);
  const requestedAudienceCount = Number(payload.audienceCount || 500000);
  const syntheticAudienceCount = Math.min(
    1000000,
    Math.max(1, Number.isFinite(requestedAudienceCount) ? Math.trunc(requestedAudienceCount) : 500000)
  );
  const roomId = `synthetic_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  const hostUserId = `synthetic-host-${roomId}`;
  const now = Date.now();
  const room = {
    id: roomId,
    type: "audio",
    isPrivate: false,
    lang,
    lang2,
    description: cleanDescription,
    title: cleanTitle,
    hostUserId,
    host: hostName,
    hostPhoto: hostPhotoUrl,
    hostNationalityCode: String(payload.hostNationalityCode || "").trim().slice(0, 8),
    createdAt: now,
    audienceMembers: [],
    moderators: [],
    comments: [
      {
        id: `sys-${now}`,
        author: "System",
        text: "Broadcast started.",
        ts: now,
      },
    ],
    activeNotice: null,
    activePoll: null,
    backgroundTheme: normalizeLiveBackgroundTheme(payload.backgroundTheme),
    commentTheme: normalizeLiveCommentTheme(payload.commentTheme),
    micEffect: normalizeLiveMicEffect(payload.micEffect),
    speakers: [
      {
        id: `host-${hostUserId}`,
        userId: hostUserId,
        name: hostName,
        photo: hostPhotoUrl,
        role: "Host",
        muted: false,
      },
      ...Array.from({ length: LIVE_STAGE_SLOT_COUNT - 1 }, () => null),
    ],
    joinRequests: [],
    pendingStageApprovals: [],
    roomVersion: 1,
    speakerVersion: 1,
    speakingSeq: 0,
    synthetic: true,
    joinBlocked: true,
    capacityMessage: "Room full. Try the next broadcast.",
    syntheticAudienceCount,
  };
  liveBroadcasts.set(roomId, room);
  emitLiveBroadcastList(io);
  emitLiveRoom(io, roomId);
  return serializeBroadcast(room);
}

export function endSyntheticLiveBroadcast(io, broadcastId) {
  const roomId = String(broadcastId || "").trim();
  const room = liveBroadcasts.get(roomId);
  if (!room || room.synthetic !== true) return null;
  clearLiveRoomState(room);
  liveBroadcasts.delete(roomId);
  io.to(`live:${roomId}`).emit("live:broadcast:ended", {
    broadcastId: roomId,
    reason: "synthetic_ended",
  });
  emitLiveBroadcastList(io);
  return serializeBroadcast(room);
}

function addPresenceWatcher(userId, socketId) {
  const key = String(userId);
  if (!presenceWatchers.has(key)) presenceWatchers.set(key, new Set());
  presenceWatchers.get(key).add(socketId);
}

function removePresenceWatcher(socketId) {
  for (const [userId, watchers] of presenceWatchers.entries()) {
    watchers.delete(socketId);
    if (watchers.size === 0) presenceWatchers.delete(userId);
  }
}

function emitPresence(io, userId, online) {
  const watchers = presenceWatchers.get(String(userId));
  if (!watchers?.size) return;
  for (const watcherSocketId of watchers) {
    io.to(watcherSocketId).emit("presence:update", {
      userId: String(userId),
      online: Boolean(online),
    });
  }
}

export function attachSocket(server, pool, opts = {}) {
  const allowedOrigins = Array.isArray(opts.allowedOrigins) ? opts.allowedOrigins : [];
  const createUserNotification = typeof opts.createUserNotification === "function"
    ? opts.createUserNotification
    : null;
  const io = new Server(server, {
    maxHttpBufferSize: 10 * 1024 * 1024,
    cors: {
      origin(origin, cb) {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: true,
    },
  });

  io.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        (socket.handshake.headers.authorization?.startsWith("Bearer ")
          ? socket.handshake.headers.authorization.slice(7)
          : null);

      const guestMode = String(socket.handshake.auth?.guest || "").trim();
      const guestBroadcastId = String(socket.handshake.auth?.broadcastId || "").trim();
      if (!token && guestMode === "live_preview" && guestBroadcastId) {
        socket.user = {
          userId: `guest_${crypto.randomBytes(8).toString("hex")}`,
          role: "guest",
          plan: "free",
          sessionId: "guest-preview",
          isGuestLivePreview: true,
          guestBroadcastId,
        };
        return next();
      }

      if (!token) return next(new Error("unauthorized"));

      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = {
        userId: payload.sub,
        role: payload.role || "user",
        plan: payload.plan || "free",
        sessionId: payload.sid || "",
      };

      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    socket.data.matchId = null;
    socket.data.directCallId = null;
    socket.data.liveGuestPreviewTimer = null;
    socket.join(`user:${socket.user.userId}`);
    liveUserSockets.set(String(socket.user.userId), socket.id);
    emitPresence(io, socket.user.userId, true);
    socket.emit("auth:ready", {
      userId: String(socket.user.userId || ""),
      sessionId: String(socket.user.sessionId || ""),
      guest: socket.user.isGuestLivePreview === true,
    });

    socket.use((packet, next) => {
      if (!socket.user?.isGuestLivePreview) return next();
      const eventName = String(packet?.[0] || "");
      if (GUEST_LIVE_EVENTS.has(eventName)) return next();
      return next(new Error("guest_preview_forbidden"));
    });

    socket.on("presence:watch", ({ userId }, ack) => {
      if (!userId) return ack?.({ ok: false });
      addPresenceWatcher(userId, socket.id);
      ack?.({
        ok: true,
        userId: String(userId),
        online: liveUserSockets.has(String(userId)),
      });
    });

    socket.on("presence:unwatch", ({ userId }, ack) => {
      const watchers = presenceWatchers.get(String(userId));
      watchers?.delete(socket.id);
      if (watchers && watchers.size === 0) presenceWatchers.delete(String(userId));
      ack?.({ ok: true });
    });

    socket.on("chat:typing", ({ matchId, typing }, ack) => {
      if (!matchId) return ack?.({ ok: false });
      if (rejectIfNotInMatch(socket, matchId, ack, "chat:typing")) return;
    
      socket.to(matchId).emit("chat:typing", {
        matchId,
        from: socket.user.userId,
        typing: Boolean(typing),
      });
    
      ack?.({ ok: true });
    });

    socket.on("call:camera-state", ({ matchId, enabled }, ack) => {
      if (!matchId) return ack?.({ ok: false });
      if (rejectIfNotInMatch(socket, matchId, ack, "call:camera-state")) return;
    
      io.to(matchId).emit("call:camera-state", {
        matchId,
        from: socket.user.userId,
        enabled: Boolean(enabled),
      });
    
      ack?.({ ok: true });
    });

    socket.on("match:join", async (criteria, ack) => {
      try {
        await refreshAnonymousMatchCooldownSetting(pool);
        cleanupRecentPairs();
        cleanupSkips();

        if (!isProLike(socket.user)) return ack?.({ ok: false, message: "Pro required" });

        const language = String(criteria?.language || "").trim();
        if (!language) return ack?.({ ok: false, message: "language required" });

        const gender = criteria?.gender === "male" || criteria?.gender === "female" ? criteria.gender : "any";
        const ageMin = Math.max(Number(criteria?.ageMin || 18), 18);
        const ageMax = Math.min(Number(criteria?.ageMax || 90), 90);

        if (
          (socket.data.matchId && activeMatches.has(socket.data.matchId)) ||
          isUserInActiveMatch(socket.user.userId)
        ) {
          logAnonMatch("join_rejected_active_match", {
            userId: socket.user.userId,
            socketId: socket.id,
            socketMatchId: socket.data.matchId || "",
          });
          return ack?.({ ok: false, message: "already in a match" });
        }

        // If already queued, ignore
        if (queue.some((q) => q.socketId === socket.id)) return ack?.({ ok: true, queued: true });
        removeUserFromQueue(socket.user.userId, socket.id);

        // Pull user attributes from DB so we can enforce criteria properly
        const [rows] = await pool.query(
          `SELECT gender, dob
           FROM users
           WHERE id = ? LIMIT 1`,
          [socket.user.userId]
        );

        const genderSelf = rows?.[0]?.gender ? String(rows[0].gender).toLowerCase() : null;
        const ageSelf = yearsOld(rows?.[0]?.dob);

        queue.push({
          socketId: socket.id,
          userId: socket.user.userId,
          gender: genderSelf === "male" || genderSelf === "female" ? genderSelf : null,
          age: typeof ageSelf === "number" ? ageSelf : null,
          criteria: { language, gender, ageMin, ageMax },
          joinedAt: Date.now(),
        });
        logAnonMatch("queue_join", {
          userId: socket.user.userId,
          socketId: socket.id,
          language,
          gender,
          ageMin,
          ageMax,
          queueSize: queue.length,
        });

        await attemptMatch(io, pool);
        ack?.({ ok: true, queued: true });
      } catch (e) {
        ack?.({ ok: false, message: "failed to join queue" });
      }
    });


    socket.on("match:cancel-search", (ack) => {
      removeFromQueue(socket.id);
      logAnonMatch("search_cancel", {
        userId: socket.user.userId,
        socketId: socket.id,
        socketMatchId: socket.data.matchId || "",
        ignoredActiveMatch: Boolean(socket.data.matchId),
        queueSize: queue.length,
      });
      ack?.({ ok: true, ignoredActiveMatch: Boolean(socket.data.matchId) });
    });

    socket.on("match:leave", (payload, ack) => {
      if (typeof payload === "function") {
        ack = payload;
        payload = {};
      }
      removeFromQueue(socket.id);
      logAnonMatch("leave_requested", {
        userId: socket.user.userId,
        socketId: socket.id,
        socketMatchId: socket.data.matchId || "",
        source: String(payload?.source || ""),
        phase: String(payload?.phase || ""),
      });
      if (socket.data.matchId) {
        leaveMatch(io, socket, socket.data.matchId, "left");
        socket.data.matchId = null;
      }
      ack?.({ ok: true });
    });

    socket.on("match:skip", (ack) => {
      const matchId = socket.data.matchId;
      if (matchId) {
        const info = activeMatches.get(matchId);
        if (info) {
          rememberSkip(info.aUserId, info.bUserId);
        }
        leaveMatch(io, socket, matchId, "skipped");
        socket.data.matchId = null;
      }
      ack?.({ ok: true });
    });

    // Anonymous chat messages
    socket.on("chat:message", (payload, ack) => {
      const { matchId, text, type, imageUrl, audioUrl, audioDuration, mimeType, clientMessageId } = payload || {};
      if (!matchId) return ack?.({ ok: false });
      if (rejectIfNotInMatch(socket, matchId, ack, "chat:message")) return;
      const safeType = ["text", "image", "audio"].includes(type) ? type : (audioUrl ? "audio" : imageUrl ? "image" : "text");
      if (safeType === "text" && !String(text || "").trim()) return ack?.({ ok: false });
      io.to(matchId).emit("chat:message", {
        matchId,
        from: socket.user.userId,
        type: safeType,
        text: text ? String(text).slice(0, 2000) : "",
        imageUrl: imageUrl || null,
        audioUrl: audioUrl || null,
        audioDuration: Number(audioDuration || 0),
        mimeType: mimeType || null,
        clientMessageId: clientMessageId || null,
        ts: Date.now(),
      });
      ack?.({ ok: true });
    });

    // Follow consent
    socket.on("follow:allow", ({ matchId, allow }, ack) => {
      if (!matchId) return ack?.({ ok: false });
      if (rejectIfNotInMatch(socket, matchId, ack, "follow:allow")) return;
      io.to(matchId).emit("follow:allow", {
        matchId,
        from: socket.user.userId,
        allow: Boolean(allow),
      });
      ack?.({ ok: true });
    });

    // Call request/accept
    socket.on("call:request", ({ matchId }, ack) => {
      if (!matchId) return ack?.({ ok: false });
      if (rejectIfNotInMatch(socket, matchId, ack, "call:request")) return;
      logAnonCallDebug("call:request", {
        matchId,
        from: socket.user.userId,
      });
      clearPendingCall(io, matchId);
      const requestedAt = Date.now();
      const timer = setTimeout(() => {
        io.to(matchId).emit("call:missed", { matchId, from: socket.user.userId, requestedAt, endedAt: Date.now() });
        pendingCalls.delete(matchId);
      }, 30000);
      pendingCalls.set(matchId, { timer, fromUserId: socket.user.userId, requestedAt });
      io.to(matchId).emit("call:request", { matchId, from: socket.user.userId, requestedAt });
      ack?.({ ok: true });
    });

    socket.on("call:accept", ({ matchId, accept }, ack) => {
      if (!matchId) return ack?.({ ok: false });
      if (rejectIfNotInMatch(socket, matchId, ack, "call:accept")) return;
      logAnonCallDebug("call:accept", {
        matchId,
        from: socket.user.userId,
        accept: Boolean(accept),
      });
      const pending = pendingCalls.get(matchId);
      const acceptedAt = Date.now();
      clearPendingCall(io, matchId);
      io.to(matchId).emit("call:accept", {
        matchId,
        from: socket.user.userId,
        accept: Boolean(accept),
        acceptedAt: accept ? acceptedAt : null,
        requestedAt: pending?.requestedAt || null,
      });
      ack?.({ ok: true });
    });

    socket.on("call:cancel", ({ matchId }, ack) => {
      if (!matchId) return ack?.({ ok: false });
      if (rejectIfNotInMatch(socket, matchId, ack, "call:cancel")) return;
      logAnonCallDebug("call:cancel", {
        matchId,
        from: socket.user.userId,
      });
      const pending = pendingCalls.get(matchId);
      clearPendingCall(io, matchId);
      io.to(matchId).emit("call:cancel", { matchId, from: socket.user.userId, requestedAt: pending?.requestedAt || null, endedAt: Date.now() });
      ack?.({ ok: true });
    });

    // WebRTC signaling
    socket.on("rtc:offer", ({ matchId, sdp }, ack) => {
      if (rejectIfNotInMatch(socket, matchId, ack, "rtc:offer")) return;
      logAnonCallDebug("rtc:offer", {
        matchId,
        from: socket.user.userId,
        type: sdp?.type,
      });
      io.to(matchId).emit("rtc:offer", { from: socket.user.userId, sdp });
      ack?.({ ok: true });
    });

    socket.on("rtc:answer", ({ matchId, sdp }, ack) => {
      if (rejectIfNotInMatch(socket, matchId, ack, "rtc:answer")) return;
      logAnonCallDebug("rtc:answer", {
        matchId,
        from: socket.user.userId,
        type: sdp?.type,
      });
      io.to(matchId).emit("rtc:answer", { from: socket.user.userId, sdp });
      ack?.({ ok: true });
    });

    socket.on("rtc:ice", ({ matchId, candidate }, ack) => {
      if (rejectIfNotInMatch(socket, matchId, ack, "rtc:ice")) return;
      logAnonCallDebug("rtc:ice", {
        matchId,
        from: socket.user.userId,
        sdpMid: candidate?.sdpMid,
        sdpMLineIndex: candidate?.sdpMLineIndex,
      });
      io.to(matchId).emit("rtc:ice", { from: socket.user.userId, candidate });
      ack?.({ ok: true });
    });

    socket.on("call:end", ({ matchId }, ack) => {
      if (!matchId) return ack?.({ ok: false });
      if (rejectIfNotInMatch(socket, matchId, ack, "call:end")) return;
      clearPendingCall(io, matchId);
      io.to(matchId).emit("call:end", {
        matchId,
        from: socket.user.userId,
        endedAt: Date.now(),
      });
      ack?.({ ok: true });
    });
    



    socket.on("dm:join", ({ threadId }, ack) => {
      if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
        return ack?.({ ok: false });
      }
      socket.join(`dm:${threadId}`);
      ack?.({ ok: true });
    });

    socket.on("dm:leave", ({ threadId }, ack) => {
      if (threadId && isDirectThreadMember(threadId, socket.user.userId)) {
        socket.leave(`dm:${threadId}`);
      }
      ack?.({ ok: true });
    });

    socket.on("dm:typing", ({ threadId, typing }, ack) => {
      if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
        return ack?.({ ok: false });
      }
      socket.to(`dm:${threadId}`).emit("dm:typing", { threadId, fromUserId: socket.user.userId, typing: Boolean(typing) });
      ack?.({ ok: true });
    });

    socket.on("dm:message", async (message, ack) => {
      try {
        if (!message?.threadId || !isDirectThreadMember(message.threadId, socket.user.userId)) {
          return ack?.({ ok: false });
        }
        ack?.({
          ok: false,
          message: "Direct messages must be sent through the REST message endpoint.",
        });
      } catch (error) {
        console.error(error);
        ack?.({ ok: false });
      }
    });

    socket.on("dm:call:request", async ({ threadId, video }, ack) => {
      try {
        if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
          return ack?.({ ok: false });
        }
        if (!directCallRelayAvailable()) {
          return ack?.({
            ok: false,
            code: "CALL_TRANSPORT_UNAVAILABLE",
            message: "Direct calling is unavailable until relay transport is configured.",
          });
        }
        const otherUserId = getOtherDirectThreadUserId(threadId, socket.user.userId);
        if (!otherUserId) return ack?.({ ok: false });
        const blockState = await getDirectBlockState(pool, socket.user.userId, otherUserId);
        if (blockState.blocked) {
          return ack?.({
            ok: false,
            message: buildBlockedActionMessage({
              action: "calling",
              youBlockedUser: blockState.youBlockedUser,
              blockedByUser: blockState.blockedByUser,
            }),
          });
        }
        const permissionState = await getDirectCallPermissionState(
          pool,
          otherUserId,
          socket.user.userId
        );
        const canReceiveCall = Boolean(video)
          ? permissionState?.receiveVideoCalls
          : permissionState?.receiveVoiceCalls;
        if (!canReceiveCall) {
          return ack?.({
            ok: false,
            code: "CALL_PERMISSION_REQUIRED",
            message: buildDirectCallPermissionMessage({ video: Boolean(video) }),
          });
        }
        const existingSession = await fetchLatestDirectCallSessionForThread(pool, threadId);
        if (existingSession && !DIRECT_CALL_TERMINAL_STATES.has(existingSession.state)) {
          return ack?.({
            ok: false,
            message: "A call is already in progress for this chat.",
            callId: existingSession.callId,
            session: existingSession,
          });
        }
        const reachability = await resolveDirectCallReachability(io, pool, otherUserId);
        if (!reachability.hasLiveSocket && reachability.callableDevices.length === 0) {
          return ack?.({
            ok: false,
            message: "This user is not available for stable direct calls right now.",
          });
        }
        const session = await createDirectCallSession(pool, {
          threadId,
          callerId: socket.user.userId,
          calleeId: otherUserId,
          wantsVideo: Boolean(video),
        });
        if (!session) {
          return ack?.({ ok: false, message: "Could not create call session." });
        }
        socket.data.directCallThreadId = threadId;
        socket.data.directCallId = session.callId;
        clearPendingDirectCall(io, threadId);
        const timer = setTimeout(async () => {
          const timedOut = await updateDirectCallSession(pool, session.callId, {
            state: "missed",
            endedAtNow: true,
            allowedStates: ["ringing"],
          });
          if (!timedOut || timedOut.state !== "missed") return;
          void recordDirectCallEvent(pool, {
            callId: timedOut.callId,
            threadId: timedOut.threadId,
            eventType: "call.missed",
            userId: timedOut.calleeId,
            actorUserId: timedOut.callerId,
            payload: buildDirectCallEventPayload(timedOut),
          }).catch((error) => {
            console.error("[direct-call] Failed to persist missed event", error);
          });
          io.to(`dm:${threadId}`).emit(
            "dm:call:missed",
            buildDirectCallEventPayload(timedOut, {
              fromUserId: socket.user.userId,
            })
          );
          pendingDirectCalls.delete(threadId);
        }, 30000);
        pendingDirectCalls.set(threadId, {
          timer,
          callId: session.callId,
          fromUserId: socket.user.userId,
          requestedAt: session.initiatedAt,
          wantsVideo: session.wantsVideo,
        });
        const eventPayload = buildDirectCallEventPayload(session, {
          fromUserId: socket.user.userId,
        });
        io.to(`dm:${threadId}`).emit("dm:call:request", eventPayload);
        io.to(`user:${otherUserId}`).emit("dm:call:request:global", eventPayload);
        void recordDirectCallEvent(pool, {
          callId: session.callId,
          threadId: session.threadId,
          eventType: "call.requested",
          userId: otherUserId,
          actorUserId: socket.user.userId,
          payload: eventPayload,
        }).catch((error) => {
          console.error("[direct-call] Failed to persist request event", error);
        });
        if (!reachability.hasLiveSocket) {
          void notifyIncomingDirectCall(pool, session).catch((error) => {
            console.error("[direct-call] Failed to send incoming push", error);
          });
        }
        ack?.({ ok: true, callId: session.callId, session: session });
      } catch (error) {
        console.error(error);
        ack?.({ ok: false, message: "Could not start call." });
      }
    });

    socket.on("dm:call:accept", async ({ threadId, callId, accept }, ack) => {
      if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
        return ack?.({ ok: false });
      }
      const pending = pendingDirectCalls.get(threadId);
      const session = await resolveDirectCallSession(pool, {
        callId: callId || pending?.callId,
        threadId,
      });
      if (!session) {
        return ack?.({ ok: false, message: "Call session was not found." });
      }
      if (accept) {
        socket.data.directCallThreadId = threadId;
        socket.data.directCallId = session.callId;
      }
      const updated = await updateDirectCallSession(pool, session.callId, accept
        ? {
            state: "accepted",
            answeredAtNow: true,
            allowedStates: ["ringing"],
          }
        : {
            state: "declined",
            endedAtNow: true,
            endedByUserId: socket.user.userId,
            allowedStates: ["ringing"],
          });
      if (accept && updated?.state !== "accepted") {
        return ack?.({
          ok: false,
          code: "CALL_SESSION_NOT_RINGING",
          message: "This call is no longer available.",
          callId: session.callId,
          session: updated || session,
        });
      }
      if (!accept && updated?.state !== "declined") {
        return ack?.({
          ok: false,
          code: "CALL_SESSION_NOT_RINGING",
          message: "This call is no longer ringing.",
          callId: session.callId,
          session: updated || session,
        });
      }
      clearPendingDirectCall(io, threadId);
      const eventPayload = buildDirectCallEventPayload(updated || session, {
        fromUserId: socket.user.userId,
        accept: Boolean(accept),
      });
      io.to(`dm:${threadId}`).emit("dm:call:accept", eventPayload);
      void recordDirectCallEvent(pool, {
        callId: session.callId,
        threadId: session.threadId,
        eventType: accept ? "call.accepted" : "call.declined",
        userId: socket.user.userId,
        actorUserId: socket.user.userId,
        payload: eventPayload,
      }).catch((error) => {
        console.error("[direct-call] Failed to persist accept event", error);
      });
      ack?.({
        ok: true,
        callId: session.callId,
        acceptedAt: accept ? (updated?.answeredAt ?? session.answeredAt) : undefined,
        requestedAt: updated?.initiatedAt ?? session.initiatedAt,
        video: Boolean(updated?.wantsVideo ?? session.wantsVideo),
        session: updated || session,
      });
    });

    socket.on("dm:call:ready", async ({ threadId, callId }, ack) => {
      if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
        return ack?.({ ok: false });
      }
      const session = await resolveDirectCallSession(pool, { callId, threadId });
      if (!session || DIRECT_CALL_TERMINAL_STATES.has(session.state)) {
        return ack?.({ ok: false, message: "Call session is not active." });
      }
      const eventPayload = buildDirectCallEventPayload(session, {
        threadId,
        fromUserId: socket.user.userId,
        readyAt: Date.now(),
      });
      socket.to(`dm:${threadId}`).emit("dm:call:ready", eventPayload);
      void recordDirectCallEvent(pool, {
        callId: session.callId,
        threadId: session.threadId,
        eventType: "call.ready",
        userId: socket.user.userId,
        actorUserId: socket.user.userId,
        payload: eventPayload,
      }).catch((error) => {
        console.error("[direct-call] Failed to persist ready event", error);
      });
      ack?.({ ok: true, callId: session.callId, session });
    });

    socket.on("dm:call:cancel", async ({ threadId, callId }, ack) => {
      if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
        return ack?.({ ok: false });
      }
      const pending = pendingDirectCalls.get(threadId);
      const session = await resolveDirectCallSession(pool, {
        callId: callId || pending?.callId,
        threadId,
      });
      if (session && session.state !== "ringing") {
        return ack?.({
          ok: false,
          code: "CALL_SESSION_NOT_RINGING",
          message: "This call is no longer ringing.",
          callId: session.callId,
          session,
        });
      }
      if (socket.data.directCallThreadId === threadId) socket.data.directCallThreadId = null;
      if (callId && socket.data.directCallId === callId) socket.data.directCallId = null;
      clearPendingDirectCall(io, threadId);
      const updated = session
        ? await updateDirectCallSession(pool, session.callId, {
            state: "cancelled",
            endedAtNow: true,
            endedByUserId: socket.user.userId,
            allowedStates: ["ringing"],
          })
        : null;
      const eventPayload = buildDirectCallEventPayload(updated || session, {
        threadId,
        fromUserId: socket.user.userId,
      });
      io.to(`dm:${threadId}`).emit("dm:call:cancel", eventPayload);
      const otherUserId = getOtherDirectThreadUserId(threadId, socket.user.userId);
      if (otherUserId) io.to(`user:${otherUserId}`).emit("dm:call:cancel", eventPayload);
      if (session) {
        void recordDirectCallEvent(pool, {
          callId: session.callId,
          threadId: session.threadId,
          eventType: "call.cancelled",
          userId: otherUserId || null,
          actorUserId: socket.user.userId,
          payload: eventPayload,
        }).catch((error) => {
          console.error("[direct-call] Failed to persist cancel event", error);
        });
        void notifyDirectCallLifecyclePush(pool, updated || session, "cancel", socket.user.userId).catch((error) => {
          console.error("[direct-call] Failed to send cancel push", error);
        });
      }
      ack?.({ ok: true, callId: session?.callId || callId || "", session: updated || session });
    });

    socket.on("dm:rtc:offer", async ({ threadId, callId, sdp }, ack) => {
      if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
        return ack?.({ ok: false });
      }
      const session = await resolveDirectCallSession(pool, { callId, threadId });
      if (!session || DIRECT_CALL_TERMINAL_STATES.has(session.state)) {
        return ack?.({ ok: false, message: "Call session is not active." });
      }
      const updated = await updateDirectCallSession(pool, session.callId, {
        lastOfferAtNow: true,
      });
      socket.to(`dm:${threadId}`).emit("dm:rtc:offer", {
        ...buildDirectCallEventPayload(updated || session, {
          fromUserId: socket.user.userId,
        }),
        sdp,
      });
      void recordDirectCallEvent(pool, {
        callId: session.callId,
        threadId: session.threadId,
        eventType: "rtc.offer",
        userId: socket.user.userId,
        actorUserId: socket.user.userId,
      }).catch((error) => {
        console.error("[direct-call] Failed to persist offer event", error);
      });
      ack?.({ ok: true, callId: session.callId });
    });

    socket.on("dm:rtc:answer", async ({ threadId, callId, sdp }, ack) => {
      if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
        return ack?.({ ok: false });
      }
      const session = await resolveDirectCallSession(pool, { callId, threadId });
      if (!session || DIRECT_CALL_TERMINAL_STATES.has(session.state)) {
        return ack?.({ ok: false, message: "Call session is not active." });
      }
      const updated = await updateDirectCallSession(pool, session.callId, {
        lastAnswerAtNow: true,
      });
      socket.to(`dm:${threadId}`).emit("dm:rtc:answer", {
        ...buildDirectCallEventPayload(updated || session, {
          fromUserId: socket.user.userId,
        }),
        sdp,
      });
      void recordDirectCallEvent(pool, {
        callId: session.callId,
        threadId: session.threadId,
        eventType: "rtc.answer",
        userId: socket.user.userId,
        actorUserId: socket.user.userId,
      }).catch((error) => {
        console.error("[direct-call] Failed to persist answer event", error);
      });
      ack?.({ ok: true, callId: session.callId });
    });

    socket.on("dm:rtc:ice", async ({ threadId, callId, candidate }, ack) => {
      if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
        return ack?.({ ok: false });
      }
      const session = await resolveDirectCallSession(pool, { callId, threadId });
      if (!session || DIRECT_CALL_TERMINAL_STATES.has(session.state)) {
        return ack?.({ ok: false, message: "Call session is not active." });
      }
      const updated = await updateDirectCallSession(pool, session.callId, {
        lastIceAtNow: true,
      });
      socket.to(`dm:${threadId}`).emit("dm:rtc:ice", {
        ...buildDirectCallEventPayload(updated || session, {
          fromUserId: socket.user.userId,
        }),
        candidate,
      });
      void recordDirectCallEvent(pool, {
        callId: session.callId,
        threadId: session.threadId,
        eventType: "rtc.ice",
        userId: socket.user.userId,
        actorUserId: socket.user.userId,
      }).catch((error) => {
        console.error("[direct-call] Failed to persist ICE event", error);
      });
      ack?.({ ok: true, callId: session.callId });
    });

    socket.on("dm:call:connected", async ({ threadId, callId }, ack) => {
      if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
        return ack?.({ ok: false });
      }
      const session = await resolveDirectCallSession(pool, { callId, threadId });
      if (!session) return ack?.({ ok: false, message: "Call session was not found." });
      const updated = await updateDirectCallSession(pool, session.callId, {
        state: "active",
        startedAtNow: true,
        allowedStates: ["accepted", "active"],
      });
      io.to(`dm:${threadId}`).emit("dm:call:connected", buildDirectCallEventPayload(updated || session, {
        fromUserId: socket.user.userId,
      }));
      void recordDirectCallEvent(pool, {
        callId: session.callId,
        threadId: session.threadId,
        eventType: "call.connected",
        userId: socket.user.userId,
        actorUserId: socket.user.userId,
      }).catch((error) => {
        console.error("[direct-call] Failed to persist connected event", error);
      });
      ack?.({ ok: true, callId: session.callId, session: updated || session });
    });

    socket.on("dm:call:end", async ({ threadId, callId }, ack) => {
      if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
        return ack?.({ ok: false });
      }
      const session = await resolveDirectCallSession(pool, { callId, threadId });
      if (socket.data.directCallThreadId === threadId) socket.data.directCallThreadId = null;
      if (session?.callId && socket.data.directCallId === session.callId) {
        socket.data.directCallId = null;
      }
      clearPendingDirectCall(io, threadId);
      const updated = session
        ? await updateDirectCallSession(pool, session.callId, {
            state: "ended",
            endedAtNow: true,
            endedByUserId: socket.user.userId,
            allowedStates: ["ringing", "accepted", "active"],
          })
        : null;
      io.to(`dm:${threadId}`).emit("dm:call:end", buildDirectCallEventPayload(updated || session, {
        threadId,
        fromUserId: socket.user.userId,
      }));
      if (session) {
        void recordDirectCallEvent(pool, {
          callId: session.callId,
          threadId: session.threadId,
          eventType: "call.ended",
          userId: socket.user.userId,
          actorUserId: socket.user.userId,
        }).catch((error) => {
          console.error("[direct-call] Failed to persist end event", error);
        });
        void notifyDirectCallLifecyclePush(pool, updated || session, "end", socket.user.userId).catch((error) => {
          console.error("[direct-call] Failed to send end push", error);
        });
      }
      ack?.({ ok: true, callId: session?.callId || callId || "", session: updated || session });
    });

    socket.on("dm:call:camera-state", async ({ threadId, callId, enabled }, ack) => {
      if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
        return ack?.({ ok: false });
      }
      const session = await resolveDirectCallSession(pool, { callId, threadId });
      socket.to(`dm:${threadId}`).emit("dm:call:camera-state", buildDirectCallEventPayload(session, {
        threadId,
        fromUserId: socket.user.userId,
        enabled: Boolean(enabled),
      }));
      ack?.({ ok: true, callId: session?.callId || callId || "" });
    });
    socket.on("live:broadcasts:get", (ack) => {
      const broadcasts = Array.from(liveBroadcasts.values())
        .filter((room) =>
          socket.user?.isGuestLivePreview
            ? room.type === "audio" &&
              room.isPrivate !== true &&
              String(room.id || "") === String(socket.user.guestBroadcastId || "")
            : true
        )
        .map(serializeBroadcast)
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
      socket.emit("live:broadcasts", { broadcasts });
      ack?.({ ok: true, broadcasts });
    });

    socket.on("live:broadcast:create", (payload, ack) => {
      const finish = async () => {
      if (!socketIdentityMatches(socket, payload)) {
        return ack?.(liveAckError(
          "auth_identity_mismatch",
          "Realtime session is out of date. Please reconnect and try again."
        ));
      }
      const cleanTitle = String(payload?.title || "").trim().slice(0, 120);
      const cleanDescription = String(payload?.description || "").trim().slice(0, 160);
      if (!cleanTitle) return ack?.({ ok: false, message: "title required" });
      if (cleanTitle.length > 55) return ack?.({ ok: false, message: "title too long" });
      const type = payload?.type === "video" ? "video" : "audio";
      const isPrivate = payload?.isPrivate === true && isProLike(socket.user);
      const lang = String(payload?.lang || "English").trim().slice(0, 40);
      const lang2 = String(payload?.lang2 || "").trim().slice(0, 40);
      const roomId = `live_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
      const room = {
        id: roomId,
        type,
        isPrivate,
        lang,
        lang2,
        description: cleanDescription,
        title: cleanTitle,
        hostUserId: String(socket.user.userId),
        host: String(payload?.host || "Host"),
        hostPhoto: payload?.hostPhoto || "",
        hostNationalityCode: String(payload?.hostNationalityCode || "").trim().slice(0, 8),
        createdAt: Date.now(),
        audienceMembers: [],
        moderators: [],
        comments: [],
        activeNotice: null,
        activePoll: null,
        backgroundTheme: DEFAULT_LIVE_BACKGROUND_THEME,
        commentTheme: DEFAULT_LIVE_COMMENT_THEME,
        micEffect: DEFAULT_LIVE_MIC_EFFECT,
        speakers: [
          {
            id: `host-${socket.user.userId}`,
            userId: String(socket.user.userId),
            name: String(payload?.host || "Host"),
            photo: payload?.hostPhoto || "",
            role: "Host",
            muted: false,
          },
          ...Array.from({ length: LIVE_STAGE_SLOT_COUNT - 1 }, () => null),
        ],
        joinRequests: [],
        pendingStageApprovals: [],
        roomVersion: 1,
        speakerVersion: 1,
        speakingSeq: 0,
      };
      liveBroadcasts.set(roomId, room);
      socket.join(`live:${roomId}`);
      socket.data.liveBroadcastId = roomId;
      socket.data.liveBroadcastRole = "host";
      emitLiveBroadcastList(io);
      emitLiveRoom(io, roomId);
      const mediaSession = await emitLiveMediaSession(
        io,
        room,
        socket.user.userId,
        room.host
      );
      void notifyFollowersOfLiveBroadcast(pool, createUserNotification, room).catch((error) => {
        console.error("[notifications] Failed to notify followers about live broadcast", error);
      });
      ack?.({
        ok: true,
        broadcast: serializeBroadcast(room),
        mediaSession,
      });
      };
      finish().catch((error) => {
        console.error("[livekit] create broadcast failed", error);
        ack?.({ ok: false, message: "Unable to create broadcast" });
      });
    });

    socket.on("live:broadcast:join", (payload, ack) => {
      const finish = async () => {
      if (!socketIdentityMatches(socket, payload)) {
        return ack?.(liveAckError(
          "auth_identity_mismatch",
          "Realtime session is out of date. Please reconnect and try again."
        ));
      }
      const broadcastId = payload?.broadcastId;
      const name = payload?.name;
      const photo = payload?.photo;
      const room = liveBroadcasts.get(broadcastId);
      if (!room) return ack?.({ ok: false, message: "not found" });
      if (room.synthetic === true && room.joinBlocked === true) {
        return ack?.(liveAckError(
          "room_full",
          room.capacityMessage || "Room full. Try the next broadcast."
        ));
      }
      socket.join(`live:${broadcastId}`);
      socket.data.liveBroadcastId = broadcastId;
      const userId = String(socket.user.userId);
      const isSpeaker = (room.speakers || []).some((speaker) => speaker && String(speaker.userId) === userId);
      socket.data.liveBroadcastRole = room.hostUserId === userId ? "host" : isSpeaker ? "speaker" : "audience";
      if (room.hostUserId !== userId && !isSpeaker && !room.audienceMembers.some((m) => String(m.userId) === userId)) {
        room.audienceMembers.unshift({ userId, name: String(name || `User ${userId}`), photo: photo || "" });
        bumpLiveRoomVersion(room);
      }
      emitLiveRoom(io, broadcastId);
      emitLiveBroadcastList(io);
      const mediaSession = await emitLiveMediaSession(
        io,
        room,
        userId,
        name
      );
      ack?.({
        ok: true,
        broadcast: serializeBroadcast(room),
        mediaSession,
      });
      };
      finish().catch((error) => {
        console.error("[livekit] join broadcast failed", error);
        ack?.({ ok: false, message: "Unable to join broadcast" });
      });
    });

    socket.on("live:broadcast:guest-preview:join", (payload, ack) => {
      const finish = async () => {
        if (!socket.user?.isGuestLivePreview) {
          return ack?.({ ok: false, message: "Guest preview is not available." });
        }
        const broadcastId = String(payload?.broadcastId || "").trim();
        if (!broadcastId || broadcastId !== String(socket.user.guestBroadcastId || "")) {
          return ack?.({ ok: false, message: "Invalid room preview link." });
        }
        const room = liveBroadcasts.get(broadcastId);
        if (!room || room.type !== "audio" || room.isPrivate === true) {
          return ack?.({ ok: false, message: "This audio room is unavailable." });
        }
        const userId = String(socket.user.userId);
        const now = Date.now();
        const expiresAt = now + LIVE_GUEST_PREVIEW_MS;
        clearGuestLivePreviewTimer(socket);
        socket.join(`live:${broadcastId}`);
        socket.data.liveBroadcastId = broadcastId;
        socket.data.liveBroadcastRole = "guest_preview";
        socket.data.liveGuestPreviewExpiresAt = expiresAt;
        socket.data.liveGuestPreviewTimer = setTimeout(() => {
          endGuestLivePreview(io, socket, broadcastId);
        }, LIVE_GUEST_PREVIEW_MS);

        const mediaSession = await buildLiveMediaSession({
          room,
          userId,
          participantName: "Guest listener",
          canPublish: false,
          ttl: `${Math.ceil((LIVE_GUEST_PREVIEW_MS + LIVE_GUEST_PREVIEW_GRACE_MS) / 1000)}s`,
        });
        ack?.({
          ok: true,
          broadcast: serializeBroadcast(room),
          mediaSession,
          guestPreview: {
            expiresAt,
            previewSeconds: Math.floor(LIVE_GUEST_PREVIEW_MS / 1000),
            signUpRequired: true,
          },
        });
      };
      finish().catch((error) => {
        console.error("[livekit] guest preview join failed", error);
        ack?.({ ok: false, message: "Unable to open this room preview." });
      });
    });

    socket.on("live:broadcast:leave", ({ broadcastId }, ack) => {
      const room = liveBroadcasts.get(broadcastId);
      socket.leave(`live:${broadcastId}`);
      socket.data.liveBroadcastId = null;
      socket.data.liveBroadcastRole = null;
      if (!room) return ack?.({ ok: true });
      const userId = String(socket.user.userId);
      if (room.hostUserId === userId) {
        io.to(`live:${broadcastId}`).emit("live:broadcast:ended", { broadcastId, reason: "host_left" });
        clearLiveRoomState(room);
        liveBroadcasts.delete(broadcastId);
        emitLiveBroadcastList(io);
        return ack?.({ ok: true, ended: true });
      }
      const leavingAudience = room.audienceMembers.find((m) => String(m.userId) === userId);
      const leavingSpeaker = (room.speakers || []).find((s) => s && String(s.userId) === userId);
      room.audienceMembers = room.audienceMembers.filter((m) => String(m.userId) !== userId);
      room.joinRequests = room.joinRequests.filter((m) => String(m.userId) !== userId);
      room.speakers = (room.speakers || []).map((s) => (s && String(s.userId) === userId ? null : s));
      if (leavingSpeaker) {
        bumpLiveSpeakerVersion(room);
        emitLiveSpeaking(io, room, userId, false);
      } else {
        bumpLiveRoomVersion(room);
      }
      const departedName = leavingSpeaker?.name || leavingAudience?.name || 'A listener';
      room.comments.push({ id: `sys-${Date.now()}`, author: "System", text: `${departedName} left.`, ts: Date.now() });
      emitLiveRoom(io, broadcastId);
      emitLiveBroadcastList(io);
      ack?.({ ok: true, broadcast: serializeBroadcast(room) });
    });

    socket.on("live:comment", ({ broadcastId, text, author, userId, photo, commentTheme }, ack) => {
      const room = liveBroadcasts.get(broadcastId);
      const clean = String(text || "").trim().slice(0, 220);
      if (!room || !clean) return ack?.({ ok: false });
      const resolvedUserId = String(socket.user.userId || "");
      if (!isLiveRoomMember(room, resolvedUserId)) {
        return ack?.(liveAckError("not_in_room", "Join the room before commenting."));
      }
      const participant = findLiveParticipant(room, resolvedUserId);
      const role = resolveLiveParticipantRole(room, resolvedUserId);
      const comment = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2,6)}`,
        author: String(participant?.name || author || "User"),
        userId: resolvedUserId,
        photo: participant?.photo || photo || "",
        text: clean,
        role,
        roleLabel: role === "host" ? "Host" : role === "moderator" ? "Moderator" : "",
        commentTheme: resolveLiveCommentTheme(socket, commentTheme),
        ts: Date.now(),
      };
      room.comments.push(comment);
      bumpLiveRoomVersion(room);
      io.to(`live:${broadcastId}`).emit("live:comment", { broadcastId, comment });
      emitLiveRoom(io, broadcastId);
      ack?.({ ok: true, comment });
    });

    socket.on("live:notice:send", ({ broadcastId, text }, ack) => {
      const room = liveBroadcasts.get(broadcastId);
      const requesterId = String(socket.user.userId || "");
      const clean = String(text || "").trim().slice(0, 360);
      if (!room) {
        return ack?.(liveAckError("room_not_found", "Broadcast not found."));
      }
      if (room.hostUserId !== requesterId) {
        return ack?.(liveAckError("not_host", "Only the host can send room notices."));
      }
      if (!clean) {
        return ack?.(liveAckError("notice_required", "Notice text is required."));
      }
      const notice = {
        id: `notice-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
        text: clean,
        hostUserId: requesterId,
        persistent: false,
        ts: Date.now(),
      };
      io.to(`live:${broadcastId}`).emit("live:notice", { broadcastId, notice });
      ack?.({ ok: true, notice, broadcast: serializeBroadcast(room) });
    });

    socket.on("live:notice:save", ({ broadcastId, text }, ack) => {
      const room = liveBroadcasts.get(broadcastId);
      const requesterId = String(socket.user.userId || "");
      const clean = String(text || "").trim().slice(0, 360);
      if (!room) {
        return ack?.(liveAckError("room_not_found", "Broadcast not found."));
      }
      if (room.hostUserId !== requesterId) {
        return ack?.(liveAckError("not_host", "Only the host can update the join notice."));
      }
      if (!clean) {
        return ack?.(liveAckError("notice_required", "Join notice text is required."));
      }
      const notice = {
        id: `notice-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
        text: clean,
        hostUserId: requesterId,
        persistent: true,
        ts: Date.now(),
      };
      room.activeNotice = notice;
      bumpLiveRoomVersion(room);
      emitLiveRoom(io, broadcastId);
      emitLiveBroadcastList(io);
      ack?.({ ok: true, notice, broadcast: serializeBroadcast(room) });
    });

    socket.on("live:notice:delete", ({ broadcastId }, ack) => {
      const room = liveBroadcasts.get(broadcastId);
      const requesterId = String(socket.user.userId || "");
      if (!room) {
        return ack?.(liveAckError("room_not_found", "Broadcast not found."));
      }
      if (room.hostUserId !== requesterId) {
        return ack?.(liveAckError("not_host", "Only the host can delete the join notice."));
      }
      room.activeNotice = null;
      bumpLiveRoomVersion(room);
      emitLiveRoom(io, broadcastId);
      emitLiveBroadcastList(io);
      ack?.({ ok: true, broadcast: serializeBroadcast(room) });
    });

    socket.on("live:poll:create", ({ broadcastId, question, options }, ack) => {
      const room = liveBroadcasts.get(broadcastId);
      const requesterId = String(socket.user.userId || "");
      const cleanQuestion = String(question || "").trim().slice(0, 180);
      const cleanOptions = (Array.isArray(options) ? options : [])
        .map((option) => String(option || "").trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, LIVE_POLL_OPTION_LIMIT);
      if (!room) {
        return ack?.(liveAckError("room_not_found", "Broadcast not found."));
      }
      if (room.hostUserId !== requesterId) {
        return ack?.(liveAckError("not_host", "Only the host can create polls."));
      }
      if (!cleanQuestion || cleanOptions.length < 2) {
        return ack?.(liveAckError("invalid_poll", "Polls need a question and at least two options."));
      }
      const poll = {
        id: `poll-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
        question: cleanQuestion,
        options: cleanOptions.map((text, index) => ({
          id: `option-${index + 1}`,
          text,
          votes: 0,
        })),
        voters: {},
        status: "active",
        createdAt: Date.now(),
        endsAt: Date.now() + LIVE_POLL_DURATION_MS,
        concludedAt: 0,
      };
      clearLivePollTimers(room);
      room.activePoll = poll;
      room.activePollTimer = setTimeout(
        () => concludeLivePoll(io, broadcastId, poll.id),
        LIVE_POLL_DURATION_MS
      );
      bumpLiveRoomVersion(room);
      const serializedPoll = serializeLivePoll(poll);
      io.to(`live:${broadcastId}`).emit("live:poll:update", { broadcastId, poll: serializedPoll });
      emitLiveRoom(io, broadcastId);
      emitLiveBroadcastList(io);
      ack?.({ ok: true, poll: serializedPoll, broadcast: serializeBroadcast(room) });
    });

    socket.on("live:poll:vote", ({ broadcastId, pollId, optionId }, ack) => {
      const room = liveBroadcasts.get(broadcastId);
      const userId = String(socket.user.userId || "");
      if (!room) {
        return ack?.(liveAckError("room_not_found", "Broadcast not found."));
      }
      if (!isLiveRoomMember(room, userId)) {
        return ack?.(liveAckError("not_in_room", "Join the room before voting."));
      }
      const poll = room.activePoll;
      if (!poll || String(poll.id) !== String(pollId || "")) {
        return ack?.(liveAckError("poll_not_found", "Poll is no longer available."));
      }
      if (
        String(poll.status || "active") !== "active" ||
        (Number(poll.endsAt || 0) > 0 && Date.now() >= Number(poll.endsAt || 0))
      ) {
        concludeLivePoll(io, broadcastId, poll.id);
        return ack?.(liveAckError("poll_closed", "This poll has concluded."));
      }
      const option = (poll.options || []).find((item) => String(item.id) === String(optionId || ""));
      if (!option) {
        return ack?.(liveAckError("option_not_found", "Poll option was not found."));
      }
      poll.voters = poll.voters || {};
      const previousOptionId = poll.voters[userId];
      if (previousOptionId && previousOptionId !== option.id) {
        const previousOption = (poll.options || []).find((item) => String(item.id) === String(previousOptionId));
        if (previousOption) {
          previousOption.votes = Math.max(0, Number(previousOption.votes || 0) - 1);
        }
      }
      if (previousOptionId !== option.id) {
        option.votes = Number(option.votes || 0) + 1;
      }
      poll.voters[userId] = option.id;
      bumpLiveRoomVersion(room);
      const serializedPoll = serializeLivePoll(poll);
      io.to(`live:${broadcastId}`).emit("live:poll:update", { broadcastId, poll: serializedPoll });
      emitLiveRoom(io, broadcastId);
      emitLiveBroadcastList(io);
      ack?.({ ok: true, poll: serializedPoll, selectedOptionId: option.id });
    });

    socket.on("live:reaction", ({ broadcastId, emoji }, ack) => {
      const room = liveBroadcasts.get(broadcastId);
      const userId = String(socket.user.userId);
      const cleanEmoji = String(emoji || "").trim().slice(0, 16);
      if (!room) {
        return ack?.(liveAckError("room_not_found", "Broadcast not found."));
      }
      if (!cleanEmoji) {
        return ack?.(liveAckError("emoji_required", "Reaction is required."));
      }
      if (!isLiveRoomMember(room, userId)) {
        return ack?.(liveAckError("not_in_room", "Join the room before sending reactions."));
      }
      const reaction = {
        broadcastId,
        emoji: cleanEmoji,
        userId,
        ts: Date.now(),
      };
      io.to(`live:${broadcastId}`).emit("live:reaction", reaction);
      ack?.({ ok: true });
    });

    socket.on("live:room:update", ({ broadcastId, title, description, lang, lang2 }, ack) => {
      const room = liveBroadcasts.get(broadcastId);
      const requesterId = String(socket.user.userId);
      if (!room) {
        return ack?.(liveAckError("room_not_found", "Broadcast not found."));
      }
      if (room.hostUserId !== requesterId) {
        return ack?.(liveAckError("not_host", "Only the host can edit room settings."));
      }
      const cleanTitle = String(title || "").trim().slice(0, 120);
      const cleanDescription = String(description || "").trim().slice(0, 160);
      const cleanLang = String(lang || room.lang || "English").trim().slice(0, 40);
      const cleanLang2 = String(lang2 || "").trim().slice(0, 40);
      if (!cleanTitle) {
        return ack?.(liveAckError("title_required", "Title is required."));
      }
      if (cleanTitle.length > 55) {
        return ack?.(liveAckError("title_too_long", "Title is too long."));
      }
      room.title = cleanTitle;
      room.description = cleanDescription;
      room.lang = cleanLang || "English";
      room.lang2 = cleanLang2;
      bumpLiveRoomVersion(room);
      emitLiveRoom(io, broadcastId);
      emitLiveBroadcastList(io);
      ack?.({ ok: true, broadcast: serializeBroadcast(room) });
    });

    socket.on("live:room:appearance:update", ({ broadcastId, backgroundTheme }, ack) => {
      const room = liveBroadcasts.get(broadcastId);
      const requesterId = String(socket.user.userId);
      if (!room) {
        return ack?.(liveAckError("room_not_found", "Broadcast not found."));
      }
      if (room.hostUserId !== requesterId) {
        return ack?.(liveAckError("not_host", "Only the host can edit room appearance."));
      }
      const nextBackgroundTheme = normalizeLiveBackgroundTheme(backgroundTheme);
      room.backgroundTheme = nextBackgroundTheme;
      bumpLiveRoomVersion(room);
      emitLiveRoom(io, broadcastId);
      emitLiveBroadcastList(io);
      ack?.({ ok: true, broadcast: serializeBroadcast(room) });
    });

    socket.on("live:role:update", ({ broadcastId, targetUserId, role }, ack) => {
      const room = liveBroadcasts.get(broadcastId);
      const requesterId = String(socket.user.userId);
      if (!room) {
        return ack?.(liveAckError("room_not_found", "Broadcast not found."));
      }
      if (room.hostUserId !== requesterId) {
        return ack?.(liveAckError("not_host", "Only the host can manage moderators."));
      }
      const userId = String(targetUserId || "").trim();
      if (!userId || userId === room.hostUserId) {
        return ack?.(liveAckError("invalid_target", "That participant cannot be updated."));
      }
      const participant = findLiveParticipant(room, userId);
      if (!participant) {
        return ack?.(liveAckError("participant_not_found", "Participant not found in this room."));
      }
      const nextRole = String(role || "").trim().toLowerCase();
      if (nextRole === "moderator") {
        room.moderators = (room.moderators || []).filter(
          (moderator) => String(moderator.userId || "") !== userId
        );
        room.moderators.unshift(participant);
      } else {
        room.moderators = (room.moderators || []).filter(
          (moderator) => String(moderator.userId || "") !== userId
        );
      }
      bumpLiveRoomVersion(room);
      emitLiveRoom(io, broadcastId);
      emitLiveBroadcastList(io);
      ack?.({ ok: true, broadcast: serializeBroadcast(room) });
    });

    socket.on("live:raise-hand", ({ broadcastId, name, photo }, ack) => {
      const room = liveBroadcasts.get(broadcastId);
      if (!room) return ack?.({ ok: false });
      const userId = String(socket.user.userId);
      if (room.hostUserId === userId) return ack?.({ ok: false });
      if (!room.joinRequests.some((r) => String(r.userId) === userId)) {
        room.joinRequests.unshift({ userId, name: String(name || `User ${userId}`), photo: photo || "" });
        bumpLiveRoomVersion(room);
      }
      io.to(`user:${room.hostUserId}`).emit("live:join-requests", { broadcastId, requests: room.joinRequests });
      emitLiveRoom(io, broadcastId);
      ack?.({ ok: true });
    });

    socket.on("live:lower-hand", ({ broadcastId }, ack) => {
      const room = liveBroadcasts.get(broadcastId);
      if (!room) return ack?.({ ok: false });
      const userId = String(socket.user.userId);
      const before = room.joinRequests.length;
      room.joinRequests = room.joinRequests.filter((r) => String(r.userId) !== userId);
      if (room.joinRequests.length !== before) {
        bumpLiveRoomVersion(room);
        io.to(`user:${room.hostUserId}`).emit("live:join-requests", { broadcastId, requests: room.joinRequests });
        emitLiveRoom(io, broadcastId);
      }
      ack?.({ ok: true });
    });

    socket.on("live:request:decision", ({ broadcastId, userId, accept }, ack) => {
      const finish = async () => {
      const room = liveBroadcasts.get(broadcastId);
      const requesterId = String(socket.user.userId);
      if (!room) {
        auditLiveModeration("request_decision", {
          roomId: String(broadcastId || ""),
          requesterId,
          targetUserId: String(userId || ""),
          result: "error",
          code: "room_not_found",
        });
        return ack?.(liveAckError("room_not_found", "Broadcast not found."));
      }
      if (room.hostUserId !== requesterId) {
        auditLiveModeration("request_decision", {
          roomId: room.id,
          requesterId,
          targetUserId: String(userId || ""),
          result: "error",
          code: "not_host",
        });
        return ack?.(liveAckError("not_host", "Only the host can manage stage requests."));
      }
      normalizeLiveStageSlots(room);
      const req = room.joinRequests.find((r) => String(r.userId) === String(userId));
      if (!req) {
        auditLiveModeration("request_decision", {
          roomId: room.id,
          requesterId,
          targetUserId: String(userId || ""),
          result: "error",
          code: "request_not_found",
        });
        return ack?.(liveAckError("request_not_found", "Stage request not found."));
      }
      if (accept) {
        room.joinRequests = room.joinRequests.filter((r) => String(r.userId) !== String(userId));
        if (room.type === "audio") {
          const openIndex = room.speakers.findIndex((s, index) => index > 0 && !s);
          if (openIndex < 0) {
            auditLiveModeration("request_decision", {
              roomId: room.id,
              requesterId,
              targetUserId: String(userId || ""),
              result: "error",
              code: "stage_full",
            });
            return ack?.(liveAckError("stage_full", "The stage is full."));
          }
          room.pendingStageApprovals = (room.pendingStageApprovals || []).filter(
            (item) => String(item.userId) !== String(userId)
          );
          room.pendingStageApprovals.unshift({
            userId: String(req.userId),
            name: req.name,
            photo: req.photo || "",
          });
          bumpLiveRoomVersion(room);
        } else {
          const openIndex = room.speakers.findIndex((s, index) => index > 0 && !s);
          if (openIndex < 0) {
            auditLiveModeration("request_decision", {
              roomId: room.id,
              requesterId,
              targetUserId: String(userId || ""),
              result: "error",
              code: "stage_full",
            });
            return ack?.(liveAckError("stage_full", "The stage is full."));
          }
          room.speakers[openIndex] = {
            id: `speaker-${req.userId}`,
            userId: String(req.userId),
            name: req.name,
            photo: req.photo || "",
            role: "Speaker",
            muted: false,
          };
          room.audienceMembers = room.audienceMembers.filter((member) => String(member.userId) !== String(userId));
          room.comments.push({ id: `sys-${Date.now()}`, author: "System", text: `${req.name} joined the stage.`, ts: Date.now() });
          bumpLiveSpeakerVersion(room);
        }
      } else {
        room.joinRequests = room.joinRequests.filter((r) => String(r.userId) !== String(userId));
        room.pendingStageApprovals = (room.pendingStageApprovals || []).filter(
          (item) => String(item.userId) !== String(userId)
        );
        bumpLiveRoomVersion(room);
      }
      if (room.type !== "audio") {
        await updateLivekitParticipantPermission(room, userId, Boolean(accept));
      }
      io.to(`user:${userId}`).emit("live:request:decision", {
        broadcastId,
        accept: Boolean(accept),
        muted: room.type === "audio" ? true : undefined,
        roomVersion: room.roomVersion,
        speakerVersion: room.speakerVersion,
      });
      if (accept && room.type !== "audio") {
        await emitLiveMediaSession(io, room, userId, req.name);
      }
      io.to(`user:${room.hostUserId}`).emit("live:join-requests", { broadcastId, requests: room.joinRequests });
      emitLiveRoom(io, broadcastId);
      auditLiveModeration("request_decision", {
        roomId: room.id,
        requesterId,
        targetUserId: String(userId || ""),
        accept: Boolean(accept),
        result: "ok",
      });
      ack?.({
        ok: true,
        broadcast: serializeBroadcast(room),
        pendingStage: room.type === "audio" && Boolean(accept),
      });
      };
      finish().catch((error) => {
        console.error("[livekit] request decision failed", error);
        ack?.(liveAckError("request_decision_failed", "Unable to update request."));
      });
    });

    socket.on("live:speaker:ready", ({ broadcastId }, ack) => {
      const finish = async () => {
      const room = liveBroadcasts.get(broadcastId);
      if (!room) return ack?.(liveAckError("room_not_found", "Broadcast not found."));
      if (room.type !== "audio") {
        return ack?.(liveAckError("invalid_room_type", "Stage ready is only used for audio rooms."));
      }
      normalizeLiveStageSlots(room);
      const userId = String(socket.user.userId);
      const approved = (room.pendingStageApprovals || []).find(
        (item) => String(item.userId) === userId
      );
      if (!approved) {
        return ack?.(liveAckError("stage_approval_not_found", "Stage approval not found."));
      }
      const alreadySpeaker = (room.speakers || []).some(
        (speaker) => speaker && String(speaker.userId) === userId
      );
      if (!alreadySpeaker) {
        const openIndex = room.speakers.findIndex((s, index) => index > 0 && !s);
        if (openIndex < 0) {
          return ack?.(liveAckError("stage_full", "The stage is full."));
        }
        room.speakers[openIndex] = {
          id: `speaker-${approved.userId}`,
          userId,
          name: approved.name,
          photo: approved.photo || "",
          role: "Speaker",
          muted: true,
        };
        room.comments.push({
          id: `sys-${Date.now()}`,
          author: "System",
          text: `${approved.name} joined the stage.`,
          ts: Date.now(),
        });
      }
      room.pendingStageApprovals = (room.pendingStageApprovals || []).filter(
        (item) => String(item.userId) !== userId
      );
      room.audienceMembers = room.audienceMembers.filter(
        (member) => String(member.userId) !== userId
      );
      socket.data.liveBroadcastRole = "speaker";
      bumpLiveSpeakerVersion(room);
      await updateLivekitParticipantPermission(room, userId, true);
      const mediaSession = await emitLiveMediaSession(io, room, userId, approved.name);
      emitLiveRoom(io, broadcastId);
      ack?.({
        ok: true,
        broadcast: serializeBroadcast(room),
        mediaSession,
      });
      };
      finish().catch((error) => {
        console.error("[livekit] speaker ready failed", error);
        ack?.(liveAckError("speaker_ready_failed", "Unable to join stage."));
      });
    });

    socket.on("live:speaker:leave-stage", ({ broadcastId }, ack) => {
      const finish = async () => {
      const room = liveBroadcasts.get(broadcastId);
      if (!room) return ack?.(liveAckError("room_not_found", "Broadcast not found."));
      const userId = String(socket.user.userId);
      if (room.hostUserId === userId) {
        return ack?.(liveAckError("host_cannot_leave_stage", "The host cannot leave the stage."));
      }
      const speaker = (room.speakers || []).find((s) => s && String(s.userId) === userId);
      if (!speaker) {
        return ack?.(liveAckError("target_not_on_stage", "You are not on stage."));
      }
      room.speakers = (room.speakers || []).map((s) => (s && String(s.userId) === userId ? null : s));
      if (speaker && !room.audienceMembers.some((member) => String(member.userId) === userId)) {
        room.audienceMembers.unshift({ userId, name: speaker.name, photo: speaker.photo || "" });
      }
      if (speaker) {
        room.comments.push({ id: `sys-${Date.now()}`, author: "System", text: `${speaker.name} left the stage.`, ts: Date.now() });
      }
      bumpLiveSpeakerVersion(room);
      socket.data.liveBroadcastRole = "audience";
      await updateLivekitParticipantPermission(room, userId, false);
      emitLiveSpeaking(io, room, userId, false);
      emitLiveRoom(io, broadcastId);
      ack?.({ ok: true, broadcast: serializeBroadcast(room) });
      };
      finish().catch((error) => {
        console.error("[livekit] leave stage failed", error);
        ack?.(liveAckError("leave_stage_failed", "Unable to leave stage."));
      });
    });

    socket.on("live:speaker:remove", ({ broadcastId, targetUserId }, ack) => {
      const finish = async () => {
      const room = liveBroadcasts.get(broadcastId);
      const requesterId = String(socket.user.userId);
      if (!room) {
        auditLiveModeration("speaker_remove", {
          roomId: String(broadcastId || ""),
          requesterId,
          targetUserId: String(targetUserId || ""),
          result: "error",
          code: "room_not_found",
        });
        return ack?.(liveAckError("room_not_found", "Broadcast not found."));
      }
      if (room.hostUserId !== requesterId) {
        auditLiveModeration("speaker_remove", {
          roomId: room.id,
          requesterId,
          targetUserId: String(targetUserId || ""),
          result: "error",
          code: "not_host",
        });
        return ack?.(liveAckError("not_host", "Only the host can remove a speaker."));
      }
      const userId = String(targetUserId || "");
      if (!userId || userId === room.hostUserId) {
        auditLiveModeration("speaker_remove", {
          roomId: room.id,
          requesterId,
          targetUserId: userId,
          result: "error",
          code: "invalid_target",
        });
        return ack?.(liveAckError("invalid_target", "That participant cannot be removed from stage."));
      }
      const speaker = (room.speakers || []).find(
        (item) => item && String(item.userId) === userId
      );
      if (!speaker) {
        auditLiveModeration("speaker_remove", {
          roomId: room.id,
          requesterId,
          targetUserId: userId,
          result: "error",
          code: "target_not_on_stage",
        });
        return ack?.(liveAckError("target_not_on_stage", "Participant is not on stage."));
      }
      room.speakers = (room.speakers || []).map((item) =>
        item && String(item.userId) === userId ? null : item
      );
      if (!room.audienceMembers.some((member) => String(member.userId) === userId)) {
        room.audienceMembers.unshift({
          userId,
          name: speaker.name,
          photo: speaker.photo || "",
        });
      }
      room.comments.push({
        id: `sys-${Date.now()}`,
        author: "System",
        text: `${speaker.name} was removed from the stage.`,
        ts: Date.now(),
      });
      bumpLiveSpeakerVersion(room);
      await updateLivekitParticipantPermission(room, userId, false);
      emitLiveSpeaking(io, room, userId, false);
      emitLiveRoom(io, broadcastId);
      auditLiveModeration("speaker_remove", {
        roomId: room.id,
        requesterId,
        targetUserId: userId,
        result: "ok",
      });
      ack?.({ ok: true, broadcast: serializeBroadcast(room) });
      };
      finish().catch((error) => {
        console.error("[livekit] remove speaker failed", error);
        ack?.(liveAckError("speaker_remove_failed", "Unable to remove speaker."));
      });
    });

    socket.on("live:speaker:mute", ({ broadcastId, muted }, ack) => {
      const room = liveBroadcasts.get(broadcastId);
      if (!room) return ack?.(liveAckError("room_not_found", "Broadcast not found."));
      const userId = String(socket.user.userId);
      const speakerIndex = (room.speakers || []).findIndex(
        (speaker) => speaker && String(speaker.userId) === userId
      );
      if (speakerIndex < 0) {
        return ack?.(liveAckError("speaker_not_on_stage", "You are not on stage."));
      }
      const mutedNow = Boolean(muted);
      room.speakers[speakerIndex] = {
        ...room.speakers[speakerIndex],
        muted: mutedNow,
      };
      bumpLiveSpeakerVersion(room);
      io.to(`live:${broadcastId}`).emit("live:speaker:mute:update", {
        broadcastId,
        userId,
        muted: mutedNow,
        speakerVersion: room.speakerVersion,
      });
      if (mutedNow) {
        emitLiveSpeaking(io, room, userId, false);
      }
      emitLiveRoom(io, broadcastId);
      ack?.({ ok: true, speakerVersion: room.speakerVersion, broadcast: serializeBroadcast(room) });
    });

    socket.on("live:speaking", ({ broadcastId, speaking }, ack) => {
      const room = liveBroadcasts.get(broadcastId);
      if (!room) return ack?.(liveAckError("room_not_found", "Broadcast not found."));
      const userId = String(socket.user.userId);
      const speaker = (room.speakers || []).find(
        (item) => item && String(item.userId) === userId
      );
      if (!speaker) {
        return ack?.(liveAckError("speaker_not_on_stage", "You are not on stage."));
      }
      const speakingNow = speaker.muted === true ? false : Boolean(speaking);
      emitLiveSpeaking(io, room, userId, speakingNow);
      ack?.({ ok: true });
    });

    socket.on("live:media:session:get", async ({ broadcastId }, ack) => {
      const room = liveBroadcasts.get(broadcastId);
      if (!room) return ack?.({ ok: false, message: "not found" });
      if (room.type !== "audio") {
        return ack?.({ ok: false, message: "media session is only used for audio rooms" });
      }
      if (socket.user?.isGuestLivePreview) {
        const expiresAt = Number(socket.data.liveGuestPreviewExpiresAt || 0);
        if (
          String(socket.data.liveBroadcastId || "") !== String(broadcastId || "") ||
          expiresAt <= Date.now()
        ) {
          endGuestLivePreview(io, socket, broadcastId);
          return ack?.({
            ok: false,
            code: "guest_preview_expired",
            message: "Create a free account to continue listening.",
          });
        }
      }
      const mediaSession = await buildLiveMediaSession({
        room,
        userId: socket.user.userId,
        participantName: resolveLiveParticipantName(room, socket.user.userId),
        canPublish: canPublishLiveAudio(room, socket.user.userId),
        ttl: socket.user?.isGuestLivePreview
          ? `${Math.ceil(Math.max(1, Number(socket.data.liveGuestPreviewExpiresAt || 0) - Date.now() + LIVE_GUEST_PREVIEW_GRACE_MS) / 1000)}s`
          : undefined,
      });
      if (!mediaSession) {
        return ack?.({ ok: false, message: "live audio session is not configured" });
      }
      ack?.({ ok: true, mediaSession });
    });

    socket.on("live:rtc:offer", ({ broadcastId, toUserId, sdp }, ack) => {
      if (!broadcastId || !toUserId || !sdp) return ack?.({ ok: false });
      io.to(`user:${toUserId}`).emit("live:rtc:offer", { broadcastId, fromUserId: socket.user.userId, sdp });
      ack?.({ ok: true });
    });

    socket.on("live:rtc:answer", ({ broadcastId, toUserId, sdp }, ack) => {
      if (!broadcastId || !toUserId || !sdp) return ack?.({ ok: false });
      io.to(`user:${toUserId}`).emit("live:rtc:answer", { broadcastId, fromUserId: socket.user.userId, sdp });
      ack?.({ ok: true });
    });

    socket.on("live:rtc:ice", ({ broadcastId, toUserId, candidate }, ack) => {
      if (!broadcastId || !toUserId || !candidate) return ack?.({ ok: false });
      io.to(`user:${toUserId}`).emit("live:rtc:ice", { broadcastId, fromUserId: socket.user.userId, candidate });
      ack?.({ ok: true });
    });

    socket.on("disconnect", async () => {
      clearGuestLivePreviewTimer(socket);
      removeFromQueue(socket.id);
      removePresenceWatcher(socket.id);
      liveUserSockets.delete(String(socket.user.userId));
      emitPresence(io, socket.user.userId, false);
      if (socket.data.liveBroadcastId) {
        const broadcastId = socket.data.liveBroadcastId;
        const room = liveBroadcasts.get(broadcastId);
        if (socket.user?.isGuestLivePreview) {
          void removeLivekitPreviewParticipant(broadcastId, socket.user.userId);
        } else if (room) {
          const userId = String(socket.user.userId);
          if (room.hostUserId === userId) {
            io.to(`live:${broadcastId}`).emit("live:broadcast:ended", { broadcastId, reason: "host_left" });
            clearLiveRoomState(room);
            liveBroadcasts.delete(broadcastId);
          } else {
            room.audienceMembers = room.audienceMembers.filter((m) => String(m.userId) !== userId);
            room.joinRequests = room.joinRequests.filter((r) => String(r.userId) !== userId);
            room.pendingStageApprovals = (room.pendingStageApprovals || []).filter(
              (item) => String(item.userId) !== userId
            );
            const disconnectedSpeaker = (room.speakers || []).find(
              (s) => s && String(s.userId) === userId
            );
            room.speakers = (room.speakers || []).map((s) => (s && String(s.userId) === userId ? null : s));
            if (disconnectedSpeaker) {
              bumpLiveSpeakerVersion(room);
              emitLiveSpeaking(io, room, userId, false);
            } else {
              bumpLiveRoomVersion(room);
            }
            emitLiveRoom(io, broadcastId);
          }
          emitLiveBroadcastList(io);
        }
        socket.data.liveBroadcastId = null;
        socket.data.liveBroadcastRole = null;
      }
      if (socket.data.directCallThreadId) {
        const threadId = socket.data.directCallThreadId;
        clearPendingDirectCall(io, threadId);
        const session = await resolveDirectCallSession(pool, {
          callId: socket.data.directCallId,
          threadId,
        });
        const updated = session
          ? await updateDirectCallSession(pool, session.callId, {
              state: "ended",
              endedAtNow: true,
              endedByUserId: socket.user.userId,
              allowedStates: ["ringing", "accepted", "active"],
            })
          : null;
        io.to(`dm:${threadId}`).emit(
          "dm:call:end",
          buildDirectCallEventPayload(updated || session, {
            threadId,
            fromUserId: socket.user.userId,
            reason: "disconnect",
          })
        );
        if (session) {
          void recordDirectCallEvent(pool, {
            callId: session.callId,
            threadId: session.threadId,
            eventType: "call.disconnected",
            userId: socket.user.userId,
            actorUserId: socket.user.userId,
            payload: { reason: "disconnect" },
          }).catch((error) => {
            console.error("[direct-call] Failed to persist disconnect event", error);
          });
          void notifyDirectCallLifecyclePush(pool, updated || session, "end", socket.user.userId).catch((error) => {
            console.error("[direct-call] Failed to send disconnect end push", error);
          });
        }
        socket.data.directCallThreadId = null;
        socket.data.directCallId = null;
      }
      if (socket.data.matchId) {
        leaveMatch(io, socket, socket.data.matchId, "disconnect");
        socket.data.matchId = null;
      }
    });
  });

  return io;
}

async function attemptMatch(io, pool) {
  await refreshAnonymousMatchCooldownSetting(pool);
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i];
    const sa = io.sockets.sockets.get(a.socketId);
    if (!sa) {
      queue.splice(i, 1);
      i -= 1;
      continue;
    }

    for (let j = i + 1; j < queue.length; j++) {
      const b = queue[j];
      const sb = io.sockets.sockets.get(b.socketId);
      if (!sb) {
        queue.splice(j, 1);
        j -= 1;
        continue;
      }

      if (hasRecentPair(a.userId, b.userId)) continue;
      if (!mutualCriteria(a, b)) continue;
      if (hasRecentSkip(a.userId, b.userId)) continue;

      const matchId = `m_${Date.now()}_${Math.random().toString(16).slice(2)}`;

      // Remove from queue
      queue.splice(j, 1);
      queue.splice(i, 1);

      sa.join(matchId);
      sb.join(matchId);

      sa.data.matchId = matchId;
      sb.data.matchId = matchId;

      const endsAt = Date.now() + MATCH_DURATION_MS;

      // hard end timer
      const timer = setTimeout(() => {
        leaveMatch(io, sa, matchId, "time");
      }, MATCH_DURATION_MS);

      activeMatches.set(matchId, {
        aUserId: a.userId,
        bUserId: b.userId,
        aSocketId: a.socketId,
        bSocketId: b.socketId,
        endsAt,
        timer,
      });
      rememberPair(a.userId, b.userId);
      logAnonMatch("match_found", {
        matchId,
        aUserId: a.userId,
        bUserId: b.userId,
        aSocketId: a.socketId,
        bSocketId: b.socketId,
        endsAt,
        queueSize: queue.length,
      });

      sa.emit("match:found", { matchId, partnerId: b.userId, endsAt });
      sb.emit("match:found", { matchId, partnerId: a.userId, endsAt });

      return;
    }
  }

  return io;
}
