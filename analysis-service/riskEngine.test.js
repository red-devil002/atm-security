// analysis-service/riskEngine.test.js
//
// Tests the pure logic functions in riskEngine.js directly, with
// hand-built fake event arrays — no database, no MQTT, no network
// calls involved. This is deliberate: these functions don't touch
// Mongo or Postgres themselves, so they can be tested in isolation,
// fast and reliably.
//
// Run with: node --test

const test = require("node:test");
const assert = require("node:assert");
const { scoreSecurityEvents, hasOperationalIssue, decideAction } = require("./riskEngine");

test("no recent events -> approves the transaction", () => {
  const events = [];

  const score = scoreSecurityEvents(events, false);
  const operationalIssue = hasOperationalIssue(events);
  const action = decideAction(score, operationalIssue, "withdrawal");

  assert.strictEqual(score, 0);
  assert.strictEqual(operationalIssue, false);
  assert.strictEqual(action, "approve_withdrawal");
});

test("tamper events, no maintenance scheduled -> locks the system", () => {
  // panel (3) + vibration (3) + motion (2) = 8, which crosses
  // LOCK_THRESHOLD (7) with no discount applied.
  const events = [
    { category: "security", type: "panel" },
    { category: "security", type: "vibration" },
    { category: "security", type: "motion" },
  ];

  const score = scoreSecurityEvents(events, false);
  const operationalIssue = hasOperationalIssue(events);
  const action = decideAction(score, operationalIssue, "withdrawal");

  assert.strictEqual(score, 8);
  assert.strictEqual(action, "lock_system");
});

test("same tamper events, but during an active maintenance window -> approves", () => {
  // Same events as above (raw score 8), but maintenanceActive=true
  // applies the 0.2 discount factor: 8 * 0.2 = 1.6, well under
  // BLOCK_THRESHOLD (4).
  const events = [
    { category: "security", type: "panel" },
    { category: "security", type: "vibration" },
    { category: "security", type: "motion" },
  ];

  const score = scoreSecurityEvents(events, true);
  const operationalIssue = hasOperationalIssue(events);
  const action = decideAction(score, operationalIssue, "deposit");

  assert.strictEqual(score, 1.6);
  assert.strictEqual(action, "approve_deposit");
});

test("operational-only event -> notifies maintenance, does not block", () => {
  const events = [{ category: "operational", type: "cash_empty" }];

  const score = scoreSecurityEvents(events, false);
  const operationalIssue = hasOperationalIssue(events);
  const action = decideAction(score, operationalIssue, "withdrawal");

  assert.strictEqual(score, 0); // operational events don't add to security score
  assert.strictEqual(operationalIssue, true);
  assert.strictEqual(action, "notify_maintenance");
});