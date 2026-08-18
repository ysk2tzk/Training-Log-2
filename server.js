import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.join(__dirname, ".env");

if (fs.existsSync(envPath)) {
  const envText = fs.readFileSync(envPath, "utf8");
  for (const rawLine of envText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));
app.use(express.urlencoded({
  extended: false,
  verify: (req, res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));
app.use(express.static(path.join(__dirname, "public")));

const SUPABASE_URL = process.env.SUPABASE_URL || "https://tqhvurtivvibqbmrtkdb.supabase.co";
const KEY_SOURCE = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? "service_role"
  : process.env.SUPABASE_ANON_KEY
    ? "anon"
    : "fallback_publishable";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "sb_publishable_W6fi9Pmqp1CAtj-f9dRjEQ_NDAxoEE3";
const SUUNTO_CLIENT_ID = process.env.SUUNTO_CLIENT_ID || "";
const SUUNTO_CLIENT_SECRET = process.env.SUUNTO_CLIENT_SECRET || "";
const SUUNTO_REDIRECT_URI = process.env.SUUNTO_REDIRECT_URI || "";
const SUUNTO_SCOPE = process.env.SUUNTO_SCOPE || "workout";
const SUUNTO_SUBSCRIPTION_KEY = process.env.SUUNTO_SUBSCRIPTION_KEY || "";
const SUUNTO_ACCESS_TOKEN = process.env.SUUNTO_ACCESS_TOKEN || "";
const SUUNTO_REFRESH_TOKEN = process.env.SUUNTO_REFRESH_TOKEN || "";
const SUUNTO_WORKOUTS_URL = "https://cloudapi.suunto.com/v2/workouts";
const SUUNTO_AUTHORIZE_URL = "https://cloudapi-oauth.suunto.com/oauth/authorize";
const SUUNTO_TOKEN_URL = "https://cloudapi-oauth.suunto.com/oauth/token";
const SUUNTO_LOG_SOURCE = "suunto";
const SUUNTO_WEBHOOK_SECRET = process.env.SUUNTO_WEBHOOK_SECRET || "";
const SUUNTO_CONNECTION_ID = 1;
const isVercel = process.env.VERCEL === "1";
let suuntoImportInFlight = false;
let suuntoConnection = SUUNTO_ACCESS_TOKEN
  ? {
      access_token: SUUNTO_ACCESS_TOKEN,
      refresh_token: SUUNTO_REFRESH_TOKEN || null,
      token_type: "bearer",
      expires_at: null,
      scope: SUUNTO_SCOPE,
      user: null,
      connected_at: new Date().toISOString(),
      source: "env"
    }
  : null;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { transport: ws }
});

function asNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isBlank(value) {
  return value == null || String(value).trim() === "";
}

function mapLogRow(r) {
  return {
    id: r.id,
    category: r.category || "",
    item: r.item || "",
    weight: asNumber(r.weight, 0),
    reps: asNumber(r.reps, 0),
    gear: r.gear || "",
    remarks: r.remarks || "",
    score: asNumber(r.score, 0),
    created_at: r.created_at || "",
    source: r.source || "manual",
    duration_seconds: r.duration_seconds == null ? null : asNumber(r.duration_seconds, 0)
  };
}

function hasSuuntoConfig() {
  return Boolean(SUUNTO_SUBSCRIPTION_KEY && SUUNTO_ACCESS_TOKEN);
}

function hasSuuntoOAuthConfig() {
  return Boolean(SUUNTO_CLIENT_ID && SUUNTO_CLIENT_SECRET && SUUNTO_REDIRECT_URI && SUUNTO_SUBSCRIPTION_KEY);
}

function hasSuuntoWebhookConfig() {
  return Boolean(SUUNTO_WEBHOOK_SECRET);
}

function buildEnvSuuntoConnection() {
  return SUUNTO_ACCESS_TOKEN
    ? {
        access_token: SUUNTO_ACCESS_TOKEN,
        refresh_token: SUUNTO_REFRESH_TOKEN || null,
        token_type: "bearer",
        expires_at: null,
        scope: SUUNTO_SCOPE,
        user: null,
        connected_at: new Date().toISOString(),
        source: "env"
      }
    : null;
}

function getBaseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  return `${proto}://${req.get("host")}`;
}

function statusCodeFromError(error) {
  if (error?.status) return error.status;
  if (error?.cause?.status) return error.cause.status;
  return 500;
}

function isSchemaError(error) {
  const message = String(error?.message || "");
  const code = String(error?.code || "");
  return code === "PGRST204" || code === "42P01" || message.includes("column") || message.includes("relation");
}

function isLogSourceConstraintError(error) {
  const message = String(error?.message || "");
  return message.includes("log_source_chk");
}

function decodeJwtPayload(token) {
  const raw = String(token || "");
  const parts = raw.split(".");
  if (parts.length < 2) return null;

  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    return JSON.parse(Buffer.from(normalized + padding, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function safeEqualHex(left, right) {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifySuuntoWebhookSignature(req) {
  if (!hasSuuntoWebhookConfig()) {
    const err = new Error("Suunto webhook secret is missing");
    err.status = 500;
    throw err;
  }

  const signature = String(req.headers["x-hmac-sha256-signature"] || "").trim();
  if (!signature) {
    const err = new Error("Missing Suunto webhook signature");
    err.status = 401;
    throw err;
  }

  const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from("", "utf8");
  const expected = crypto
    .createHmac("sha256", SUUNTO_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  if (!safeEqualHex(signature, expected)) {
    const err = new Error("Invalid Suunto webhook signature");
    err.status = 401;
    throw err;
  }
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  let payload = null;

  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const err = new Error(payload?.message || `Request failed with ${response.status}`);
    err.status = response.status;
    err.payload = payload;
    throw err;
  }

  return payload;
}

async function loadSuuntoConnectionFromStore() {
  const stored = await supabase
    .from("suunto_connection")
    .select("id, access_token, refresh_token, token_type, expires_at, scope, user_name, connected_at, source")
    .eq("id", SUUNTO_CONNECTION_ID)
    .maybeSingle();

  if (stored.error) {
    if (isSchemaError(stored.error)) return null;
    throw stored.error;
  }
  if (!stored.data?.access_token) return null;

  return {
    access_token: stored.data.access_token,
    refresh_token: stored.data.refresh_token || null,
    token_type: stored.data.token_type || "bearer",
    expires_at: stored.data.expires_at || null,
    scope: stored.data.scope || SUUNTO_SCOPE,
    user: stored.data.user_name || null,
    connected_at: stored.data.connected_at || null,
    source: stored.data.source || "oauth"
  };
}

async function persistSuuntoConnection(connection) {
  const payload = {
    id: SUUNTO_CONNECTION_ID,
    access_token: connection?.access_token || "",
    refresh_token: connection?.refresh_token || null,
    token_type: connection?.token_type || "bearer",
    expires_at: connection?.expires_at || null,
    scope: connection?.scope || SUUNTO_SCOPE,
    user_name: connection?.user || null,
    connected_at: connection?.connected_at || new Date().toISOString(),
    source: connection?.source || "oauth"
  };

  const saved = await supabase.from("suunto_connection").upsert(payload, { onConflict: "id" });
  if (saved.error) {
    if (isSchemaError(saved.error)) return false;
    throw saved.error;
  }
  return true;
}

async function getSuuntoConnection() {
  if (suuntoConnection?.access_token) return suuntoConnection;

  const storedConnection = await loadSuuntoConnectionFromStore();
  if (storedConnection?.access_token) {
    suuntoConnection = storedConnection;
    return suuntoConnection;
  }

  suuntoConnection = buildEnvSuuntoConnection();
  return suuntoConnection;
}

function suuntoStatusPayload(connection = null) {
  const currentConnection = connection || suuntoConnection || buildEnvSuuntoConnection();
  return {
    configured: hasSuuntoOAuthConfig(),
    oauth_env_debug: {
      client_id: Boolean(SUUNTO_CLIENT_ID),
      client_secret: Boolean(SUUNTO_CLIENT_SECRET),
      redirect_uri: Boolean(SUUNTO_REDIRECT_URI),
      subscription_key: Boolean(SUUNTO_SUBSCRIPTION_KEY)
    },
    webhook_configured: hasSuuntoWebhookConfig(),
    connected: Boolean(currentConnection?.access_token),
    subscription_key_configured: Boolean(SUUNTO_SUBSCRIPTION_KEY),
    redirect_uri: SUUNTO_REDIRECT_URI || null,
    scope: currentConnection?.scope || null,
    user: currentConnection?.user || null,
    token_expires_at: currentConnection?.expires_at || null,
    connected_at: currentConnection?.connected_at || null,
    source: currentConnection?.source || (SUUNTO_ACCESS_TOKEN ? "env" : null)
  };
}

async function incrementGearDistanceIfNeeded(gearName, distanceKm, date) {
  const trimmed = String(gearName || "").trim();
  if (!trimmed) return;

  const current = await supabase.from("gear").select("id, distance").eq("name", trimmed).maybeSingle();
  if (current.error) throw current.error;

  if (current.data) {
    const updated = await supabase
      .from("gear")
      .update({ distance: asNumber(current.data.distance, 0) + distanceKm })
      .eq("name", trimmed);
    if (updated.error) throw updated.error;
    return;
  }

  const inserted = await supabase.from("gear").insert({
    name: trimmed,
    status: 1,
    distance: distanceKm,
    start_date: date,
    end_date: null
  });
  if (inserted.error) throw inserted.error;
}

async function insertTrainingLog({
  date,
  item,
  reps,
  gear,
  remarks = "",
  gearDistanceDelta = null,
  source = "manual",
  sourceActivityId = null,
  durationSeconds = null
}) {
  const coef = await getCoefficient("Training", item, date);
  const score = Math.round(asNumber(reps, 0) * coef);
  const normalizedGear = gear == null ? null : gear || "";

  if (normalizedGear && gearDistanceDelta != null) {
    await incrementGearDistanceIfNeeded(normalizedGear, asNumber(gearDistanceDelta, 0), date);
  }

  const inserted = await supabase.from("log").insert({
    category: "Training",
    item,
    weight: 0,
    reps: asNumber(reps, 0),
    gear: normalizedGear,
    remarks,
    score,
    created_at: date,
    source,
    source_activity_id: sourceActivityId,
    duration_seconds: durationSeconds
  }).select("id, score").single();

  if (inserted.error && isLogSourceConstraintError(inserted.error)) {
    const retryWithManualSource = await supabase.from("log").insert({
      category: "Training",
      item,
      weight: 0,
      reps: asNumber(reps, 0),
      gear: normalizedGear,
      remarks,
      score,
      created_at: date,
      source: "manual",
      source_activity_id: sourceActivityId,
      duration_seconds: durationSeconds
    }).select("id, score").single();

    if (retryWithManualSource.error && isSchemaError(retryWithManualSource.error)) {
      const legacyInsert = await supabase.from("log").insert({
        category: "Training",
        item,
        weight: 0,
        reps: asNumber(reps, 0),
        gear: normalizedGear,
        score,
        created_at: date
      }).select("id, score").single();

      if (legacyInsert.error) throw legacyInsert.error;
      return legacyInsert.data;
    }
    if (retryWithManualSource.error) throw retryWithManualSource.error;
    return retryWithManualSource.data;
  }

  if (inserted.error && isSchemaError(inserted.error) && source === "manual") {
    const legacyInsert = await supabase.from("log").insert({
      category: "Training",
      item,
      weight: 0,
      reps: asNumber(reps, 0),
      gear: normalizedGear,
      score,
      created_at: date
    }).select("id, score").single();

    if (legacyInsert.error) throw legacyInsert.error;
    return legacyInsert.data;
  }
  if (inserted.error) throw inserted.error;
  return inserted.data;
}

async function listSuuntoWorkouts({ accessToken, subscriptionKey }) {
  return fetchJson(SUUNTO_WORKOUTS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Ocp-Apim-Subscription-Key": subscriptionKey
    }
  });
}

async function getSuuntoWorkoutById({ accessToken, subscriptionKey, workoutId }) {
  const normalizedWorkoutId = String(workoutId || "").trim();
  if (!normalizedWorkoutId) {
    const err = new Error("Suunto workout id is missing");
    err.status = 400;
    throw err;
  }

  const workoutsResponse = await listSuuntoWorkouts({ accessToken, subscriptionKey });
  const workouts = normalizeSuuntoWorkoutList(workoutsResponse);
  return workouts.find((workout) => pickSuuntoWorkoutId(workout) === normalizedWorkoutId) || null;
}

function normalizeSuuntoWorkoutList(workoutsResponse) {
  if (Array.isArray(workoutsResponse)) return workoutsResponse;
  if (Array.isArray(workoutsResponse?.payload)) return workoutsResponse.payload;
  if (Array.isArray(workoutsResponse?.workouts)) return workoutsResponse.workouts;
  return [];
}

function pickSuuntoWorkoutId(workout) {
  if (!workout || typeof workout !== "object") return null;

  const candidates = [
    workout.workoutKey,
    workout.id,
    workout.workoutId,
    workout.workout_id,
    workout.activityId,
    workout.activity_id,
    workout.moveId,
    workout.move_id
  ];

  for (const candidate of candidates) {
    if (candidate == null) continue;
    const normalized = String(candidate).trim();
    if (normalized) return normalized;
  }

  return null;
}

function pickSuuntoWorkoutTime(workout) {
  if (!workout || typeof workout !== "object") return 0;

  const candidates = [
    workout.startTime,
    workout.start_time,
    workout.startDateTime,
    workout.start_date_time,
    workout.dateTime,
    workout.localStartTime,
    workout.createdAt,
    workout.created_at
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const time = new Date(candidate).getTime();
    if (Number.isFinite(time)) return time;
  }

  return 0;
}

function toTokyoDate(dateLike) {
  const date = new Date(dateLike);
  if (Number.isNaN(date.getTime())) return "";

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(date);
}

function pickSuuntoWorkoutDate(workout) {
  const startTime = Number(
    workout?.startTime ??
    workout?.start_time ??
    workout?.startDateTime ??
    workout?.start_date_time ??
    0
  );
  const offsetMinutes = Number(
    workout?.timeOffsetInMinutes ??
    workout?.time_offset_in_minutes ??
    0
  );

  if (Number.isFinite(startTime) && startTime > 0) {
    return toTokyoDate(startTime + offsetMinutes * 60 * 1000);
  }

  const fallback = workout?.start_time || workout?.startTime || workout?.dateTime || workout?.createdAt || workout?.created_at;
  return toTokyoDate(fallback) || new Date().toISOString().slice(0, 10);
}

function pickSuuntoDurationSeconds(workout) {
  const candidates = [
    workout?.totalTime,
    workout?.total_time,
    workout?.duration,
    workout?.durationSeconds,
    workout?.duration_seconds
  ];

  for (const candidate of candidates) {
    const normalized = Number(candidate);
    if (Number.isFinite(normalized) && normalized >= 0) {
      return Math.round(normalized);
    }
  }

  return null;
}

function pickSuuntoDistanceKm(workout) {
  const candidates = [
    workout?.totalDistance,
    workout?.total_distance,
    workout?.distance
  ];

  for (const candidate of candidates) {
    const normalized = Number(candidate);
    if (Number.isFinite(normalized) && normalized >= 0) {
      return Math.round((normalized / 1000) * 100) / 100;
    }
  }

  return null;
}

function buildSuuntoRemarks(workout) {
  const parts = [];
  const avgHr = Number(workout?.hrdata?.workoutAvgHR ?? workout?.avgHeartRate ?? workout?.avg_heart_rate);
  const maxHr = Number(workout?.hrdata?.workoutMaxHR ?? workout?.maxHeartRate ?? workout?.max_heart_rate);
  const calories = Number(workout?.energyConsumption ?? workout?.totalCalories ?? workout?.total_calories);

  if (Number.isFinite(avgHr) && avgHr > 0) parts.push(`avgHR:${avgHr}`);
  if (Number.isFinite(maxHr) && maxHr > 0) parts.push(`maxHR:${maxHr}`);
  if (Number.isFinite(calories) && calories > 0) parts.push(`kcal:${Math.round(calories)}`);

  const description = String(workout?.description || "").trim();
  if (description) parts.push(description);

  return parts.join(" / ");
}

function convertSuuntoWorkoutToLog(workout) {
  const sourceActivityId = pickSuuntoWorkoutId(workout);
  if (!sourceActivityId) {
    return { ok: false, reason: "workout id が見つかりません" };
  }

  const activityId = Number(workout?.activityId ?? workout?.activity_id);
  const date = pickSuuntoWorkoutDate(workout);
  const durationSeconds = pickSuuntoDurationSeconds(workout);
  const distanceKm = pickSuuntoDistanceKm(workout);
  const remarks = buildSuuntoRemarks(workout);

  if (activityId === 1 || activityId === 22) {
    if (!(Number.isFinite(distanceKm) && distanceKm > 0)) {
      return { ok: false, reason: "ランの距離が取得できません", sourceActivityId };
    }

    return {
      ok: true,
      payload: {
        date,
        item: "ラン",
        reps: distanceKm,
        gear: null,
        remarks,
        source: SUUNTO_LOG_SOURCE,
        sourceActivityId,
        durationSeconds
      }
    };
  }

  if (activityId === 2 || activityId === 52) {
    if (!(Number.isFinite(durationSeconds) && durationSeconds > 0)) {
      return { ok: false, reason: "バイクの時間が取得できません", sourceActivityId };
    }

    return {
      ok: true,
      payload: {
        date,
        item: "バイク",
        reps: durationSeconds / 60,
        gear: null,
        remarks,
        source: SUUNTO_LOG_SOURCE,
        sourceActivityId,
        durationSeconds
      }
    };
  }

  if (activityId === 53) {
    if (!(Number.isFinite(distanceKm) && distanceKm > 0)) {
      return { ok: false, reason: "トレッドミルの距離が取得できません", sourceActivityId };
    }

    return {
      ok: true,
      payload: {
        date,
        item: "トレッドミル",
        reps: distanceKm,
        gear: null,
        remarks,
        source: SUUNTO_LOG_SOURCE,
        sourceActivityId,
        durationSeconds
      }
    };
  }

  return {
    ok: false,
    reason: `対応外の種目です (activityId: ${String(workout?.activityId ?? workout?.activity_id ?? "unknown")})`,
    sourceActivityId
  };
}

async function listImportedSuuntoActivityIds() {
  const imported = await supabase
    .from("log")
    .select("source_activity_id")
    .not("source_activity_id", "is", null);

  if (imported.error) {
    if (isSchemaError(imported.error)) return new Set();
    throw imported.error;
  }

  return new Set(
    (imported.data || [])
      .map((row) => String(row.source_activity_id || "").trim())
      .filter(Boolean)
  );
}

async function exchangeSuuntoCode(code) {
  const basicAuth = Buffer.from(`${SUUNTO_CLIENT_ID}:${SUUNTO_CLIENT_SECRET}`, "utf8").toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    redirect_uri: SUUNTO_REDIRECT_URI,
    code
  });

  return fetchJson(SUUNTO_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });
}

async function refreshSuuntoAccessToken(refreshToken) {
  const basicAuth = Buffer.from(`${SUUNTO_CLIENT_ID}:${SUUNTO_CLIENT_SECRET}`, "utf8").toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: String(refreshToken || "")
  });

  return fetchJson(SUUNTO_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });
}

async function saveSuuntoConnection(tokenData, source = "oauth", fallbackConnection = null) {
  const payload = decodeJwtPayload(tokenData?.access_token);
  const expiresInSeconds = Number(tokenData?.expires_in);
  suuntoConnection = {
    access_token: tokenData?.access_token || "",
    refresh_token: tokenData?.refresh_token || fallbackConnection?.refresh_token || null,
    token_type: tokenData?.token_type || "bearer",
    expires_at: Number.isFinite(expiresInSeconds) ? new Date(Date.now() + expiresInSeconds * 1000).toISOString() : null,
    scope: tokenData?.scope || SUUNTO_SCOPE,
    user: payload?.user || fallbackConnection?.user || null,
    connected_at: new Date().toISOString(),
    source
  };
  await persistSuuntoConnection(suuntoConnection);
  return suuntoConnection;
}

async function ensureSuuntoAccessToken() {
  const connection = await getSuuntoConnection();
  if (!connection?.access_token) return null;

  const expiryMs = new Date(connection.expires_at || "").getTime();
  const shouldRefresh = Number.isFinite(expiryMs) && expiryMs - Date.now() <= 5 * 60 * 1000;

  if (!shouldRefresh) {
    return connection;
  }
  if (!connection.refresh_token) {
    return connection;
  }

  const refreshed = await refreshSuuntoAccessToken(connection.refresh_token);
  return saveSuuntoConnection(refreshed, "oauth", connection);
}

async function importSingleSuuntoWorkout(workout) {
  const sourceActivityId = pickSuuntoWorkoutId(workout);
  if (!sourceActivityId) {
    const err = new Error("Suunto workout id is missing");
    err.status = 400;
    throw err;
  }

  const importedIds = await listImportedSuuntoActivityIds();
  if (importedIds.has(sourceActivityId)) {
    return {
      inserted: false,
      duplicate: true,
      sourceActivityId
    };
  }

  const converted = convertSuuntoWorkoutToLog(workout);
  if (!converted.ok) {
    return {
      inserted: false,
      duplicate: false,
      sourceActivityId,
      skipped: true,
      reason: converted.reason
    };
  }

  const insertedRow = await insertTrainingLog(converted.payload);
  return {
    inserted: true,
    duplicate: false,
    sourceActivityId,
    id: insertedRow.id,
    score: insertedRow.score,
    item: converted.payload.item,
    date: converted.payload.date
  };
}

async function importSuuntoWorkouts({ accessToken, subscriptionKey }) {
  if (suuntoImportInFlight) {
    const err = new Error("Suunto import is already running");
    err.status = 409;
    throw err;
  }

  suuntoImportInFlight = true;

  try {
    const workoutsResponse = await listSuuntoWorkouts({ accessToken, subscriptionKey });
    const workoutList = normalizeSuuntoWorkoutList(workoutsResponse).slice();
    const importedIds = await listImportedSuuntoActivityIds();
    const seenPendingIds = new Set();
    const pendingWorkouts = workoutList
      .filter((workout) => {
        const workoutId = pickSuuntoWorkoutId(workout);
        if (!workoutId || importedIds.has(workoutId) || seenPendingIds.has(workoutId)) {
          return false;
        }
        seenPendingIds.add(workoutId);
        return true;
      })
      .sort((a, b) => pickSuuntoWorkoutTime(a) - pickSuuntoWorkoutTime(b));

    const inserted = [];
    const skipped = [];

    for (const workout of pendingWorkouts) {
      const converted = convertSuuntoWorkoutToLog(workout);
      if (!converted.ok) {
        skipped.push({
          sourceActivityId: converted.sourceActivityId || pickSuuntoWorkoutId(workout),
          reason: converted.reason
        });
        continue;
      }

      const insertedRow = await insertTrainingLog(converted.payload);
      inserted.push({
        id: insertedRow.id,
        score: insertedRow.score,
        sourceActivityId: converted.payload.sourceActivityId,
        item: converted.payload.item,
        date: converted.payload.date
      });
    }

    return {
      fetchedCount: workoutList.length,
      pendingCount: pendingWorkouts.length,
      insertedCount: inserted.length,
      skippedCount: skipped.length,
      inserted,
      skipped
    };
  } finally {
    suuntoImportInFlight = false;
  }
}

async function getCoefficient(category, item, date) {
  const findByName = async (name, useIlike = false) => {
    let q = supabase
      .from("coefficient")
      .select("value")
      .lte("start_date", date)
      .or(`end_date.gt.${date},end_date.is.null`)
      .order("start_date", { ascending: false })
      .limit(1);

    q = useIlike ? q.ilike("name", name) : q.eq("name", name);
    return q.maybeSingle();
  };

  if (category === "Training") {
    const named = await findByName(item);

    if (named.data && named.data.value != null) {
      return asNumber(named.data.value, 1);
    }

    const fallback = await findByName("default", true);

    return fallback.data ? asNumber(fallback.data.value, 1) : 1;
  }

  const reward = await findByName("reward", true);

  return reward.data ? asNumber(reward.data.value, -1) : -1;
}

app.get("/api/options", async (req, res) => {
  try {
    const [trainingRes, rewardRes, gearRes] = await Promise.all([
      supabase.from("log").select("item").eq("category", "Training").not("item", "is", null),
      supabase.from("log").select("item").eq("category", "Reward").not("item", "is", null),
      supabase.from("gear").select("name, category").order("name", { ascending: true })
    ]);

    if (trainingRes.error || rewardRes.error || gearRes.error) {
      const error = trainingRes.error || rewardRes.error || gearRes.error;
      return res.status(500).json({ error: error.message });
    }

    const trainingItems = [...new Set((trainingRes.data || []).map((r) => r.item || "").filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));
    const rewardItems = [...new Set((rewardRes.data || []).map((r) => r.item || "").filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));
    const gears = (gearRes.data || [])
      .map((r) => ({
        name: r.name || "",
        category: r.category || ""
      }))
      .filter((g) => Boolean(g.name));

    return res.json({ trainingItems, rewardItems, gears });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/summary", async (req, res) => {
  try {
    let summaryRes = await supabase
      .from("log")
      .select("id, category, item, weight, reps, gear, remarks, score, created_at, source, duration_seconds")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    if (summaryRes.error && isSchemaError(summaryRes.error)) {
      summaryRes = await supabase
        .from("log")
        .select("id, category, item, weight, reps, gear, score, created_at")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });
    }

    if (summaryRes.error) return res.status(500).json({ error: summaryRes.error.message });

    const logs = (summaryRes.data || []).map(mapLogRow);

    const totalScore = logs.reduce((acc, r) => acc + asNumber(r.score, 0), 0);
    return res.json({ totalScore, logs });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/coefficients", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("coefficient")
      .select("id, name, value, start_date, end_date")
      .is("end_date", null)
      .order("start_date", { ascending: false })
      .order("id", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const coefficients = (data || []).map((r) => ({
      id: r.id,
      name: r.name || "",
      value: asNumber(r.value, 0),
      start_date: r.start_date || "",
      end_date: r.end_date || null
    }));
    const names = [...new Set(coefficients.map((r) => r.name).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ja"));

    return res.json({ names, coefficients });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post("/api/coefficients", async (req, res) => {
  try {
    const { name, customName, value, start_date } = req.body;
    const selectedName = String(name || "").trim();
    const finalName = selectedName === "その他(自由入力)"
      ? String(customName || "").trim()
      : selectedName;
    const startDate = String(start_date || "").slice(0, 10);
    const coefficientValue = Number(value);

    if (!finalName || !startDate) {
      return res.status(400).json({ error: "name, start_date is required" });
    }
    if (!Number.isFinite(coefficientValue)) {
      return res.status(400).json({ error: "value is required" });
    }

    if (selectedName !== "その他(自由入力)") {
      const currentRes = await supabase
        .from("coefficient")
        .select("id, start_date")
        .eq("name", finalName)
        .is("end_date", null);

      if (currentRes.error) return res.status(500).json({ error: currentRes.error.message });

      const previousDate = new Date(`${startDate}T00:00:00Z`);
      previousDate.setUTCDate(previousDate.getUTCDate() - 1);
      const endDate = previousDate.toISOString().slice(0, 10);

      for (const row of currentRes.data || []) {
        const updateRes = await supabase
          .from("coefficient")
          .update({ end_date: endDate })
          .eq("id", row.id);
        if (updateRes.error) return res.status(500).json({ error: updateRes.error.message });
      }
    }

    const maxIdRes = await supabase
      .from("coefficient")
      .select("id")
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (maxIdRes.error) return res.status(500).json({ error: maxIdRes.error.message });

    const nextId = asNumber(maxIdRes.data?.id, 0) + 1;

    const inserted = await supabase
      .from("coefficient")
      .insert({
        id: nextId,
        name: finalName,
        value: coefficientValue,
        start_date: startDate,
        end_date: null
      })
      .select("id")
      .single();

    if (inserted.error) return res.status(500).json({ error: inserted.error.message });
    return res.json({ id: inserted.data.id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post("/api/logs", async (req, res) => {
  try {
    const { date, category, item, customItem, weight, reps, gear, remarks } = req.body;
    if (!date || !category || !item) {
      return res.status(400).json({ error: "date, category, item is required" });
    }

    const finalItem = item === "その他(自由入力)" ? String(customItem || "").trim() : item;
    if (!finalItem) return res.status(400).json({ error: "item is empty" });
    const normalizedRemarks = String(remarks || "").trim();

    const repsNum = asNumber(reps, 0);
    const hasWeightInput = !isBlank(weight);
    const weightNum = asNumber(weight, 0);
    const coef = await getCoefficient(category, finalItem, date);

    let logWeight = 0;
    let logGear = "";
    let score = 0;

    if (category === "Training") {
      if (finalItem === "ラン" || finalItem === "バイク") {
        const inserted = await insertTrainingLog({
          date,
          item: finalItem,
          reps: repsNum,
          gear: gear || "",
          remarks: normalizedRemarks,
          gearDistanceDelta: repsNum,
          source: "manual",
          sourceActivityId: null,
          durationSeconds: null
        });
        return res.json({ id: inserted.id, score: inserted.score });
      } else {
        logWeight = hasWeightInput ? weightNum : 0;
        logGear = "";
        score = hasWeightInput
          ? Math.round(repsNum * coef * weightNum)
          : Math.round(repsNum * coef);
      }
    } else if (category === "Reward") {
      logWeight = 0;
      logGear = "";
      score = Math.round(repsNum * coef);
    } else {
      return res.status(400).json({ error: "invalid category" });
    }

    const inserted = await supabase.from("log").insert({
      category,
      item: finalItem,
      weight: logWeight,
      reps: repsNum,
      gear: logGear,
      remarks: normalizedRemarks,
      score,
      created_at: date,
      source: "manual",
      source_activity_id: null,
      duration_seconds: null
    }).select("id").single();

    if (inserted.error && isSchemaError(inserted.error)) {
      const legacyInserted = await supabase.from("log").insert({
        category,
        item: finalItem,
        weight: logWeight,
        reps: repsNum,
        gear: logGear,
        remarks: normalizedRemarks,
        score,
        created_at: date
      }).select("id").single();

      if (legacyInserted.error) return res.status(500).json({ error: legacyInserted.error.message });
      return res.json({ id: legacyInserted.data.id, score });
    }
    if (inserted.error) return res.status(500).json({ error: inserted.error.message });
    return res.json({ id: inserted.data.id, score });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/suunto/status", async (req, res) => {
  try {
    const connection = await getSuuntoConnection();
    return res.json(suuntoStatusPayload(connection));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/suunto/connect", async (req, res) => {
  if (!hasSuuntoOAuthConfig()) {
    return res.status(500).send("Suunto OAuth environment variables are missing");
  }

  const authorizeUrl = new URL(SUUNTO_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", SUUNTO_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", SUUNTO_REDIRECT_URI);
  authorizeUrl.searchParams.set("scope", SUUNTO_SCOPE);
  return res.redirect(authorizeUrl.toString());
});

app.get("/api/suunto/callback", async (req, res) => {
  const code = String(req.query.code || "");
  const error = String(req.query.error || "");

  if (error) {
    return res.status(400).send(`Suunto authorization failed: ${error}`);
  }
  if (!code) {
    return res.status(400).send("Missing Suunto authorization code");
  }
  if (!hasSuuntoOAuthConfig()) {
    return res.status(500).send("Suunto OAuth environment variables are missing");
  }

  try {
    const tokenData = await exchangeSuuntoCode(code);
    await saveSuuntoConnection(tokenData, "oauth");

    const redirectUrl = new URL("/suunto.html", getBaseUrl(req));
    redirectUrl.searchParams.set("connected", "1");
    return res.redirect(redirectUrl.toString());
  } catch (e) {
    return res.status(statusCodeFromError(e)).send(`Failed to connect Suunto: ${e.message}`);
  }
});

app.post("/api/suunto/workouts", async (req, res) => {
  try {
    const connection = await ensureSuuntoAccessToken();
    const connectedAccessToken = String(connection?.access_token || "");
    const accessToken = String(req.body?.accessToken || connectedAccessToken || SUUNTO_ACCESS_TOKEN || "").trim();
    const subscriptionKey = String(req.body?.subscriptionKey || SUUNTO_SUBSCRIPTION_KEY || "").trim();

    if (!accessToken || !subscriptionKey) {
      return res.status(400).json({
        error: "SuuntoのAccess TokenとSubscription Keyが必要です",
        missing: {
          accessToken: !accessToken,
          subscriptionKey: !subscriptionKey
        },
        configured: hasSuuntoConfig()
      });
    }

    const workoutsResponse = await listSuuntoWorkouts({ accessToken, subscriptionKey });
    const workouts = normalizeSuuntoWorkoutList(workoutsResponse);
    return res.json({
      count: workouts.length,
      workouts
    });
  } catch (e) {
    return res.status(statusCodeFromError(e)).json({
      error: e.message || "Suuntoのエクササイズ一覧取得に失敗しました",
      details: e.payload || null
    });
  }
});

app.post("/api/suunto/import", async (req, res) => {
  try {
    const connection = await ensureSuuntoAccessToken();
    const connectedAccessToken = String(connection?.access_token || "");
    const accessToken = String(req.body?.accessToken || connectedAccessToken || SUUNTO_ACCESS_TOKEN || "").trim();
    const subscriptionKey = String(req.body?.subscriptionKey || SUUNTO_SUBSCRIPTION_KEY || "").trim();

    if (!accessToken || !subscriptionKey) {
      return res.status(400).json({
        error: "SuuntoのAccess TokenとSubscription Keyが必要です",
        missing: {
          accessToken: !accessToken,
          subscriptionKey: !subscriptionKey
        },
        configured: hasSuuntoConfig()
      });
    }

    const result = await importSuuntoWorkouts({ accessToken, subscriptionKey });
    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(statusCodeFromError(e)).json({
      error: e.message || "Suuntoの未取得エクササイズ取り込みに失敗しました",
      details: e.payload || null
    });
  }
});

app.post("/api/suunto/webhook", async (req, res) => {
  try {
    verifySuuntoWebhookSignature(req);

    const notificationType = String(req.body?.type || "").trim();
    const username = String(req.body?.username || req.body?.user || "").trim();

    if (notificationType && notificationType !== "WORKOUT_CREATED") {
      return res.json({
        ok: true,
        ignored: true,
        type: notificationType
      });
    }

    const connection = await getSuuntoConnection();
    const connectedUser = String(connection?.user || "").trim();
    if (connectedUser && username && connectedUser !== username) {
      return res.status(409).json({
        error: "Webhook user does not match the connected Suunto user",
        username,
        connectedUser
      });
    }

    let workout = req.body?.workout || null;

    if (!workout) {
      const ensuredConnection = await ensureSuuntoAccessToken();
      const connectedAccessToken = String(ensuredConnection?.access_token || "");
      const accessToken = String(connectedAccessToken || SUUNTO_ACCESS_TOKEN || "").trim();
      const subscriptionKey = String(SUUNTO_SUBSCRIPTION_KEY || "").trim();
      const workoutId = String(req.body?.workoutid || req.body?.workoutId || "").trim();

      if (!accessToken || !subscriptionKey) {
        return res.status(400).json({
          error: "Legacy webhook requires Suunto access token and subscription key on the server"
        });
      }

      workout = await getSuuntoWorkoutById({ accessToken, subscriptionKey, workoutId });
      if (!workout) {
        return res.status(404).json({
          error: "Webhook workout was not found in Suunto workout list",
          workoutId
        });
      }
    }

    const result = await importSingleSuuntoWorkout(workout);
    return res.json({
      ok: true,
      type: notificationType || "WORKOUT_CREATED",
      username: username || null,
      ...result
    });
  } catch (e) {
    return res.status(statusCodeFromError(e)).json({
      error: e.message || "Suunto webhook handling failed"
    });
  }
});

app.get("/api/gears", async (req, res) => {
  try {
    const includeEnded = req.query.includeEnded === "1";
    let q = supabase
      .from("gear")
      .select("id, name, status, distance, start_date, end_date")
      .order("start_date", { ascending: false })
      .order("name", { ascending: true });
    if (!includeEnded) q = q.eq("status", 1);

    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ gears: data || [] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.post("/api/gears", async (req, res) => {
  try {
    const { name, start_date } = req.body;
    const n = String(name || "").trim();
    if (!n || !start_date) {
      return res.status(400).json({ error: "name, start_date is required" });
    }

    const inserted = await supabase.from("gear").insert({
      name: n,
      status: 1,
      distance: 0,
      start_date,
      end_date: null
    }).select("id").single();

    if (inserted.error) return res.status(500).json({ error: inserted.error.message });
    return res.json({ id: inserted.data.id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.patch("/api/gears/:id/end", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }
    const requestedEndDate = String(req.body?.end_date || "").slice(0, 10);
    const endDate = requestedEndDate || new Date().toISOString().slice(0, 10);

    const updated = await supabase
      .from("gear")
      .update({ status: 0, end_date: endDate })
      .eq("id", id)
      .select("id")
      .single();

    if (updated.error) return res.status(500).json({ error: updated.error.message });
    return res.json({ id: updated.data.id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.delete("/api/logs/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "invalid id" });
    }

    const deleted = await supabase.from("log").delete().eq("id", id).select("id").single();
    if (deleted.error) return res.status(500).json({ error: deleted.error.message });
    return res.json({ id: deleted.data.id });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

if (!isVercel) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
    console.log(`Supabase key source: ${KEY_SOURCE}`);
  });
}

export default app;
