// 火山引擎 Ark 预签名 URL 生成器
// 复刻 https://ark.cn-beijing.volcengineapi.com?Action=GetAFPUsage&... 的签名格式
// 用法:
//   node electron/volcSign.cjs <AccessKeyId> <SecretAccessKey> <SessionToken>
// 或:
//   VOLC_AK=... VOLC_SK=... VOLC_TOKEN=... node electron/volcSign.cjs

const crypto = require('crypto');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

// 与 SDK signer.ts 的 uriEscape 一致: encodeURIComponent + 转义 !'()*
function uriEscape(str) {
  return encodeURIComponent(String(str)).replace(/[!'()*]/g, (c) => {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase();
  });
}

function getDateTime(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:\-]|\.\d{3}/g, '');
}

// 派生签名密钥 (与 SDK deriveSigningKeyNoPrefix 一致, kDatePrefix="")
function deriveSigningKey(secretAccessKey, date, region, service) {
  const kDate = hmac(secretAccessKey, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'request');
}

/**
 * 生成 Ark 预签名 URL
 * @param {Object} opts
 * @param {string} opts.accessKeyId
 * @param {string} opts.secretAccessKey
 * @param {string} [opts.sessionToken]
 * @param {string} [opts.host='ark.cn-beijing.volcengineapi.com']
 * @param {string} [opts.region='cn-beijing']
 * @param {string} [opts.service='ark']
 * @param {string} [opts.action='GetAFPUsage']
 * @param {string} [opts.version='2024-01-01']
 * @param {string} [opts.method='POST']
 * @param {number} [opts.expires=3600]
 * @returns {{url: string, curl: string}}
 */
function buildArkPresignUrl(opts) {
  const {
    accessKeyId,
    secretAccessKey,
    sessionToken,
    host = 'ark.cn-beijing.volcengineapi.com',
    region = 'cn-beijing',
    service = 'ark',
    action = 'GetCodingPlanUsage',
    version = '2024-01-01',
    method = 'POST',
    expires = 3600,
  } = opts;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('accessKeyId / secretAccessKey 不能为空');
  }

  const datetime = getDateTime();
  const date = datetime.slice(0, 8);
  const credentialScope = `${date}/${region}/${service}/request`;

  // 有 token 才把 X-Security-Token 纳入签名 (与 SDK presignUrl 行为一致)
  const signedQueriesKeys = sessionToken
    ? [
        'Action',
        'Version',
        'X-Algorithm',
        'X-Credential',
        'X-Date',
        'X-Expires',
        'X-NotSignBody',
        'X-Security-Token',
        'X-SignedHeaders',
        'X-SignedQueries',
      ]
    : [
        'Action',
        'Version',
        'X-Algorithm',
        'X-Credential',
        'X-Date',
        'X-Expires',
        'X-NotSignBody',
        'X-SignedHeaders',
        'X-SignedQueries',
      ];

  const query = {
    Action: action,
    Version: version,
    'X-Algorithm': 'HMAC-SHA256',
    'X-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Date': datetime,
    'X-Expires': String(expires),
    'X-NotSignBody': '1',
    'X-SignedHeaders': 'host',
    'X-SignedQueries': signedQueriesKeys.join(';'),
  };
  if (sessionToken) {
    query['X-Security-Token'] = sessionToken;
  }

  // 规范化查询串 (按 key 排序, URL 编码)
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEscape(k)}=${uriEscape(query[k])}`)
    .join('&');

  // X-NotSignBody=1 → body 不参与签名, 用空串的 hash
  const bodyHash = sha256('');

  // 规范化请求 (host 参与签名, headers 段为 "host:<host>\n" + signed headers "host")
  const canonicalRequest = [
    method.toUpperCase(),
    '/',
    canonicalQuery,
    `host:${host}\n`,
    'host',
    bodyHash,
  ].join('\n');

  // 待签名字符串
  const stringToSign = [
    'HMAC-SHA256',
    datetime,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');

  const signingKey = deriveSigningKey(secretAccessKey, date, region, service);
  const signature = hmac(signingKey, stringToSign).toString('hex');

  // 最终 URL (X-Signature 按字母序插在 X-Security-Token 和 X-SignedHeaders 之间)
  const finalQuery = Object.keys({ ...query, 'X-Signature': signature })
    .sort()
    .map((k) => `${uriEscape(k)}=${uriEscape(k === 'X-Signature' ? signature : query[k])}`)
    .join('&');

  const url = `https://${host}/?${finalQuery}`;
  const curl = `curl -X POST -d '{}' -H 'Content-Type: application/json; charset=utf-8' '${url}'`;

  return { url, curl, signature, datetime };
}

// CLI 直接运行
if (require.main === module) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const ak = process.argv[2] || process.env.VOLC_AK;
  const sk = process.argv[3] || process.env.VOLC_SK;
  const token = process.argv[4] || process.env.VOLC_TOKEN;

  if (!ak || !sk) {
    console.error('用法: node electron/volcSign.cjs <AK> <SK> [Token]');
    console.error('  或: VOLC_AK=... VOLC_SK=... VOLC_TOKEN=... node electron/volcSign.cjs');
    process.exit(1);
  }

  const { url, curl, signature, datetime } = buildArkPresignUrl({
    accessKeyId: ak,
    secretAccessKey: sk,
    sessionToken: token,
  });

  // 写到临时脚本, 避免终端折行复制导致 URL 被破坏
  const scriptPath = path.join(os.tmpdir(), 'ark_curl.sh');
  fs.writeFileSync(scriptPath, curl + '\n', { mode: 0o755 });

  console.log('=== DateTime ===');
  console.log(datetime);
  console.log('\n=== Signature ===');
  console.log(signature);
  console.log('\n=== URL ===');
  console.log(url);
  console.log('\n=== curl (已写入文件, 直接执行避免复制折行) ===');
  console.log(`bash ${scriptPath}`);
  console.log('\n=== curl 原文 ===');
  console.log(curl);
}

module.exports = { buildArkPresignUrl };
