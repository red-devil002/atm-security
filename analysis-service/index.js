// analysis-service/index.js (v2 — real logic)
//
// Same request/response shape as before, but now the response is
// computed from real data instead of hardcoded.

const express = require("express");
const os = require("os");
const { evaluateTransaction } = require("./riskEngine");
const { connectMongo } = require("./db");

// Week 7: every decision is also written to MongoDB ("decisions") so the
// 24-hour reporting job has a risk-profile store to summarise. The write
// is fire-and-forget: it never delays or changes the ATM's answer.
// Set DECISION_LOG=off in .env to disable (e.g. to reproduce Week 6 numbers).
const DECISION_LOG = (process.env.DECISION_LOG || "on").toLowerCase() !== "off";
const HOSTNAME = os.hostname();

function logDecision(request, result, latencyMs) {
  if (!DECISION_LOG) return;
  connectMongo()
    .then((db) =>
      db.collection("decisions").insertOne({
        atmId: request.atmId,
        type: request.type,
        amount: request.amount,
        action: result.action,
        securityScore: result.securityScore,
        maintenanceActive: result.maintenanceActive,
        operationalIssue: result.operationalIssue,
        eventsConsidered: result.eventsConsidered,
        latencyMs,
        host: HOSTNAME,
        decidedAt: new Date(),
      })
    )
    .catch((err) => console.error("  Decision log failed:", err.message));
}

const app = express();
const PORT = 3000;

app.use(express.json());

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", host: HOSTNAME });
});

app.post("/transaction", async (req, res) => {
  const request = req.body;
  console.log(`Received transaction request:`, request);

  const started = Date.now();
  try {
    const result = await evaluateTransaction(request);
    logDecision(request, result, Date.now() - started);

    console.log(
      `  -> action: ${result.action} | securityScore: ${result.securityScore} | ` +
      `maintenanceActive: ${result.maintenanceActive} | eventsConsidered: ${result.eventsConsidered}`
    );

    res.json({ action: result.action });
  } catch (err) {
    console.error("  Error evaluating transaction:", err.message);
    logDecision(request, { action: "block_transaction", error: true }, Date.now() - started);
    res.status(500).json({ action: "block_transaction", error: "internal_error" });
  }
});

app.listen(PORT, () => {
  console.log(`Analysis service (v2, real logic) listening on http://localhost:${PORT}`);
  console.log(`Waiting for transaction requests on POST /transaction\n`);
});