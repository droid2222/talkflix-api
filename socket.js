import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";

// === In-memory state (MVP) ===
const queue = []; // waiting users
const activeMatches = new Map(); // matchId -> { aUserId, bUserId, aSocketId, bSocketId, endsAt, timer }
const pendingCalls = new Map(); // matchId -> { timer, fromUserId, requestedAt }
const pendingDirectCalls = new Map(); // threadId -> { timer, fromUserId, requestedAt }
const liveBroadcasts = new Map(); // broadcastId -> room state
const liveUserSockets = new Map(); // userId -> socketId
const presenceWatchers = new Map(); // watchedUserId -> Set(socketId)
const recentPairs = new Map(); // userId -> Map(otherUserId -> ts)

const REMATCH_COOLDOWN_MS = 0 * 60 * 60 * 1000;
const MATCH_DURATION_MS = 10 * 60 * 1000;
const SKIP_COOLDOWN_MS = 0 * 60 * 1000;
const recentSkips = new Map(); // userId -> Map(otherUserId -> ts)

let livekitRoomService = null;

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

async function buildLiveMediaSession({ room, userId, participantName, canPublish }) {
  if (!hasLivekitConfig() || !room || room.type !== "audio") return null;
  const apiKey = String(process.env.LIVEKIT_API_KEY || "").trim();
  const apiSecret = String(process.env.LIVEKIT_API_SECRET || "").trim();
  const accessToken = new AccessToken(apiKey, apiSecret, {
    identity: String(userId),
    name: resolveLiveParticipantName(room, userId, participantName),
  });
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
  return now - ts < SKIP_COOLDOWN_MS;
}

function cleanupSkips() {
  const now = Date.now();
  for (const [u, m] of recentSkips.entries()) {
    for (const [v, ts] of m.entries()) {
      if (now - ts >= SKIP_COOLDOWN_MS) m.delete(v);
    }
    if (m.size === 0) recentSkips.delete(u);
  }
}





function isProLike({ role, plan }) {
  return role === "admin" || plan === "pro" || plan === "trial";
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
  return now - ts < REMATCH_COOLDOWN_MS;
}

function cleanupRecentPairs() {
  const now = Date.now();
  for (const [u, m] of recentPairs.entries()) {
    for (const [v, ts] of m.entries()) {
      if (now - ts >= REMATCH_COOLDOWN_MS) m.delete(v);
    }
    if (m.size === 0) recentPairs.delete(u);
  }
}

function ensureLiveRoomVersionState(room) {
  if (!room) return;
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
  if (a.criteria.language !== b.criteria.language) return false;

  // gender filter
  if (a.criteria.gender !== "any" && b.gender && b.gender !== a.criteria.gender) return false;
  if (b.criteria.gender !== "any" && a.gender && a.gender !== b.criteria.gender) return false;

  // age filter
  if (a.age != null && (a.age < a.criteria.ageMin || a.age > a.criteria.ageMax)) return false;
  if (b.age != null && (b.age < b.criteria.ageMin || b.age > b.criteria.ageMax)) return false;

  return true;
}

function removeFromQueue(socketId) {
  const idx = queue.findIndex((q) => q.socketId === socketId);
  if (idx >= 0) queue.splice(idx, 1);
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

function leaveMatch(io, socket, matchId, reason = "ended") {
  if (!matchId) return;

  const info = activeMatches.get(matchId);

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
  const speakers = (room.speakers || []).map((speaker) =>
    speaker ? { ...speaker, muted: speaker.muted === true } : null
  );
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
    attendees: stageCount + (room.audienceMembers?.length || 0),
    audienceCount: room.audienceMembers?.length || 0,
    audienceMembers: room.audienceMembers || [],
    speakers,
    joinRequests: room.joinRequests || [],
    comments: room.comments || [],
    createdAt: room.createdAt,
    roomVersion: room.roomVersion,
    speakerVersion: room.speakerVersion,
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

      if (!token) return next(new Error("unauthorized"));

      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = {
        userId: payload.sub,
        role: payload.role || "user",
        plan: payload.plan || "free",
      };

      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    socket.data.matchId = null;
    socket.join(`user:${socket.user.userId}`);
    liveUserSockets.set(String(socket.user.userId), socket.id);
    emitPresence(io, socket.user.userId, true);

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
    
      socket.to(matchId).emit("chat:typing", {
        matchId,
        from: socket.user.userId,
        typing: Boolean(typing),
      });
    
      ack?.({ ok: true });
    });

    socket.on("call:camera-state", ({ matchId, enabled }, ack) => {
      if (!matchId) return ack?.({ ok: false });
    
      io.to(matchId).emit("call:camera-state", {
        matchId,
        from: socket.user.userId,
        enabled: Boolean(enabled),
      });
    
      ack?.({ ok: true });
    });

    socket.on("match:join", async (criteria, ack) => {
      try {
        cleanupRecentPairs();
        cleanupSkips();

        if (!isProLike(socket.user)) return ack?.({ ok: false, message: "Pro required" });

        const language = String(criteria?.language || "").trim();
        if (!language) return ack?.({ ok: false, message: "language required" });

        const gender = criteria?.gender === "male" || criteria?.gender === "female" ? criteria.gender : "any";
        const ageMin = Math.max(Number(criteria?.ageMin || 18), 18);
        const ageMax = Math.min(Number(criteria?.ageMax || 90), 90);

        // If already queued, ignore
        if (queue.some((q) => q.socketId === socket.id)) return ack?.({ ok: true, queued: true });

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

        attemptMatch(io);
        ack?.({ ok: true, queued: true });
      } catch (e) {
        ack?.({ ok: false, message: "failed to join queue" });
      }
    });


    socket.on("match:leave", (ack) => {
      removeFromQueue(socket.id);
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
      console.log("[anon-call] call:request", {
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
      console.log("[anon-call] call:accept", {
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
      console.log("[anon-call] call:cancel", {
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
      console.log("[anon-call] rtc:offer", {
        matchId,
        from: socket.user.userId,
        type: sdp?.type,
      });
      io.to(matchId).emit("rtc:offer", { from: socket.user.userId, sdp });
      ack?.({ ok: true });
    });

    socket.on("rtc:answer", ({ matchId, sdp }, ack) => {
      console.log("[anon-call] rtc:answer", {
        matchId,
        from: socket.user.userId,
        type: sdp?.type,
      });
      io.to(matchId).emit("rtc:answer", { from: socket.user.userId, sdp });
      ack?.({ ok: true });
    });

    socket.on("rtc:ice", ({ matchId, candidate }, ack) => {
      console.log("[anon-call] rtc:ice", {
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
        const hasPayload = Boolean(
          (typeof message.text === "string" && message.text.length > 0) ||
          message.type === "image" ||
          message.type === "audio" ||
          message.type === "system"
        );
        if (!hasPayload) return ack?.({ ok: false });
        const otherUserId = getOtherDirectThreadUserId(message.threadId, socket.user.userId);
        if (!otherUserId) return ack?.({ ok: false });
        const blockState = await getDirectBlockState(pool, socket.user.userId, otherUserId);
        if (blockState.blocked) {
          return ack?.({
            ok: false,
            message: buildBlockedActionMessage({
              action: "messaging",
              youBlockedUser: blockState.youBlockedUser,
              blockedByUser: blockState.blockedByUser,
            }),
          });
        }
        const payload = { ...message, fromUserId: String(socket.user.userId) };
        io.to(`dm:${message.threadId}`).emit("dm:message", payload);
        ack?.({ ok: true });
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
        socket.data.directCallThreadId = threadId;
        clearPendingDirectCall(io, threadId);
        const requestedAt = Date.now();
        const wantsVideo = Boolean(video);
        const timer = setTimeout(() => {
          io.to(`dm:${threadId}`).emit("dm:call:missed", { threadId, fromUserId: socket.user.userId, requestedAt, endedAt: Date.now(), video: wantsVideo });
          pendingDirectCalls.delete(threadId);
        }, 30000);
        pendingDirectCalls.set(threadId, { timer, fromUserId: socket.user.userId, requestedAt, wantsVideo });
        io.to(`dm:${threadId}`).emit("dm:call:request", { threadId, fromUserId: socket.user.userId, requestedAt, video: wantsVideo });
        io.to(`user:${otherUserId}`).emit("dm:call:request:global", { threadId, fromUserId: socket.user.userId, requestedAt, video: wantsVideo });
        ack?.({ ok: true });
      } catch (error) {
        console.error(error);
        ack?.({ ok: false, message: "Could not start call." });
      }
    });

    socket.on("dm:call:accept", ({ threadId, accept }, ack) => {
      if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
        return ack?.({ ok: false });
      }
      if (accept) socket.data.directCallThreadId = threadId;
      const pending = pendingDirectCalls.get(threadId);
      const acceptedAt = Date.now();
      clearPendingDirectCall(io, threadId);
      io.to(`dm:${threadId}`).emit("dm:call:accept", { threadId, fromUserId: socket.user.userId, accept: Boolean(accept), acceptedAt: accept ? acceptedAt : undefined, requestedAt: pending?.requestedAt, video: Boolean(pending?.wantsVideo) });
      ack?.({ ok: true, acceptedAt: accept ? acceptedAt : undefined, requestedAt: pending?.requestedAt, video: Boolean(pending?.wantsVideo) });
    });

    socket.on("dm:call:ready", ({ threadId }, ack) => {
      if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
        return ack?.({ ok: false });
      }
      socket.to(`dm:${threadId}`).emit("dm:call:ready", { threadId, fromUserId: socket.user.userId, readyAt: Date.now() });
      ack?.({ ok: true });
    });

    socket.on("dm:call:cancel", ({ threadId }, ack) => {
      if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
        return ack?.({ ok: false });
      }
      if (socket.data.directCallThreadId === threadId) socket.data.directCallThreadId = null;
      const pending = pendingDirectCalls.get(threadId);
      clearPendingDirectCall(io, threadId);
      io.to(`dm:${threadId}`).emit("dm:call:cancel", { threadId, fromUserId: socket.user.userId, requestedAt: pending?.requestedAt, endedAt: Date.now() });
      const otherUserId = getOtherDirectThreadUserId(threadId, socket.user.userId);
      if (otherUserId) io.to(`user:${otherUserId}`).emit("dm:call:cancel", { threadId, fromUserId: socket.user.userId, endedAt: Date.now() });
      ack?.({ ok: true });
    });

    socket.on("dm:rtc:offer", ({ threadId, sdp }, ack) => {
      if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
        return ack?.({ ok: false });
      }
      socket.to(`dm:${threadId}`).emit("dm:rtc:offer", { threadId, fromUserId: socket.user.userId, sdp });
      ack?.({ ok: true });
    });

    socket.on("dm:rtc:answer", ({ threadId, sdp }, ack) => {
      if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
        return ack?.({ ok: false });
      }
      socket.to(`dm:${threadId}`).emit("dm:rtc:answer", { threadId, fromUserId: socket.user.userId, sdp });
      ack?.({ ok: true });
    });

    socket.on("dm:rtc:ice", ({ threadId, candidate }, ack) => {
      if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
        return ack?.({ ok: false });
      }
      socket.to(`dm:${threadId}`).emit("dm:rtc:ice", { threadId, fromUserId: socket.user.userId, candidate });
      ack?.({ ok: true });
    });

    socket.on("dm:call:end", ({ threadId }, ack) => {
      if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
        return ack?.({ ok: false });
      }
      if (socket.data.directCallThreadId === threadId) socket.data.directCallThreadId = null;
      clearPendingDirectCall(io, threadId);
      io.to(`dm:${threadId}`).emit("dm:call:end", { threadId, fromUserId: socket.user.userId, endedAt: Date.now() });
      ack?.({ ok: true });
    });

    socket.on("dm:call:camera-state", ({ threadId, enabled }, ack) => {
      if (!threadId || !isDirectThreadMember(threadId, socket.user.userId)) {
        return ack?.({ ok: false });
      }
      socket.to(`dm:${threadId}`).emit("dm:call:camera-state", { threadId, fromUserId: socket.user.userId, enabled: Boolean(enabled) });
      ack?.({ ok: true });
    });
    socket.on("live:broadcasts:get", (ack) => {
      const broadcasts = Array.from(liveBroadcasts.values())
        .map(serializeBroadcast)
        .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
      socket.emit("live:broadcasts", { broadcasts });
      ack?.({ ok: true, broadcasts });
    });

    socket.on("live:broadcast:create", (payload, ack) => {
      const finish = async () => {
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
        comments: [{ id: `sys-${Date.now()}`, author: "System", text: "Broadcast started.", ts: Date.now() }],
        speakers: [
          {
            id: `host-${socket.user.userId}`,
            userId: String(socket.user.userId),
            name: String(payload?.host || "Host"),
            photo: payload?.hostPhoto || "",
            role: "Host",
            muted: false,
          },
          null,
          null,
          null,
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

    socket.on("live:broadcast:join", ({ broadcastId, name, photo }, ack) => {
      const finish = async () => {
      const room = liveBroadcasts.get(broadcastId);
      if (!room) return ack?.({ ok: false, message: "not found" });
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

    socket.on("live:broadcast:leave", ({ broadcastId }, ack) => {
      const room = liveBroadcasts.get(broadcastId);
      socket.leave(`live:${broadcastId}`);
      socket.data.liveBroadcastId = null;
      socket.data.liveBroadcastRole = null;
      if (!room) return ack?.({ ok: true });
      const userId = String(socket.user.userId);
      if (room.hostUserId === userId) {
        io.to(`live:${broadcastId}`).emit("live:broadcast:ended", { broadcastId, reason: "host_left" });
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

    socket.on("live:comment", ({ broadcastId, text, author, userId, photo }, ack) => {
      const room = liveBroadcasts.get(broadcastId);
      const clean = String(text || "").trim().slice(0, 220);
      if (!room || !clean) return ack?.({ ok: false });
      const comment = { id: `${Date.now()}-${Math.random().toString(16).slice(2,6)}`, author: String(author || "User"), userId: String(userId || socket.user.userId || ""), photo: photo || "", text: clean, ts: Date.now() };
      room.comments.push(comment);
      bumpLiveRoomVersion(room);
      io.to(`live:${broadcastId}`).emit("live:comment", { broadcastId, comment });
      emitLiveRoom(io, broadcastId);
      ack?.({ ok: true, comment });
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
      const mediaSession = await buildLiveMediaSession({
        room,
        userId: socket.user.userId,
        participantName: resolveLiveParticipantName(room, socket.user.userId),
        canPublish: canPublishLiveAudio(room, socket.user.userId),
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

    socket.on("disconnect", () => {
      removeFromQueue(socket.id);
      removePresenceWatcher(socket.id);
      liveUserSockets.delete(String(socket.user.userId));
      emitPresence(io, socket.user.userId, false);
      if (socket.data.liveBroadcastId) {
        const broadcastId = socket.data.liveBroadcastId;
        const room = liveBroadcasts.get(broadcastId);
        if (room) {
          const userId = String(socket.user.userId);
          if (room.hostUserId === userId) {
            io.to(`live:${broadcastId}`).emit("live:broadcast:ended", { broadcastId, reason: "host_left" });
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
        io.to(`dm:${threadId}`).emit("dm:call:end", { threadId, fromUserId: socket.user.userId, endedAt: Date.now(), reason: "disconnect" });
        socket.data.directCallThreadId = null;
      }
      if (socket.data.matchId) {
        leaveMatch(io, socket, socket.data.matchId, "disconnect");
        socket.data.matchId = null;
      }
    });
  });

  return io;
}

function attemptMatch(io) {
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
        io.to(matchId).emit("match:ended", { matchId, reason: "time" });
        sa.leave(matchId);
        sb.leave(matchId);
        sa.data.matchId = null;
        sb.data.matchId = null;
        activeMatches.delete(matchId);
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

      sa.emit("match:found", { matchId, partnerId: b.userId, endsAt });
      sb.emit("match:found", { matchId, partnerId: a.userId, endsAt });

      return;
    }
  }

  return io;
}
