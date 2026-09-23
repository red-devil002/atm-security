// reports/daily-report.js
//
// Week 7: the 24-hour reporting job. Summarises the risk-profile store
// (MongoDB "events" + "decisions") per ATM into a CSV and an HTML page.
//
//   npm run report            -> last 24 hours
//   npm run report -- 6       -> last 6 hours
//
// Runs on demand for the demo; schedule it with cron for a daily run, e.g.
//   0 7 * * * cd /path/to/atm-security && npm run report

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", "analysis-service", ".env"), quiet: true });
const { MongoClient } = require("mongodb");

const HOURS = Number(process.argv[2]) || 24;
const OUT_DIR = path.join(__dirname, "output");
const ACTIONS = ["approve_withdrawal", "approve_deposit", "notify_maintenance", "block_transaction", "lock_system"];

function riskLevel(r) {
  if (r.lock_system > 0 || r.security >= 20) return "HIGH";
  if (r.block_transaction > 0 || r.security >= 8) return "MEDIUM";
  return "LOW";
}

const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing in analysis-service/.env");
  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  const db = client.db("atm_security");
  const now = new Date();
  const since = new Date(now - HOURS * 3600 * 1000);

  // Events store timestamps as ISO strings; decisions use real Dates.
  const [events, decisions, hosts, latency] = await Promise.all([
    db.collection("events").aggregate([
      { $match: { timestamp: { $gte: since.toISOString() } } },
      { $group: { _id: { atmId: "$atmId", category: "$category", type: "$type" }, n: { $sum: 1 } } },
    ]).toArray(),
    db.collection("decisions").aggregate([
      { $match: { decidedAt: { $gte: since } } },
      { $group: { _id: { atmId: "$atmId", action: "$action" }, n: { $sum: 1 }, lat: { $avg: "$latencyMs" } } },
    ]).toArray(),
    db.collection("decisions").aggregate([
      { $match: { decidedAt: { $gte: since } } },
      { $group: { _id: "$host", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]).toArray(),
    db.collection("decisions").aggregate([
      { $match: { decidedAt: { $gte: since } } },
      { $group: { _id: null, avg: { $avg: "$latencyMs" }, max: { $max: "$latencyMs" }, n: { $sum: 1 } } },
    ]).toArray(),
  ]);
  await client.close();

  const rows = {};
  const row = (id) => (rows[id] ||= { atmId: id, security: 0, operational: 0, panel: 0, vibration: 0, motion: 0,
    decisions: 0, ...Object.fromEntries(ACTIONS.map((a) => [a, 0])) });
  for (const e of events) {
    const r = row(e._id.atmId);
    if (e._id.category === "security") { r.security += e.n; if (e._id.type in r) r[e._id.type] += e.n; }
    else if (e._id.category === "operational") r.operational += e.n;
  }
  for (const d of decisions) {
    const r = row(d._id.atmId);
    r.decisions += d.n;
    if (d._id.action in r) r[d._id.action] += d.n;
  }
  const list = Object.values(rows).filter((r) => r.atmId).sort((a, b) => a.atmId.localeCompare(b.atmId));
  list.forEach((r) => (r.risk = riskLevel(r)));

  const cols = ["atmId", "risk", "security", "panel", "vibration", "motion", "operational", "decisions", ...ACTIONS];
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const csvPath = path.join(OUT_DIR, `report-${stamp}.csv`);
  fs.writeFileSync(csvPath, [cols.join(","), ...list.map((r) => cols.map((c) => r[c]).join(","))].join("\n") + "\n");

  const lat = latency[0] || { avg: 0, max: 0, n: 0 };
  const badge = { HIGH: "#c62828", MEDIUM: "#ef6c00", LOW: "#2e7d32" };
  const html = `<!doctype html><meta charset="utf-8"><title>ATM Risk Report</title>
<style>body{font:14px system-ui;margin:24px;color:#222}table{border-collapse:collapse;margin:12px 0}
td,th{border:1px solid #ccc;padding:4px 8px;text-align:right}th{background:#f3f3f3}td:first-child{text-align:left}
.b{color:#fff;padding:1px 6px;border-radius:3px;font-weight:600}</style>
<h1>ATM Risk Report — last ${HOURS} h</h1>
<p>Window: ${since.toISOString()} → ${now.toISOString()} (UTC)</p>
<p><b>${lat.n}</b> transaction decisions · avg service time <b>${Math.round(lat.avg || 0)} ms</b> · max <b>${lat.max || 0} ms</b> ·
HIGH-risk ATMs: <b>${list.filter((r) => r.risk === "HIGH").length}</b></p>
<h2>Per ATM</h2><table><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>
${list.map((r) => `<tr>${cols.map((c) => c === "risk"
    ? `<td><span class="b" style="background:${badge[r.risk]}">${r.risk}</span></td>`
    : `<td>${esc(r[c])}</td>`).join("")}</tr>`).join("\n")}</table>
<h2>Requests handled per instance (load balancing evidence)</h2>
<table><tr><th>host</th><th>decisions</th></tr>${hosts.map((h) => `<tr><td>${esc(h._id)}</td><td>${h.n}</td></tr>`).join("")}</table>
<p style="color:#666">Risk: HIGH = any lock or ≥20 security events; MEDIUM = any block or ≥8 security events; else LOW.</p>`;
  const htmlPath = path.join(OUT_DIR, `report-${stamp}.html`);
  fs.writeFileSync(htmlPath, html);

  console.log(`ATMs: ${list.length} | decisions: ${lat.n} | instances seen: ${hosts.length}`);
  console.log(`CSV : ${csvPath}\nHTML: ${htmlPath}`);
}

main().catch((err) => { console.error("Report failed:", err.message); process.exit(1); });
