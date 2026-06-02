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
    created_at: r.created_at || ""
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
    const { data, error } = await supabase
      .from("log")
      .select("id, category, item, weight, reps, gear, score, created_at")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const logs = (data || []).map(mapLogRow);

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
        logWeight = 0;
        logGear = gear || "";
        score = Math.round(repsNum * coef);

        if (logGear) {
          const current = await supabase.from("gear").select("id, distance").eq("name", logGear).maybeSingle();
          if (current.error) return res.status(500).json({ error: current.error.message });

          if (current.data) {
            const currentDistance = asNumber(current.data.distance, 0);
            const up = await supabase
              .from("gear")
              .update({ distance: currentDistance + repsNum })
              .eq("name", logGear);
            if (up.error) return res.status(500).json({ error: up.error.message });
          } else {
            const ins = await supabase.from("gear").insert({
              name: logGear,
              status: 1,
              distance: repsNum,
              start_date: date,
              end_date: null
            });
            if (ins.error) return res.status(500).json({ error: ins.error.message });
          }
        }
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
      created_at: date
    }).select("id").single();

    if (inserted.error) return res.status(500).json({ error: inserted.error.message });
    return res.json({ id: inserted.data.id, score });
  } catch (e) {
    return res.status(500).json({ error: e.message });
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`Supabase key source: ${KEY_SOURCE}`);
});
