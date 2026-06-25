import express from "express";
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
app.use(express.json());
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
const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID || "";
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET || "";
const STRAVA_REDIRECT_URI = process.env.STRAVA_REDIRECT_URI || "";
const STRAVA_SYNC_AFTER_DATE = process.env.STRAVA_SYNC_AFTER_DATE || "2026-06-01";
const STRAVA_CONNECTION_ID = 1;
const STRAVA_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities";
const STRAVA_ALLOWED_TYPES = new Set(["Run", "Ride"]);
let syncInFlight = false;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: { transport: ws }
});

function asNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function mapLogRow(r) {
  return {
    id: r.id,
    category: r.category || "",
    item: r.item || "",
    weight: asNumber(r.weight, 0),
    reps: asNumber(r.reps, 0),
    gear: r.gear || "",
    score: asNumber(r.score, 0),
    created_at: r.created_at || "",
    source: r.source || "manual",
    duration_seconds: r.duration_seconds == null ? null : asNumber(r.duration_seconds, 0)
  };
}

function hasStravaConfig() {
  return Boolean(STRAVA_CLIENT_ID && STRAVA_CLIENT_SECRET && STRAVA_REDIRECT_URI);
}

function getBaseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  return `${proto}://${req.get("host")}`;
}

function formatTokyoDate(dateLike) {
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

function toMinutes(seconds) {
  return Math.round(asNumber(seconds, 0) / 60);
}

function mapStravaTypeToItem(type) {
  if (type === "Run") return "ラン";
  if (type === "Ride") return "バイク";
  return "";
}

function stravaStatusCode(error) {
  if (error?.status) return error.status;
  if (error?.cause?.status) return error.cause.status;
  return 500;
}

function isSchemaError(error) {
  const message = String(error?.message || "");
  const code = String(error?.code || "");
  return code === "PGRST204" || code === "42P01" || message.includes("column") || message.includes("relation");
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

async function getStravaConnection() {
  const { data, error } = await supabase
    .from("strava_connection")
    .select("id, athlete_id, access_token, refresh_token, token_expires_at, scope, last_sync_at, last_sync_status, last_sync_error, created_at, updated_at")
    .eq("id", STRAVA_CONNECTION_ID)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function getStravaConnectionSafe() {
  try {
    return {
      connection: await getStravaConnection(),
      setupRequired: false
    };
  } catch (error) {
    if (isSchemaError(error)) {
      return {
        connection: null,
        setupRequired: true
      };
    }
    throw error;
  }
}

async function saveStravaConnection(connection) {
  const payload = {
    id: STRAVA_CONNECTION_ID,
    athlete_id: connection.athlete_id,
    access_token: connection.access_token,
    refresh_token: connection.refresh_token,
    token_expires_at: connection.token_expires_at,
    scope: connection.scope || null,
    last_sync_at: connection.last_sync_at || null,
    last_sync_status: connection.last_sync_status || null,
    last_sync_error: connection.last_sync_error || null,
    created_at: connection.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase.from("strava_connection").upsert(payload, { onConflict: "id" });
  if (error) throw error;
}

async function updateStravaSyncStatus(status, errorMessage = null) {
  const current = await getStravaConnection();
  if (!current) return;

  await saveStravaConnection({
    ...current,
    last_sync_at: new Date().toISOString(),
    last_sync_status: status,
    last_sync_error: errorMessage
  });
}

async function exchangeStravaCode(code) {
  return fetchJson(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code"
    })
  });
}

async function refreshStravaAccessToken(refreshToken) {
  return fetchJson(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
}

async function ensureStravaAccessToken() {
  const connection = await getStravaConnection();
  if (!connection) {
    const err = new Error("Strava is not connected");
    err.status = 400;
    throw err;
  }

  const expiryMs = new Date(connection.token_expires_at).getTime();
  const shouldRefresh = !Number.isFinite(expiryMs) || expiryMs - Date.now() <= 5 * 60 * 1000;

  if (!shouldRefresh) {
    return connection;
  }

  const refreshed = await refreshStravaAccessToken(connection.refresh_token);
  const nextConnection = {
    ...connection,
    athlete_id: refreshed.athlete?.id || connection.athlete_id,
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token,
    token_expires_at: new Date(refreshed.expires_at * 1000).toISOString(),
    scope: refreshed.scope || connection.scope
  };

  await saveStravaConnection(nextConnection);
  return nextConnection;
}

async function listStravaActivities(accessToken) {
  const activities = [];
  let page = 1;

  while (true) {
    const url = new URL(STRAVA_ACTIVITIES_URL);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "200");
    url.searchParams.set("after", String(Math.floor(new Date(`${STRAVA_SYNC_AFTER_DATE}T00:00:00Z`).getTime() / 1000)));

    const pageData = await fetchJson(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!Array.isArray(pageData) || pageData.length === 0) break;
    activities.push(...pageData);
    if (pageData.length < 200) break;
    page += 1;
  }

  return activities.filter((activity) => {
    if (!STRAVA_ALLOWED_TYPES.has(activity?.type)) return false;
    const localDate = String(activity?.start_date_local || activity?.start_date || "").slice(0, 10);
    return localDate >= STRAVA_SYNC_AFTER_DATE;
  });
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
  gearDistanceDelta = null,
  source = "manual",
  sourceActivityId = null,
  durationSeconds = null
}) {
  const coef = await getCoefficient("Training", item, date);
  const score = Math.round(asNumber(reps, 0) * coef);
  const normalizedGear = gear || "";

  if (normalizedGear && gearDistanceDelta != null) {
    await incrementGearDistanceIfNeeded(normalizedGear, asNumber(gearDistanceDelta, 0), date);
  }

  const inserted = await supabase.from("log").insert({
    category: "Training",
    item,
    weight: 0,
    reps: asNumber(reps, 0),
    gear: normalizedGear,
    score,
    created_at: date,
    source,
    source_activity_id: sourceActivityId,
    duration_seconds: durationSeconds
  }).select("id, score").single();

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

async function syncStravaActivities() {
  if (syncInFlight) {
    const err = new Error("Strava sync is already running");
    err.status = 409;
    throw err;
  }

  syncInFlight = true;

  try {
    const connection = await ensureStravaAccessToken();
    const activities = await listStravaActivities(connection.access_token);
    let insertedCount = 0;

    for (const activity of activities) {
      const sourceActivityId = String(activity.id || "");
      if (!sourceActivityId) continue;

      const existing = await supabase
        .from("log")
        .select("id")
        .eq("source", "strava")
        .eq("source_activity_id", sourceActivityId)
        .maybeSingle();

      if (existing.error) throw existing.error;
      if (existing.data) continue;

      const item = mapStravaTypeToItem(activity.type);
      if (!item) continue;

      const date = String(activity.start_date_local || activity.start_date || "").slice(0, 10) || formatTokyoDate(new Date());
      const distanceKm = Math.round((asNumber(activity.distance, 0) / 1000) * 100) / 100;
      const durationSeconds = asNumber(activity.elapsed_time, 0);
      const reps = item === "ラン" ? distanceKm : toMinutes(durationSeconds);

      await insertTrainingLog({
        date,
        item,
        reps,
        gear: "",
        source: "strava",
        sourceActivityId,
        durationSeconds
      });
      insertedCount += 1;
    }

    await updateStravaSyncStatus("success", null);
    return { fetchedCount: activities.length, insertedCount };
  } catch (error) {
    await updateStravaSyncStatus("error", error.message);
    throw error;
  } finally {
    syncInFlight = false;
  }
}

function stravaStatusPayload(connection) {
  return {
    configured: hasStravaConfig(),
    connected: Boolean(connection),
    setup_required: false,
    athlete_id: connection?.athlete_id || null,
    scope: connection?.scope || null,
    token_expires_at: connection?.token_expires_at || null,
    last_sync_at: connection?.last_sync_at || null,
    last_sync_status: connection?.last_sync_status || null,
    last_sync_error: connection?.last_sync_error || null,
    sync_after_date: STRAVA_SYNC_AFTER_DATE
  };
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
      .select("id, category, item, weight, reps, gear, score, created_at, source, duration_seconds")
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
    const { date, category, item, customItem, weight, reps, gear } = req.body;
    if (!date || !category || !item) {
      return res.status(400).json({ error: "date, category, item is required" });
    }

    const finalItem = item === "その他(自由入力)" ? String(customItem || "").trim() : item;
    if (!finalItem) return res.status(400).json({ error: "item is empty" });

    const repsNum = asNumber(reps, 0);
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
          gearDistanceDelta: repsNum,
          source: "manual",
          sourceActivityId: null,
          durationSeconds: null
        });
        return res.json({ id: inserted.id, score: inserted.score });
      } else {
        logWeight = weightNum;
        logGear = "";
        score = Math.round(repsNum * coef * weightNum);
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

app.get("/api/strava/status", async (req, res) => {
  try {
    const { connection, setupRequired } = await getStravaConnectionSafe();
    const payload = stravaStatusPayload(connection);
    payload.setup_required = setupRequired;
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/api/strava/connect", async (req, res) => {
  if (!hasStravaConfig()) {
    return res.status(500).send("Strava environment variables are missing");
  }

  const authorizeUrl = new URL(STRAVA_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", STRAVA_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", STRAVA_REDIRECT_URI);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("approval_prompt", "auto");
  authorizeUrl.searchParams.set("scope", "read,activity:read_all");
  return res.redirect(authorizeUrl.toString());
});

app.get("/api/strava/callback", async (req, res) => {
  const code = String(req.query.code || "");
  const error = String(req.query.error || "");

  if (error) {
    return res.status(400).send(`Strava authorization failed: ${error}`);
  }
  if (!code) {
    return res.status(400).send("Missing Strava authorization code");
  }

  try {
    const tokenData = await exchangeStravaCode(code);
    await saveStravaConnection({
      id: STRAVA_CONNECTION_ID,
      athlete_id: tokenData.athlete?.id,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      token_expires_at: new Date(tokenData.expires_at * 1000).toISOString(),
      scope: tokenData.scope || null,
      last_sync_at: null,
      last_sync_status: null,
      last_sync_error: null
    });

    const redirectUrl = new URL("/strava.html", getBaseUrl(req));
    redirectUrl.searchParams.set("connected", "1");
    return res.redirect(redirectUrl.toString());
  } catch (e) {
    return res.status(stravaStatusCode(e)).send(`Failed to connect Strava: ${e.message}`);
  }
});

async function handleStravaSync(req, res) {
  try {
    const result = await syncStravaActivities();
    return res.json({
      ok: true,
      fetchedCount: result.fetchedCount,
      insertedCount: result.insertedCount
    });
  } catch (e) {
    return res.status(stravaStatusCode(e)).json({ error: e.message });
  }
}

app.get("/api/strava/sync", handleStravaSync);
app.post("/api/strava/sync", handleStravaSync);

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

const isVercel = process.env.VERCEL === "1";

if (!isVercel) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
    console.log(`Supabase key source: ${KEY_SOURCE}`);
  });
}

export default app;
