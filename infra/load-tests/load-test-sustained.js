// infra/load-tests/load-test-sustained.js
//
// Week 7 scaling test: same request as load-test.js but HOLDS peak load for
// 10 minutes. The 4-minute test ends before target tracking can react
// (alarm needs ~3 one-minute datapoints, then ~2-5 min boot + 120 s warmup).
//
// (original header below)
// infra/load-tests/load-test.js
//
// Week 7: same load pattern as the week 6 baseline, now targeting
// the Application Load Balancer instead of a single EC2 instance
// directly. This is what actually lets the Auto Scaling Group react
// to load, since traffic now flows through the ALB -> target group
// -> whichever instances are currently running.

import http from "k6/http";
import { check } from "k6";

// Pass the ALB DNS name at run time (it changes every rebuild):
//   k6 run -e ALB_DNS=atm-analysis-alb-xxxx.us-east-1.elb.amazonaws.com infra/load-tests/load-test.js
// Default = current Week 7 ALB (23 Sep 2026 rebuild); override with -e ALB_DNS=...
const ALB_DNS = __ENV.ALB_DNS || "atm-analysis-alb-1966130315.us-east-1.elb.amazonaws.com";
const TARGET_URL = __ENV.TARGET_URL || `http://${ALB_DNS}/transaction`;

export const options = {
  dns: {
    policy: "preferIPv4",
  },
  stages: [
    { duration: "1m", target: 50 },
    { duration: "1m", target: 150 },
    { duration: "10m", target: 150 }, // hold long enough for target tracking (3 x 1-min datapoints) + 120 s warmup
    { duration: "30s", target: 0 },
  ],
};

const ATM_IDS = Array.from({ length: 10 }, (_, i) => `atm-${String(i + 1).padStart(3, "0")}`);
const TRANSACTION_TYPES = ["withdrawal", "deposit"];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default function () {
  const payload = JSON.stringify({
    atmId: pickRandom(ATM_IDS),
    type: pickRandom(TRANSACTION_TYPES),
    amount: (1 + Math.floor(Math.random() * 20)) * 20,
    timestamp: new Date().toISOString(),
  });

  const res = http.post(TARGET_URL, payload, {
    headers: { "Content-Type": "application/json" },
  });

  check(res, {
    "status is 200": (r) => r.status === 200,
  });
}