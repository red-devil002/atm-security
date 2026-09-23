// atm-simulator/simulate-sensors.js
//
// Simulates a small fleet of ATMs publishing sensor events over MQTT.
// Covers both checklist items:
//   - Security sensors (panel, motion, vibration)
//   - Operational sensors (cash empty, wallet full, system failure)

const mqtt = require("mqtt");

// ---- Config -----

const BROKER_URL = "mqtt://localhost:1883";

const ATM_IDS = Array.from({ length: 10 }, (_, i) => `atm-${String(i + 1).padStart(3, "0")}`);

const SECURITY_SENSORS = ["panel", "motion", "vibration"];
const OPERATIONAL_SENSORS = ["cash_empty", "wallet_full", "system_failure"];

const PUBLISH_INTERVAL_MS = 3000;
const BURST_CHANCE = 0.25;

// ---- Connect ----
const client = mqtt.connect(BROKER_URL);

client.on("connect", () => {
  console.log(`Connected to MQTT broker at ${BROKER_URL}`);
  console.log(`Simulating ${ATM_IDS.length} ATMs. Publishing every ${PUBLISH_INTERVAL_MS}ms.\n`);
  setInterval(publishRandomEvent, PUBLISH_INTERVAL_MS);
});

client.on("error", (err) => {
  console.error("MQTT connection error:", err.message);
});

// ---- Event generation -----
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildEvent(atmId, category, type) {
  return {
    atmId,
    category,
    type,
    timestamp: new Date().toISOString(),
    value: true,
  };
}

function publishRandomEvent() {
  const atmId = pickRandom(ATM_IDS);

  const isSecurity = Math.random() < 0.6;
  const category = isSecurity ? "security" : "operational";
  const type = isSecurity ? pickRandom(SECURITY_SENSORS) : pickRandom(OPERATIONAL_SENSORS);

  const event = buildEvent(atmId, category, type);
  const topic = `atms/${atmId}/sensors`;

  publish(topic, event);

  if (Math.random() < BURST_CHANCE) {
    const burstCount = 2 + Math.floor(Math.random() * 3);
    for (let i = 1; i <= burstCount; i++) {
      setTimeout(() => {
        publish(topic, buildEvent(atmId, category, type));
      }, i * 150);
    }
  }
}

function publish(topic, event) {
  const payload = JSON.stringify(event);
  client.publish(topic, payload);
  console.log(`[${event.category}] ${topic} ->`, payload);
}