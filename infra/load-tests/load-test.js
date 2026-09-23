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
if (!__ENV.ALB_DNS && !__ENV.TARGET_URL) {
  throw new Error("Set -e ALB_DNS=<alb dns name> (or -e TARGET_URL=<full url>)");
}
const TARGET_URL = __ENV.TARGET_URL || `http://${__ENV.ALB_DNS}/transaction`;

export const options = {
  dns: {
    policy: "preferIPv4",
  },
  stages: [
    { duration: "30s", target: 10 },
    { duration: "1m", target: 50 },
    { duration: "1m", target: 100 },
    { duration: "1m", target: 150 },
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