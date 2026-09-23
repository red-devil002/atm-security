# ATM Security & Transaction Platform

SIT314 \u2013 Distinction Project

## Current status (Week 5)

The full pipeline is built and verified end to end, both locally and now deployed to AWS:

- **ATM sensor simulation** (`atm-simulator/simulate-sensors.js`) \u2013 publishes security (panel, motion, vibration) and operational (cash empty, wallet full, system failure) events over MQTT.
- **Node-RED flow** (`node-red-flows/`) \u2013 subscribes to sensor events, debounces duplicate bursts, and writes the cleaned events into MongoDB Atlas.
- **Synchronous transaction path** (`atm-simulator/simulate-transaction.js`) \u2013 sends withdrawal/deposit requests over HTTP and waits for a response before proceeding.
- **Analysis service** (`analysis-service/`) \u2013 a Node.js/Express service that computes a genuine risk score from real Postgres (maintenance schedule) and MongoDB (recent event history) data, and returns one of five actions: `approve_withdrawal`, `approve_deposit`, `block_transaction`, `lock_system`, `notify_maintenance`.
- **Unit tests** (`analysis-service/riskEngine.test.js`) \u2013 four tests covering the core scoring/action-mapping branches, run with `node --test`.
- **AWS deployment** \u2013 the analysis service is deployed to a single EC2 instance (Ubuntu, t3.micro), with Postgres running alongside it in Docker, and MongoDB Atlas used as-is (already cloud-hosted). Confirmed reachable and working from outside AWS via a real `curl` request.

## Architecture

See `docs/` for the block diagram and data flow diagram from the project plan.

## Deployment notes (AWS Academy Learner Lab)

This project is deployed using a **AWS Academy Learner Lab** environment rather than a personal AWS account. This has a few practical implications worth knowing before touching AWS again:

- **No IAM user management** \u2013 Learner Labs block `iam:CreateUser` and similar actions by design. Use the temporary credentials provided via the lab's "AWS Details" panel directly.
- **Credentials expire** \u2013 typically after a few hours, or when the lab session ends. If `aws sts get-caller-identity` fails, refresh credentials from AWS Details and update `~/.aws/credentials` (Access Key ID, Secret Access Key, and Session Token \u2013 all three).
- **The EC2 instance's public IP changes on restart.** If the lab session ends and is restarted, the instance keeps its data (Postgres included) but is very likely assigned a **new public IPv4 address**. Always check the EC2 console for the current IP before trying to SSH in or hit the analysis service \u2013 don't assume it's the same as last time.
- **Postgres data survives restarts** \u2013 the Docker container itself needs to be started again after a reboot (`docker start atm-postgres`), but the underlying data persists.

## Running locally

```
# analysis-service/.env (not committed \u2013 see .env.example)
MONGO_URI=<your Atlas connection string>

cd analysis-service
npm install
node index.js
```

Postgres (local): mapped to port `5433` by default (see `db.js`); override with `PG_PORT` in `.env` if needed (the AWS deployment uses `5432`).

## Running tests

```
cd analysis-service
node --test
```

## Planned remaining work

- Week 6: load test the deployed single instance (k6/Artillery), record the scalability bottleneck.
- Week 7: configure AWS Auto Scaling + CloudWatch, re-run the load test to demonstrate recovery; build the 24-hour reporting job.
- Week 8: security hardening (TLS, least-privilege IAM where applicable), final report and HD research report.
## Week 7 — Auto Scaling rebuild + reporting

Problem statement in plain words: [`docs/problem_statement.md`](docs/problem_statement.md).

**AWS build (run in CloudShell, us-east-1), one step at a time:**

```
git clone https://github.com/red-devil002/atm-security.git && cd atm-security/infra/aws
./build-aws.sh check        # clean slate? VPC, subnets, SG, key pair
./build-aws.sh lt           # launch template v1 (MONGO_URI prompted, hidden — never committed)
./build-aws.sh test         # one instance; passes only when POST /transaction returns 200
./build-aws.sh test-clean   # terminate it — real instances come from the ASG only
./build-aws.sh alb          # target group (/health :3000) + ALB (:80)
./build-aws.sh asg          # ASG min 1 / desired 1 / max 4, target tracking ALBRequestCountPerTarget = 50
./build-aws.sh status       # instances, target health, live POST via ALB, k6 commands
```

`infra/aws/user-data.sh` refuses to boot with a placeholder secret and stops the service if its own
`POST /transaction` self-test fails, so a broken instance can't hide behind a passing `/health`.

**Load test** (the ALB DNS is passed in, not hard-coded):

```
k6 run --vus 1 --iterations 20 -e ALB_DNS=<alb-dns> infra/load-tests/load-test.js
k6 run -e ALB_DNS=<alb-dns> --summary-export=infra/load-tests/results/week7-alb-summary.json infra/load-tests/load-test.js
```

**CloudWatch evidence:** `./build-aws.sh evidence <start-UTC> <end-UTC>` prints instance count, requests per target,
response time and scaling activities for the test window.

**24-hour report:** every decision is logged to MongoDB `decisions` (fire-and-forget, `DECISION_LOG=off` disables it).
`npm run report` (or `npm run report -- 6` for 6 hours) writes a CSV + HTML summary per ATM, plus requests handled per
instance, to `reports/output/`.

**Learner Lab notes:** instance refresh is blocked by an SCP — use `./build-aws.sh replace` (desired 0 → 1).
