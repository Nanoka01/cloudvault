// เซิร์ฟเวอร์จำลอง API Gateway สำหรับพัฒนาบนเครื่อง
// แปลง HTTP request เป็น event แบบ API Gateway → เรียก Lambda Authorizer → เรียก Lambda หลัก
// วิธีใช้: npm run moto (อีกหน้าต่าง) → npm run setup:local → npm run dev
import './env.mjs';
import http from 'node:http';

const { handler: api } = await import('../src/handlers/api.mjs');
const { handler: authorizer } = await import('../src/handlers/authorizer.mjs');

const PUBLIC = [/^\/auth\//, /^\/share\//];

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : null;

    const event = {
      httpMethod: req.method,
      path: url.pathname,
      headers: req.headers,
      queryStringParameters: url.searchParams.size ? Object.fromEntries(url.searchParams) : null,
      body,
      isBase64Encoded: false,
      requestContext: { domainName: req.headers.host, stage: 'local' },
    };

    let result;
    if (req.method !== 'OPTIONS' && !PUBLIC.some((p) => p.test(url.pathname))) {
      try {
        const auth = await authorizer({
          authorizationToken: req.headers.authorization || '',
          methodArn: `arn:aws:execute-api:local:000000000000:api/local/${req.method}${url.pathname}`,
        });
        event.requestContext.authorizer = auth.context;
      } catch {
        result = {
          statusCode: 401,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ message: 'Unauthorized' }),
        };
      }
    }
    result ??= await api(event);
    res.writeHead(result.statusCode, result.headers || {});
    res.end(result.body || '');
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT);
  createServer().listen(port, () => console.log(`CloudVault API (local) → http://localhost:${port}`));
}
