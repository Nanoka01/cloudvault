# CloudVault — ระบบจัดเก็บและสำรองข้อมูล

Cloud drive แบบ Google Drive บน AWS ที่มีระบบบริษัท ผู้ใช้แต่ละคนมีพื้นที่ส่วนตัว (My Files)
สร้างหรือเข้าร่วมบริษัทด้วยรหัสเชิญ แอดมินสั่งงาน ลูกทีมเลือกไฟล์จากไดรฟ์ตัวเองส่งงาน
ไฟล์ถูก **ล็อก** ระหว่างรอตรวจ เมื่อ **Approve** ไฟล์จะย้ายไปพื้นที่บริษัท คืนพื้นที่ให้ผู้ใช้
แล้ว S3 Lifecycle จะลดระดับ storage อัตโนมัติ (วันที่ 3 → Glacier Instant Retrieval, วันที่ 180 → Deep Archive)

```
React (AWS Amplify) ──HTTPS + JWT──▶ API Gateway ──▶ Lambda Authorizer (ตรวจ JWT)
        │                                 │
        │ presigned URL                   ▼
        └──────────▶ Amazon S3 ◀──── Lambda (API) ────▶ DynamoDB
                    (Versioning,          │
                     Lifecycle)           └── SSM Parameter Store (JWT secret)
              CloudWatch: logs + alarm · EventBridge: ล้างถังขยะวันละครั้ง
```

## โครงสร้างโปรเจกต์

| โฟลเดอร์ | เนื้อหา |
| --- | --- |
| `backend/template.yaml` | Infrastructure ทั้งหมด (AWS SAM): DynamoDB, S3 + Lifecycle, API Gateway, Lambda 3 ตัว, CloudWatch alarm |
| `backend/src/handlers/` | `api.mjs` (router ของทุก endpoint), `authorizer.mjs` (ตรวจ JWT), `purge.mjs` (ล้างถังขยะ) |
| `backend/src/routes/` | `auth` · `files` (My Files, ถังขยะ, เวอร์ชัน, แชร์) · `companies` · `tasks` (ส่งงาน, ล็อก, Approve/Reject) |
| `backend/src/lib/` | JWT, DynamoDB keys, S3 helpers (presigned POST/GET, ลบทุกเวอร์ชัน, Deep Archive) |
| `backend/local/` | เซิร์ฟเวอร์จำลอง API Gateway สำหรับรันบนเครื่อง |
| `backend/test/e2e.test.mjs` | ทดสอบ end-to-end 13 กรณี กับ AWS จำลอง (moto) |
| `frontend/` | React + Vite: Login/Register, My Files, ถังขยะ, งานที่ส่งแล้ว, บริษัท, งาน, ตรวจงาน, สมาชิก/Monitoring |
| `amplify.yml` | ค่า build สำหรับ AWS Amplify Hosting |

---

## 1. รันบนเครื่องตัวเอง (ไม่ต้องมีบัญชี AWS)

ต้องมี **Node.js 20+** และ **Python 3** ใช้ [moto](https://github.com/getmoto/moto) จำลอง DynamoDB และ S3

```bash
pip install "moto[server]"

# หน้าต่างที่ 1 — AWS จำลอง
cd backend
npm install
npm run moto

# หน้าต่างที่ 2 — API
cd backend
npm run setup:local      # สร้างตารางและ bucket ใน AWS จำลอง (ทำครั้งเดียวต่อการเปิด moto)
npm run dev              # API ที่ http://localhost:3001

# หน้าต่างที่ 3 — หน้าเว็บ
cd frontend
npm install
cp .env.example .env     # Windows: copy .env.example .env
npm run dev              # เปิด http://localhost:5173
```

ข้อมูลใน moto จะหายเมื่อปิดหน้าต่างที่ 1 (เปิดใหม่แล้วต้องรัน `npm run setup:local` อีกครั้ง)

**รันชุดทดสอบ:** `cd backend && npm test` (เปิด moto ของตัวเองให้อัตโนมัติ)

---

## 2. Deploy ขึ้น AWS

ต้องมี [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) และ
[AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
แล้วรัน `aws configure` ใส่ Access Key ของบัญชี

### 2.1 สร้าง JWT secret ใน SSM Parameter Store (ครั้งเดียว)

```bash
# macOS / Linux / Git Bash
aws ssm put-parameter --name /cloudvault/jwt-secret --type SecureString \
  --value "$(openssl rand -hex 32)" --region ap-southeast-1
```

```powershell
# Windows PowerShell
$secret = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
aws ssm put-parameter --name /cloudvault/jwt-secret --type SecureString --value $secret --region ap-southeast-1
```

### 2.2 Deploy backend

```bash
cd backend
npm install
sam build
sam deploy --guided
```

ตอบคำถามของ `--guided` ประมาณนี้:

| คำถาม | คำตอบ |
| --- | --- |
| Stack Name | `cloudvault` |
| AWS Region | `ap-southeast-1` (สิงคโปร์) |
| Parameter AllowedOrigin | `*` (ค่อยเปลี่ยนเป็นโดเมน Amplify ในข้อ 2.4) |
| Parameter JwtSecretParameterName | กด Enter (`cloudvault/jwt-secret`) |
| Parameter UserQuotaBytes | กด Enter (5 GB) |
| Confirm changes before deploy | `y` |
| Allow SAM CLI IAM role creation | `y` |
| ApiFunction has no authentication. Is this okay? | `y` (ถามเพราะ `/auth/*` กับ `/share/*` ต้องเปิดสาธารณะ ส่วน path อื่นมี Lambda Authorizer) |
| Save arguments to configuration file | `y` |

เสร็จแล้วจด **`ApiUrl`** จาก Outputs เช่น `https://abc123.execute-api.ap-southeast-1.amazonaws.com/prod`

### 2.3 Deploy หน้าเว็บด้วย AWS Amplify

1. push โปรเจกต์นี้ขึ้น GitHub (ทั้งโฟลเดอร์ `cloudvault/`)
2. AWS Console → **Amplify** → **Create new app** → เลือก GitHub → เลือก repo และ branch
3. ติ๊ก **My app is a monorepo** แล้วใส่ root directory = `frontend` (Amplify จะอ่าน `amplify.yml` เอง)
4. **Environment variables** เพิ่ม `VITE_API_URL` = ค่า `ApiUrl` จากข้อ 2.2
5. กด Deploy รอจนได้โดเมน เช่น `https://main.d1234abcd.amplifyapp.com`
6. เมนู **Hosting → Rewrites and redirects** เพิ่มกฎนี้ (ให้ refresh หน้าย่อยได้ เพราะเป็น SPA):

   | Source address | Target address | Type |
   | --- | --- | --- |
   | `</^[^.]+$\|\.(?!(css\|gif\|ico\|jpg\|js\|png\|txt\|svg\|woff\|woff2\|ttf\|map\|json\|webp)$)([^.]+$)/>` | `/index.html` | 200 (Rewrite) |

### 2.4 ล็อก CORS ให้รับเฉพาะโดเมน Amplify

```bash
cd backend
sam deploy --parameter-overrides AllowedOrigin=https://main.d1234abcd.amplifyapp.com
```

---

## 3. สิ่งที่ระบบทำ (สรุปกฎสำคัญ)

- **JWT บอกแค่ว่าเป็นใคร** — role ในบริษัทอ่านจาก DynamoDB ทุกครั้ง คนที่ถูกนำออกหมดสิทธิ์ทันที
- **อัปโหลดด้วย presigned POST** — S3 ปฏิเสธเองถ้าไฟล์ใหญ่กว่าโควตาที่เหลือ ไฟล์ไม่ผ่าน Lambda
- **S3 key สร้างที่ Lambda เท่านั้น** — client กำหนด path เองไม่ได้
- **ไฟล์ที่ส่งงานถูกล็อก** — ลบ เขียนทับ แชร์ ส่งซ้ำไม่ได้ จนกว่าแอดมินจะตรวจ (ใช้ DynamoDB transaction)
- **Approve** = CopyObject เวอร์ชันที่ส่งไป `companies/…` → อัปเดตสถานะ + คืนโควตาในคำสั่งเดียว → ลบทุกเวอร์ชันฝั่งผู้ใช้
- **Reject** = ปลดล็อกไฟล์ ผู้ใช้แก้แล้วส่งใหม่ได้
- **ลิงก์แชร์** ชี้มาที่ `/share/{token}` แล้ว redirect ไป presigned URL ใหม่ทุกครั้ง (presigned URL ที่เซ็นด้วยสิทธิ์ของ Lambda ใช้ได้แค่ไม่กี่ชั่วโมง)
- **Lifecycle**
  - `users/`: เวอร์ชันเก่าเก็บ 30 วัน
  - `companies/` (ไฟล์ > 128 KB): วันที่ 3 → Glacier IR, วันที่ 180 → Deep Archive
  - ไฟล์ใน Deep Archive ต้องกด “ขอกู้คืน” (12–48 ชม.) ก่อนดาวน์โหลด
- **ถังขยะ** — ลบถาวรอัตโนมัติหลัง 30 วัน (EventBridge เรียก Lambda วันละครั้ง)

## 4. ข้อจำกัดของต้นแบบ

- ไฟล์ละไม่เกิน 5 GB (เพดานของ presigned POST) และส่งงานได้ครั้งละไม่เกิน 20 ไฟล์
- ค้นหาไฟล์ด้วยการกรองชื่อใน Lambda (เหมาะกับไฟล์หลักร้อยถึงหลักพันต่อคน)
- ยังไม่มีลืมรหัสผ่าน / ยืนยันอีเมล
- ลบ stack แล้ว bucket จะยังอยู่ (`DeletionPolicy: Retain`) เพื่อกันข้อมูลหาย ต้องลบเองใน S3 Console
