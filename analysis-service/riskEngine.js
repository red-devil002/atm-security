// analysis-service/riskEngine.js
//
// The actual "analysis" in analysis service. Given a transaction
// request, this looks up real history from both databases and
// computes a specific action — this is the deliberately heavy,
// CPU/IO-bound step the whole scalability story depends on later.

const { pgPool, connectMongo } = require("./db");

// --- Config (tunable — document your reasoning if you change these) ------

const RECENT_WINDOW_MINUTES = 10;

// How much each security sensor type contributes to the risk score.
// Panel and vibration are weighted highest — they're the strongest
// physical tamper signals. Motion alone is weaker (could just be
// someone walking past), so it counts for less.
const SECURITY_WEIGHTS = {
  panel: 3,
  vibration: 3,
  motion: 2,
};

// If a maintenance window is active right now, security events are
// expected (a technician is meant to be there) — heavily discount
// the score rather than ignoring it completely, so a genuinely
// unusual pattern during maintenance can still surface later if needed.
const MAINTENANCE_DISCOUNT_FACTOR = 0.2;

const BLOCK_THRESHOLD = 4;
const LOCK_THRESHOLD = 7;

// --- Data lookups ---------------------------------------------------------

async function isMaintenanceActive(atmId) {
  const result = await pgPool.query(
    `SELECT 1 FROM maintenance_schedule
     WHERE atm_id = $1 AND start_time <= NOW() AND end_time >= NOW()
     LIMIT 1`,
    [atmId]
  );
  return result.rowCount > 0;
}

async function getRecentEvents(atmId) {
  const db = await connectMongo();
  const cutoff = new Date(Date.now() - RECENT_WINDOW_MINUTES * 60 * 1000);

  return db
    .collection("events")
    .find({ atmId, timestamp: { $gte: cutoff.toISOString() } })
    .toArray();
}

// --- Scoring ---
function scoreSecurityEvents(events, maintenanceActive) {
  const securityEvents = events.filter((e) => e.category === "security");

  let score = securityEvents.reduce((total, event) => {
    return total + (SECURITY_WEIGHTS[event.type] || 0);
  }, 0);

  if (maintenanceActive) {
    score = score * MAINTENANCE_DISCOUNT_FACTOR;
  }

  return score;
}

function hasOperationalIssue(events) {
  return events.some((e) => e.category === "operational");
}

// --- Action mapping ---
function decideAction(securityScore, operationalIssue, transactionType) {
  if (securityScore >= LOCK_THRESHOLD) {
    return "lock_system";
  }
  if (securityScore >= BLOCK_THRESHOLD) {
    return "block_transaction";
  }
  if (operationalIssue) {
    // Not a security concern — the transaction can still proceed,
    // but maintenance staff should be alerted.
    return "notify_maintenance";
  }
  return transactionType === "deposit" ? "approve_deposit" : "approve_withdrawal";
}

// --- Public entry point ---
async function evaluateTransaction(request) {
  const { atmId, type } = request;

  const [maintenanceActive, recentEvents] = await Promise.all([
    isMaintenanceActive(atmId),
    getRecentEvents(atmId),
  ]);

  const securityScore = scoreSecurityEvents(recentEvents, maintenanceActive);
  const operationalIssue = hasOperationalIssue(recentEvents);
  const action = decideAction(securityScore, operationalIssue, type);

  return {
    action,
    securityScore,
    maintenanceActive,
    operationalIssue,
    eventsConsidered: recentEvents.length,
  };
}

module.exports = {
  evaluateTransaction,
  scoreSecurityEvents,
  hasOperationalIssue,
  decideAction,
};