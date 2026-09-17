// 代替页面把请求真正发出去：支持以 / 开头的本机内置示例接口，也支持完整的 http 与 https 地址
// 返回结果里带上状态、耗时、响应头与响应内容，失败时给出可以直接看懂的原因

const http = require('http');
const https = require('https');

// 单次请求的等待上限，避免目标地址长时间不回应把页面一直卡在等待中
const WAIT_LIMIT_MS = 15000;
// 回传给页面的响应内容上限，超过的部分不再保存
const MAX_BODY_BYTES = 1024 * 1024;

function isInternalAddress(value) {
  return typeof value === 'string' && value.startsWith('/');
}

function resolveTarget(value, port) {
  const text = String(value || '').trim();
  if (isInternalAddress(text)) {
    return { url: new URL(text, `http://127.0.0.1:${port}`), internal: true };
  }
  return { url: new URL(text), internal: false };
}

// 把响应头整理成有序的行列表，同名多值的情况合并展示
function toHeaderRows(headers) {
  return Object.keys(headers || {})
    .sort()
    .map((key) => ({
      key,
      value: Array.isArray(headers[key]) ? headers[key].join(', ') : String(headers[key]),
    }));
}

// 网络层出错时给出可读原因，原始信息放在详情里备查
function describeFailure(err) {
  const code = err && err.code ? String(err.code) : '';
  const known = {
    ENOTFOUND: '找不到目标主机，请检查地址里的域名是否正确',
    EAI_AGAIN: '域名解析暂时没有结果，请稍后再试或检查网络',
    ECONNREFUSED: '目标地址拒绝连接，请确认对方服务已启动、端口填写正确',
    ECONNRESET: '连接被对方中断，目标服务可能提前关闭了连接',
    EHOSTUNREACH: '目标主机不可达，请检查网络连通情况',
    ENETUNREACH: '网络不可达，请检查本机网络与目标地址',
    ETIMEDOUT: `等待目标响应超过 ${WAIT_LIMIT_MS / 1000} 秒，已停止等待`,
    TIMEOUT: `等待目标响应超过 ${WAIT_LIMIT_MS / 1000} 秒，已停止等待`,
    EPROTO: '与目标地址的协议不匹配，握手没有完成',
    ERR_INVALID_URL: '目标地址格式不正确，无法发起请求',
  };
  return {
    reason: known[code] || '这次请求没有成功完成，请检查目标地址与网络情况',
    detail: (err && err.message) || '',
    code,
  };
}

function buildFailure(err, targetUrl, internal, startedAt) {
  const failure = describeFailure(err);
  return {
    ok: false,
    internal,
    targetUrl,
    timeMs: Date.now() - startedAt,
    failure,
  };
}

// 发送一次请求并等待结果，任何失败都通过返回值表达，不抛出到调用方
function sendOutgoing(draft, port) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let target = null;
    try {
      target = resolveTarget(draft.url, port);
    } catch (err) {
      resolve(buildFailure(err, String(draft.url || ''), false, startedAt));
      return;
    }

    const transport = target.url.protocol === 'https:' ? https : http;
    const headers = {};
    draft.headers.forEach((row) => {
      if (row.key) headers[row.key] = row.value;
    });
    if (draft.body) headers['Content-Length'] = Buffer.byteLength(draft.body, 'utf8');

    const options = {
      protocol: target.url.protocol,
      hostname: target.url.hostname,
      port: target.url.port || (target.url.protocol === 'https:' ? 443 : 80),
      path: `${target.url.pathname}${target.url.search}`,
      method: draft.method,
      headers,
    };

    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    const request = transport.request(options, (response) => {
      const chunks = [];
      let received = 0;
      let truncated = false;

      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_BODY_BYTES) {
          if (!truncated) {
            const keep = chunk.length - (received - MAX_BODY_BYTES);
            if (keep > 0) chunks.push(chunk.subarray(0, keep));
            truncated = true;
          }
          return;
        }
        chunks.push(chunk);
      });

      response.on('close', () => {
        if (response.complete) return;
        finish(buildFailure(Object.assign(new Error('目标服务在返回内容的过程中中断了连接'), { code: 'ECONNRESET' }), target.url.toString(), target.internal, startedAt));
      });

      response.on('error', (err) => {
        finish(buildFailure(err, target.url.toString(), target.internal, startedAt));
      });

      response.on('end', () => {
        finish({
          ok: true,
          internal: target.internal,
          targetUrl: target.url.toString(),
          status: response.statusCode,
          statusText: response.statusMessage || '',
          timeMs: Date.now() - startedAt,
          size: received,
          truncated,
          contentType: response.headers['content-type'] || '',
          headers: toHeaderRows(response.headers),
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    request.on('error', (err) => {
      finish(buildFailure(err, target.url.toString(), target.internal, startedAt));
    });

    request.setTimeout(WAIT_LIMIT_MS, () => {
      request.destroy(Object.assign(new Error(`等待目标响应超过 ${WAIT_LIMIT_MS} 毫秒`), { code: 'TIMEOUT' }));
    });

    if (draft.body) request.write(draft.body);
    request.end();
  });
}

module.exports = {
  sendOutgoing,
  resolveTarget,
  isInternalAddress,
  WAIT_LIMIT_MS,
  MAX_BODY_BYTES,
};
