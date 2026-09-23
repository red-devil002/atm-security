#!/bin/bash
# infra/aws/build-aws.sh — Week 7 AWS rebuild, run in AWS CloudShell (us-east-1).
#
# One step at a time, verify each before the next:
#   ./build-aws.sh check      # credentials, default VPC, subnets, SG, key pair
#   ./build-aws.sh lt         # launch template v1 (prompts for MONGO_URI, hidden)
#   ./build-aws.sh test       # ONE test instance -> waits for POST /transaction = 200
#   ./build-aws.sh test-clean # terminate the test instance (all real ones come from the ASG)
#   ./build-aws.sh alb        # target group (/health, 3000) + ALB (80) + listener
#   ./build-aws.sh asg        # ASG 1/1/4 + target tracking ALBRequestCountPerTarget=50
#   ./build-aws.sh status     # instances, target health, live POST through the ALB
#   ./build-aws.sh replace    # Learner Lab workaround for blocked instance refresh
#   ./build-aws.sh evidence START END   # CloudWatch numbers for the report (UTC ISO times)
#   ./build-aws.sh teardown   # delete ASG, ALB, TG, LT (asks for confirmation)
set -euo pipefail
export AWS_DEFAULT_REGION=us-east-1 AWS_PAGER=""
LT=atm-analysis-lt; TG=atm-analysis-tg; ALB=atm-analysis-alb; ASG=atm-analysis-asg
KEY=atm-project-key; SG_NAME=launch-wizard-1; TYPE=t3.micro; TEST_TAG=atm-test-instance
HERE="$(cd "$(dirname "$0")" && pwd)"
TX='{"atmId":"atm-001","type":"withdrawal","amount":100,"timestamp":"2026-01-01T00:00:00Z"}'

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

vpc()     { aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text; }
# Default subnets, skipping us-east-1e (no t3 capacity there)
subnets() { aws ec2 describe-subnets --filters Name=vpc-id,Values="$(vpc)" Name=default-for-az,Values=true \
              --query 'Subnets[?AvailabilityZone!=`us-east-1e`].SubnetId' --output text; }
sg()      { aws ec2 describe-security-groups --filters Name=vpc-id,Values="$(vpc)" Name=group-name,Values="$SG_NAME" \
              --query 'SecurityGroups[0].GroupId' --output text; }
tg_arn()  { aws elbv2 describe-target-groups --names "$TG" --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true; }
alb_arn() { aws elbv2 describe-load-balancers --names "$ALB" --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true; }
alb_dns() { aws elbv2 describe-load-balancers --names "$ALB" --query 'LoadBalancers[0].DNSName' --output text; }
ami()     { aws ec2 describe-images --owners amazon \
              --filters 'Name=name,Values=al2023-ami-2023.*-kernel-*-x86_64' Name=state,Values=available \
              --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text; }
open_port() { aws ec2 authorize-security-group-ingress --group-id "$(sg)" --protocol tcp --port "$1" --cidr 0.0.0.0/0 >/dev/null 2>&1 \
              && echo "  opened port $1" || echo "  port $1 already open"; }

cmd_check() {
  say "Identity";          aws sts get-caller-identity --query Arn --output text
  say "Default VPC";       vpc
  say "Subnets used";      subnets
  say "Security group";    sg
  say "Key pair";          aws ec2 describe-key-pairs --key-names "$KEY" --query 'KeyPairs[0].KeyName' --output text
  say "AMI (AL2023)";      ami
  say "Existing resources (should be empty on a clean slate)"
  aws ec2 describe-launch-templates --launch-template-names "$LT" --query 'LaunchTemplates[0].LaunchTemplateName' --output text 2>/dev/null || echo "  no launch template"
  echo "  TG: $(tg_arn)"; echo "  ALB: $(alb_arn)"
  aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG" --query 'AutoScalingGroups[0].AutoScalingGroupName' --output text
}

cmd_lt() {
  aws ec2 describe-launch-templates --launch-template-names "$LT" >/dev/null 2>&1 \
    && die "$LT already exists. Rule: ONE version only. Run teardown first if it is wrong."
  [[ -f "$HERE/user-data.sh" ]] || die "user-data.sh not found next to this script"
  read -r -s -p "Paste MONGO_URI (hidden): " MONGO_URI; echo
  [[ "$MONGO_URI" == mongodb* && "$MONGO_URI" != *"<password>"* ]] || die "That does not look like a real Atlas URI"
  local tmp; tmp=$(mktemp)
  # Replace the placeholder without sed (URI contains / & ? characters)
  MONGO_URI="$MONGO_URI" python3 -c 'import os,sys;s=open(sys.argv[1]).read();assert "__PASTE_MONGO_URI_HERE__" in s;open(sys.argv[2],"w").write(s.replace("__PASTE_MONGO_URI_HERE__",os.environ["MONGO_URI"],1))' "$HERE/user-data.sh" "$tmp"
  open_port 22; open_port 3000; open_port 80
  local data; data=$(base64 -w0 "$tmp"); rm -f "$tmp"
  aws ec2 create-launch-template --launch-template-name "$LT" --version-description v1-week7 \
    --launch-template-data "{\"ImageId\":\"$(ami)\",\"InstanceType\":\"$TYPE\",\"KeyName\":\"$KEY\",
      \"SecurityGroupIds\":[\"$(sg)\"],\"UserData\":\"$data\",
      \"TagSpecifications\":[{\"ResourceType\":\"instance\",\"Tags\":[{\"Key\":\"Project\",\"Value\":\"atm-security\"}]}]}" \
    --query 'LaunchTemplate.[LaunchTemplateName,LatestVersionNumber,DefaultVersionNumber]' --output text
  echo "Launch template created (v1 = default = latest). Next: ./build-aws.sh test"
}

wait_tx() { # $1 = base url
  for i in $(seq 1 60); do
    code=$(curl -s -m 5 -o /tmp/tx.json -w '%{http_code}' -X POST "$1/transaction" -H 'Content-Type: application/json' -d "$TX" || true)
    if [[ "$code" == 200 ]]; then echo "PASS: POST /transaction -> 200 $(cat /tmp/tx.json)"; return 0; fi
    printf '.'; sleep 10
  done
  echo; die "POST /transaction never returned 200 (last: $code). SSH in and: ssh as ubuntu@ (Ubuntu) or ec2-user@ (AL2023), then: sudo tail -50 /var/log/atm-userdata.log"
}

cmd_test() {
  local id ip
  id=$(aws ec2 run-instances --launch-template "LaunchTemplateName=$LT,Version=1" --subnet-id "$(subnets | awk '{print $1}')" \
       --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$TEST_TAG}]" --query 'Instances[0].InstanceId' --output text)
  echo "Launched $id, waiting for running..."; aws ec2 wait instance-running --instance-ids "$id"
  ip=$(aws ec2 describe-instances --instance-ids "$id" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
  echo "Public IP $ip — User Data takes ~3-5 min. Polling http://$ip:3000/transaction"
  wait_tx "http://$ip:3000"
  echo "Next: ./build-aws.sh test-clean, then ./build-aws.sh alb"
}

cmd_test_clean() {
  local ids; ids=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$TEST_TAG" Name=instance-state-name,Values=pending,running,stopped \
                   --query 'Reservations[].Instances[].InstanceId' --output text)
  [[ -n "$ids" ]] || { echo "No test instance."; return; }
  aws ec2 terminate-instances --instance-ids $ids --query 'TerminatingInstances[].InstanceId' --output text
}

cmd_alb() {
  local vpc_id tg alb
  vpc_id=$(vpc)
  tg=$(tg_arn); if [[ -z "$tg" || "$tg" == None ]]; then
    tg=$(aws elbv2 create-target-group --name "$TG" --protocol HTTP --port 3000 --vpc-id "$vpc_id" --target-type instance \
         --health-check-path /health --health-check-interval-seconds 15 --healthy-threshold-count 2 --unhealthy-threshold-count 2 \
         --query 'TargetGroups[0].TargetGroupArn' --output text)
    aws elbv2 modify-target-group-attributes --target-group-arn "$tg" --attributes Key=deregistration_delay.timeout_seconds,Value=30 >/dev/null
  fi; echo "TG : $tg"
  alb=$(alb_arn); if [[ -z "$alb" || "$alb" == None ]]; then
    alb=$(aws elbv2 create-load-balancer --name "$ALB" --type application --scheme internet-facing \
          --subnets $(subnets) --security-groups "$(sg)" --query 'LoadBalancers[0].LoadBalancerArn' --output text)
    echo "Waiting for ALB to become active..."; aws elbv2 wait load-balancer-available --load-balancer-arns "$alb"
    aws elbv2 create-listener --load-balancer-arn "$alb" --protocol HTTP --port 80 \
      --default-actions "Type=forward,TargetGroupArn=$tg" --query 'Listeners[0].ListenerArn' --output text
  fi; echo "ALB: $alb"; echo "DNS: $(alb_dns)"
}

cmd_asg() {
  local tg alb label
  tg=$(tg_arn); alb=$(alb_arn); [[ "$tg" == arn* && "$alb" == arn* ]] || die "Run ./build-aws.sh alb first"
  # Pin Version=1 explicitly — never rely on $Default/$Latest (Week 7 drift bug)
  aws autoscaling create-auto-scaling-group --auto-scaling-group-name "$ASG" \
    --launch-template "LaunchTemplateName=$LT,Version=1" --min-size 1 --desired-capacity 1 --max-size 4 \
    --vpc-zone-identifier "$(subnets | tr '\t ' ',,')" --target-group-arns "$tg" \
    --health-check-type ELB --health-check-grace-period 300 --default-instance-warmup 120 \
    --tags "Key=Name,Value=atm-asg-instance,PropagateAtLaunch=true"
  aws autoscaling enable-metrics-collection --auto-scaling-group-name "$ASG" --granularity 1Minute
  label="${alb#*:loadbalancer/}/${tg##*:}"   # app/<alb>/<id>/targetgroup/<tg>/<id>
  aws autoscaling put-scaling-policy --auto-scaling-group-name "$ASG" --policy-name atm-req-per-target-50 \
    --policy-type TargetTrackingScaling --target-tracking-configuration \
    "{\"PredefinedMetricSpecification\":{\"PredefinedMetricType\":\"ALBRequestCountPerTarget\",\"ResourceLabel\":\"$label\"},\"TargetValue\":50}" \
    --query 'PolicyARN' --output text
  echo "ASG created. Wait ~5 min, then ./build-aws.sh status"
}

cmd_status() {
  say "ASG"; aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG" \
    --query 'AutoScalingGroups[0].{Min:MinSize,Desired:DesiredCapacity,Max:MaxSize,LT:LaunchTemplate.Version,Instances:Instances[].[InstanceId,LifecycleState,HealthStatus]}' --output json
  say "Target health"; aws elbv2 describe-target-health --target-group-arn "$(tg_arn)" \
    --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State,TargetHealth.Reason]' --output table
  say "Live POST through the ALB"; wait_tx "http://$(alb_dns)"
  say "k6 commands (run on your Mac)"
  echo "k6 run --vus 1 --iterations 20 -e ALB_DNS=$(alb_dns) infra/load-tests/load-test.js"
  echo "date -u; k6 run -e ALB_DNS=$(alb_dns) --summary-export=infra/load-tests/results/week7-alb-summary.json infra/load-tests/load-test.js; date -u"
}

cmd_replace() {
  aws autoscaling update-auto-scaling-group --auto-scaling-group-name "$ASG" --min-size 0 --desired-capacity 0
  echo "Scaled to 0. Waiting for instances to terminate..."
  while [[ $(aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG" --query 'length(AutoScalingGroups[0].Instances)') != 0 ]]; do printf '.'; sleep 10; done
  aws autoscaling update-auto-scaling-group --auto-scaling-group-name "$ASG" --min-size 1 --desired-capacity 1
  echo; echo "Back to 1. Check ./build-aws.sh status in ~5 min."
}

cmd_evidence() {
  local start=${1:?START (UTC ISO, e.g. 2026-09-24T01:00:00Z)} end=${2:?END}
  local alb_dim tg_dim
  alb_dim=$(alb_arn); alb_dim=${alb_dim#*:loadbalancer/}; tg_dim=$(tg_arn); tg_dim=${tg_dim##*:}
  say "ASG GroupInServiceInstances (max per minute)"
  aws cloudwatch get-metric-statistics --namespace AWS/AutoScaling --metric-name GroupInServiceInstances \
    --dimensions Name=AutoScalingGroupName,Value="$ASG" --start-time "$start" --end-time "$end" --period 60 --statistics Maximum \
    --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Maximum]' --output text
  say "ALB RequestCountPerTarget (sum per minute)"
  aws cloudwatch get-metric-statistics --namespace AWS/ApplicationELB --metric-name RequestCountPerTarget \
    --dimensions Name=TargetGroup,Value="$tg_dim" Name=LoadBalancer,Value="$alb_dim" --start-time "$start" --end-time "$end" --period 60 --statistics Sum \
    --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Sum]' --output text
  say "ALB TargetResponseTime (avg seconds per minute)"
  aws cloudwatch get-metric-statistics --namespace AWS/ApplicationELB --metric-name TargetResponseTime \
    --dimensions Name=LoadBalancer,Value="$alb_dim" --start-time "$start" --end-time "$end" --period 60 --statistics Average \
    --query 'sort_by(Datapoints,&Timestamp)[].[Timestamp,Average]' --output text
  say "Scaling activities"
  aws autoscaling describe-scaling-activities --auto-scaling-group-name "$ASG" --max-items 20 \
    --query 'Activities[].[StartTime,StatusCode,Description]' --output text
}

cmd_teardown() {
  read -r -p "Delete ASG, ALB, target group and launch template? Type DELETE: " ok; [[ "$ok" == DELETE ]] || die "Cancelled"
  aws autoscaling delete-auto-scaling-group --auto-scaling-group-name "$ASG" --force-delete 2>/dev/null && echo "ASG deleting" || true
  local alb tg; alb=$(alb_arn); tg=$(tg_arn)
  [[ "$alb" == arn* ]] && aws elbv2 delete-load-balancer --load-balancer-arn "$alb" && aws elbv2 wait load-balancers-deleted --load-balancer-arns "$alb" && echo "ALB deleted"
  sleep 10; [[ "$tg" == arn* ]] && aws elbv2 delete-target-group --target-group-arn "$tg" && echo "TG deleted" || true
  aws ec2 delete-launch-template --launch-template-name "$LT" >/dev/null 2>&1 && echo "LT deleted" || true
  echo "Kept: key pair, security group, Atlas."
}

case "${1:-}" in
  check) cmd_check ;; lt) cmd_lt ;; test) cmd_test ;; test-clean) cmd_test_clean ;;
  alb) cmd_alb ;; asg) cmd_asg ;; status) cmd_status ;; replace) cmd_replace ;;
  evidence) shift; cmd_evidence "$@" ;; teardown) cmd_teardown ;;
  *) sed -n '2,16p' "$0"; exit 1 ;;
esac
