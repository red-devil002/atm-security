// atm-simulator/simulate-transaction.js
//
// Simulates ATMs making cash transactions. Unlike the sensor simulator
// (fire-and-forget over MQTT), this is synchronous: the ATM sends a
// request and WAITS for the analysis service's response before
// continuing — exactly like a real ATM would wait before dispensing cash.

const ANALYSIS_SERVICE_URL = "http://localhost:3000/transaction";

// Reuse the same ATM ID scheme as the sensor simulator, so this data
// lines up with what week 3's database setup expects.
const ATM_IDS = Array.from({ length: 10 }, (_, i) => `atm-${String(i + 1).padStart(3, "0")}`);

const TRANSACTION_TYPES = ["withdrawal", "deposit"];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildTransactionRequest() {
  return {
    atmId: pickRandom(ATM_IDS),
    type: pickRandom(TRANSACTION_TYPES),
    amount: (1 + Math.floor(Math.random() * 20)) * 20, // $20–$400, in $20 steps
    timestamp: new Date().toISOString(),
  };
}

async function sendTransaction() {
  const request = buildTransactionRequest();

  console.log(`\n[${request.timestamp}] Sending transaction:`);
  console.log(`  ATM: ${request.atmId} | Type: ${request.type} | Amount: $${request.amount}`);
  console.log(`  Waiting for response...`);

  const startedAt = Date.now();

  try {
    const response = await fetch(ANALYSIS_SERVICE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    const elapsedMs = Date.now() - startedAt;

    if (!response.ok) {
      console.log(`  Service returned an error: HTTP ${response.status} (${elapsedMs}ms)`);
      return;
    }

    const result = await response.json();
    console.log(`  Response received in ${elapsedMs}ms -> action: ${result.action}`);
  } catch (err) {
    // This is expected if the analysis service isn't running yet —
    // that's fine this week, it just means Step 2 hasn't been built yet.
    console.log(`  Request failed: ${err.message}`);
  }
}

// Send one transaction every 4 seconds. Slower than the sensor
// simulator on purpose — each of these involves a real wait, so it's
// easier to read the output if they're spaced out.
setInterval(sendTransaction, 4000);

console.log("ATM transaction simulator running. Sending a request every 4 seconds.");
console.log(`Target: ${ANALYSIS_SERVICE_URL}\n`);