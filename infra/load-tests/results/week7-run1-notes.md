# Week 7 — Run 1 (4-min test through ALB + ASG), 23 Sep 2026

- Window (UTC): 06:37:59 → 06:42:19
- Setup: ALB `atm-analysis-alb` → TG `atm-analysis-tg` (/health, :3000) → ASG `atm-analysis-asg` (1/1/4, LT v5, target tracking ALBRequestCountPerTarget = 50)
- Instances in service during test: 1 (no scale-out recorded in ASG Activity during the window)
- Decision logging to MongoDB: ON (one extra Atlas insert per request vs Week 6)

| Metric | Week 6 (single EC2, direct) | Week 7 run 1 (ALB, 1 instance) |
|---|---|---|
| Requests | — | 15,133 (63 req/s) |
| Success | 100% | 100% |
| Avg | 606 ms | 1.07 s |
| Median | — | 1.00 s |
| p95 | 1.07 s | 2.02 s |
| Max | — | 5.01 s |

Interpretation: scaling policy did not act within the 4-minute test (target tracking needs
several 1-minute datapoints above target before alarming, then boot + warmup). Latency is worse
than Week 6 because (a) still one t3.micro, (b) extra ALB hop, (c) new per-request decision write.
Next: sustained test (load-test-sustained.js, 10 min at 150 VUs) to show scale-out and recovery.
