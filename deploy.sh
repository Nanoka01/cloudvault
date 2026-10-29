#!/usr/bin/env bash
# Deploy CloudVault ทั้งระบบด้วยคำสั่งเดียว ออกแบบให้รันใน AWS CloudShell
#   bash deploy.sh
# รันซ้ำได้: ครั้งต่อไปจะอัปเดต backend และหน้าเว็บของเดิม (ไม่สร้างใหม่)
#
# ขั้นตอน
#   1) สร้าง JWT secret ใน SSM Parameter Store (ถ้ายังไม่มี)
#   2) สร้างแอป Amplify (แบบไม่ใช้ Git) เพื่อให้รู้โดเมนของหน้าเว็บก่อน
#      ถ้าบัญชีใช้ Amplify ไม่ได้ (บาง Learner Lab) จะใช้ S3 Static Website Hosting แทน
#   3) sam build + sam deploy backend โดยล็อก CORS ให้รับเฉพาะโดเมน Amplify
#   4) build หน้าเว็บ React ด้วย URL ของ API ที่ได้
#   5) อัปโหลดหน้าเว็บขึ้น Amplify Hosting แล้วรอจนเสร็จ
# เลือก template อัตโนมัติ: AWS Academy Learner Lab → template.yaml (ใช้ LabRole)
#                         บัญชีปกติ → template.standard-account.yaml (สร้าง IAM role ให้เอง)
# บังคับเองได้: TEMPLATE=template.standard-account.yaml bash deploy.sh
set -euo pipefail

STACK_NAME="${STACK_NAME:-cloudvault}"
APP_NAME="${APP_NAME:-cloudvault}"
BRANCH="main"
SECRET_PARAM="/cloudvault/jwt-secret"
export AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
export AWS_DEFAULT_REGION="$AWS_REGION"

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m[ผิดพลาด] %s\033[0m\n' "$*" >&2; exit 1; }

# ตรวจความพร้อม
step "ตรวจเครื่องมือและบัญชี AWS"
for cmd in aws sam node npm zip curl; do
  command -v "$cmd" >/dev/null 2>&1 || fail "ไม่พบคำสั่ง $cmd (ถ้าไม่ได้รันใน CloudShell ต้องติดตั้งก่อน)"
done
[ -n "$AWS_REGION" ] || fail "ไม่รู้ region รันแบบนี้แทน: AWS_REGION=ap-southeast-1 bash deploy.sh"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || fail "ต้องใช้ Node.js 18 ขึ้นไป (ตอนนี้ $(node -v))"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)" || fail "ยังไม่ได้ login AWS"
CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text)"
if [ -z "${TEMPLATE:-}" ]; then
  if [[ "$CALLER_ARN" == *voclabs* ]]; then
    TEMPLATE="template.yaml"
    echo "ตรวจพบ AWS Academy Learner Lab → ใช้ template.yaml (LabRole)"
    case "$AWS_REGION" in us-east-1|us-west-2) ;; *) fail "Learner Lab ใช้ได้แค่ us-east-1 หรือ us-west-2 (ตอนนี้ $AWS_REGION) เปลี่ยน region มุมขวาบนของ Console แล้วเปิด CloudShell ใหม่" ;; esac
  else
    TEMPLATE="template.standard-account.yaml"
    echo "บัญชี AWS ปกติ → ใช้ template.standard-account.yaml"
  fi
fi
[ -f "$ROOT/backend/$TEMPLATE" ] || fail "ไม่พบ backend/$TEMPLATE"
echo "บัญชี $ACCOUNT_ID · region $AWS_REGION · stack $STACK_NAME"

# 1) JWT secret
step "1/5 JWT secret ใน SSM Parameter Store"
if aws ssm get-parameter --name "$SECRET_PARAM" >/dev/null 2>&1; then
  echo "มีอยู่แล้ว ใช้ของเดิม (ผู้ใช้ไม่ต้อง login ใหม่)"
else
  SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  aws ssm put-parameter --name "$SECRET_PARAM" --type SecureString --value "$SECRET" >/dev/null
  echo "สร้าง $SECRET_PARAM แล้ว"
fi

# 2) ที่อยู่หน้าเว็บ
step "2/5 เตรียมที่อยู่หน้าเว็บ (Amplify Hosting)"
HOSTING="amplify"
APP_ID=""
setup_amplify() {
  APP_ID="$(aws amplify list-apps --query "apps[?name=='${APP_NAME}'].appId | [0]" --output text)" || return 1
  if [ -z "$APP_ID" ] || [ "$APP_ID" = "None" ]; then
    APP_ID="$(aws amplify create-app --name "$APP_NAME" --platform WEB \
      --custom-rules "file://$ROOT/amplify-rules.json" --query app.appId --output text)" || return 1
    echo "สร้างแอป Amplify $APP_ID แล้ว"
  else
    aws amplify update-app --app-id "$APP_ID" --custom-rules "file://$ROOT/amplify-rules.json" >/dev/null || return 1
    echo "ใช้แอป Amplify เดิม $APP_ID"
  fi
  if ! aws amplify get-branch --app-id "$APP_ID" --branch-name "$BRANCH" >/dev/null 2>&1; then
    aws amplify create-branch --app-id "$APP_ID" --branch-name "$BRANCH" >/dev/null || return 1
  fi
  local domain
  domain="$(aws amplify get-app --app-id "$APP_ID" --query app.defaultDomain --output text)" || return 1
  SITE_URL="https://${BRANCH}.${domain}"
}
if ! setup_amplify; then
  # บัญชีที่ถูกจำกัดสิทธิ์ Amplify → โฮสต์หน้าเว็บบน S3 แทน
  HOSTING="s3"
  WEB_BUCKET="${APP_NAME}-web-${ACCOUNT_ID}-${AWS_REGION}"
  SITE_URL="http://${WEB_BUCKET}.s3-website-${AWS_REGION}.amazonaws.com"
  echo "ใช้ Amplify ไม่ได้ในบัญชีนี้ → จะโฮสต์หน้าเว็บบน S3 Static Website แทน"
fi
echo "หน้าเว็บจะอยู่ที่ $SITE_URL"

# 3) backend
step "3/5 Deploy backend (sam build + sam deploy) ใช้เวลาประมาณ 3–5 นาที"
STATUS="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo NONE)"
if [ "$STATUS" = "ROLLBACK_COMPLETE" ]; then
  echo "stack เดิมสร้างไม่สำเร็จค้างอยู่ (ROLLBACK_COMPLETE) ลบทิ้งก่อนแล้วสร้างใหม่"
  aws cloudformation delete-stack --stack-name "$STACK_NAME"
  aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"
fi

cd "$ROOT/backend"
npm ci --no-audit --no-fund
sam build --template-file "$TEMPLATE"
sam deploy \
  --stack-name "$STACK_NAME" \
  --resolve-s3 \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --parameter-overrides "AllowedOrigin=${SITE_URL}"
rm -rf .aws-sam node_modules # คืนพื้นที่ CloudShell (มีแค่ 1 GB)

API_URL="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)"
[ -n "$API_URL" ] && [ "$API_URL" != "None" ] || fail "ไม่พบ ApiUrl ใน Outputs ของ stack"
echo "API: $API_URL"

# 4) build หน้าเว็บ
step "4/5 Build หน้าเว็บ React"
cd "$ROOT/frontend"
npm ci --no-audit --no-fund
VITE_API_URL="$API_URL" npm run build
rm -f "$ROOT/site.zip"
(cd dist && zip -qr "$ROOT/site.zip" .)
rm -rf node_modules

# 5) อัปโหลดหน้าเว็บ
if [ "$HOSTING" = "amplify" ]; then
  step "5/5 Deploy หน้าเว็บขึ้น Amplify"
  read -r JOB_ID UPLOAD_URL < <(aws amplify create-deployment --app-id "$APP_ID" --branch-name "$BRANCH" \
    --query '[jobId, zipUploadUrl]' --output text)
  curl -sSf -H "Content-Type: application/zip" --upload-file "$ROOT/site.zip" "$UPLOAD_URL" >/dev/null
  aws amplify start-deployment --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB_ID" >/dev/null

  JOB_STATUS="PENDING"
  for _ in $(seq 1 60); do
    JOB_STATUS="$(aws amplify get-job --app-id "$APP_ID" --branch-name "$BRANCH" --job-id "$JOB_ID" \
      --query 'job.summary.status' --output text)"
    case "$JOB_STATUS" in SUCCEED|FAILED|CANCELLED) break ;; esac
    sleep 5
  done
  [ "$JOB_STATUS" = "SUCCEED" ] || fail "Deploy หน้าเว็บไม่สำเร็จ (สถานะ $JOB_STATUS) ดูรายละเอียดในหน้า Amplify Console"
else
  step "5/5 Deploy หน้าเว็บขึ้น S3 Static Website"
  if ! aws s3api head-bucket --bucket "$WEB_BUCKET" >/dev/null 2>&1; then
    if [ "$AWS_REGION" = "us-east-1" ]; then
      aws s3api create-bucket --bucket "$WEB_BUCKET" >/dev/null
    else
      aws s3api create-bucket --bucket "$WEB_BUCKET" \
        --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
    fi
  fi
  aws s3api put-public-access-block --bucket "$WEB_BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false \
    || fail "เปิดให้อ่านสาธารณะไม่ได้ (บัญชีอาจล็อก Block Public Access ไว้ทั้งบัญชี)"
  aws s3api put-bucket-policy --bucket "$WEB_BUCKET" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"PublicRead\",\"Effect\":\"Allow\",\"Principal\":\"*\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::${WEB_BUCKET}/*\"}]}"
  # error document = index.html เพื่อให้ refresh หน้าย่อยของ SPA ได้
  aws s3api put-bucket-website --bucket "$WEB_BUCKET" \
    --website-configuration '{"IndexDocument":{"Suffix":"index.html"},"ErrorDocument":{"Key":"index.html"}}'
  aws s3 sync "$ROOT/frontend/dist" "s3://$WEB_BUCKET" --delete
fi
rm -rf "$ROOT/site.zip" "$ROOT/frontend/dist"

printf '\n\033[1;32mเสร็จแล้ว!\033[0m\n'
echo "  หน้าเว็บ : $SITE_URL"
echo "  API      : $API_URL"
echo "  ดูทรัพยากรทั้งหมดได้ที่ CloudFormation → stack \"$STACK_NAME\""
