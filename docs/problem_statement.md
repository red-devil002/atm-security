# Problem Statement — ATM Security & Transaction Platform

## The problem, in simple words

A bank runs many ATMs across a city. Each ATM has sensors (panel, vibration,
motion) that report tampering, and it also asks a central service
**"Should I allow this withdrawal or deposit right now?"** before it hands out money.

That central service has to answer quickly and correctly, every time:

- If someone is **tampering** with the ATM, it should **block** the transaction
  or **lock** the machine.
- If a **technician is scheduled** to work on the ATM, the same sensor activity is
  expected, so it should **not** block customers by mistake.
- If the service **cannot check** its data (a database is down), it must
  **fail safe** and block, never approve blindly.

The hard part is **scale**. At busy times (lunch hour, payday, a public event)
many ATMs send requests at once. When we tested one server, it worked but slowed
down: the average response was about **0.6 s** and the slowest 5% took over
**1 s** at 150 simultaneous users. One server is also a single point of failure:
if it dies, every ATM loses its security check.

## What we are building

A system that:

1. Collects ATM sensor events (MQTT → MongoDB Atlas) and keeps reference data
   (ATMs, maintenance windows) in PostgreSQL.
2. Scores the risk of each transaction and returns one action:
   approve, block, lock, or notify maintenance.
3. Runs on AWS behind a **load balancer**, with an **Auto Scaling Group** that
   adds servers when traffic rises (1 → up to 4) and replaces broken ones.

## How we will know it works

| Question | Measure |
|---|---|
| Is it correct? | Unit tests pass; a real `POST /transaction` returns 200 with the right action |
| Is it faster under load than one server? | k6 test (10 → 150 users, 4 min): compare avg and p95 with the Week 6 baseline (606 ms / 1.07 s) |
| Is it reliable? | 100% successful requests; ASG replaces a stopped instance on its own |
| Does it scale? | CloudWatch shows instances going 1 → more when request count per target passes 50 |
| Can the bank see what happened? | A 24-hour report (CSV/HTML) built from MongoDB |

## Out of scope (future work)

- Storing secrets in AWS Secrets Manager / SSM (Learner Lab limits IAM).
- Separate readiness vs liveness health checks.
- A managed Postgres (RDS) shared by all instances.
