// 内置示例接口：让页面不填外部地址也能试出发送与结果展示的效果
// 四个接口分别覆盖正常回显、按参数报错、列表结构、可指定等待时长四种情形

const ORDER_NAMES = ['无线键盘', '显示器支架', '机械硬盘', '网络摄像头', '桌面音箱', '扩展坞'];
const ORDER_STATUS = ['待付款', '已付款', '已发货', '已完成'];
const MAX_WAIT_MS = 10000;

// 示例接口清单：既用于挂载路由，也用于页面上的填入入口与说明文档
const ENDPOINTS = [
  {
    id: 'echo',
    name: '回声接口',
    method: '任意',
    path: '/demo/echo',
    summary: '把收到的请求方式、请求头、查询参数与请求内容原样回显，用来确认请求确实发了出去',
    example: {
      name: '回声接口连通性检查',
      method: 'GET',
      url: '/demo/echo?from=workbench',
      headers: [{ key: 'Accept', value: 'application/json' }],
      body: '',
    },
  },
  {
    id: 'status',
    name: '报错接口',
    method: '任意',
    path: '/demo/status?code=500',
    summary: '按地址里的取值返回对应状态码，用来查看请求失败时页面上的结果展示',
    example: {
      name: '报错接口状态码核对',
      method: 'GET',
      url: '/demo/status?code=500',
      headers: [{ key: 'Accept', value: 'application/json' }],
      body: '',
    },
  },
  {
    id: 'items',
    name: '列表接口',
    method: 'GET',
    path: '/demo/items?page=1&size=3',
    summary: '返回带分页信息的条目列表，用来查看层级较多的响应内容怎么展示',
    example: {
      name: '列表接口分页取值',
      method: 'GET',
      url: '/demo/items?page=1&size=3',
      headers: [{ key: 'Accept', value: 'application/json' }],
      body: '',
    },
  },
  {
    id: 'slow',
    name: '延迟接口',
    method: '任意',
    path: '/demo/slow?ms=1500',
    summary: '等待指定毫秒数之后再返回，用来观察等待过程中的页面反馈与耗时显示',
    example: {
      name: '延迟接口等待观察',
      method: 'GET',
      url: '/demo/slow?ms=1500',
      headers: [{ key: 'Accept', value: 'application/json' }],
      body: '',
    },
  },
];

// 查询参数可能是数组，只取第一个值；未填写时返回 undefined
function pickParam(req, name) {
  const raw = req.query ? req.query[name] : undefined;
  if (Array.isArray(raw)) return raw.length ? raw[0] : undefined;
  return raw;
}

function toHeaderRows(headers) {
  return Object.keys(headers || {})
    .sort()
    .map((key) => ({
      key,
      value: Array.isArray(headers[key]) ? headers[key].join(', ') : String(headers[key]),
    }));
}

// 请求内容按实际收到的类型描述，方便页面直接看明白发出去的是什么
function describeBody(req) {
  const value = req.body;
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    return value ? { kind: '文本', value } : null;
  }
  if (typeof value === 'object') {
    return Object.keys(value).length ? { kind: '结构化内容', value } : null;
  }
  return { kind: '文本', value: String(value) };
}

function describeStatus(code) {
  if (code === 200) return '请求成功';
  if (code === 201) return '资源已创建';
  if (code === 204) return '成功但没有返回内容';
  if (code === 301 || code === 302) return '目标地址发生了跳转';
  if (code === 400) return '参数不合法，服务拒绝了这次请求';
  if (code === 401) return '缺少身份凭证';
  if (code === 403) return '凭证有效但没有访问权限';
  if (code === 404) return '请求的资源不存在';
  if (code === 429) return '请求过于频繁，被限流了';
  if (code >= 500) return '目标服务内部处理失败';
  if (code >= 400) return '请求没有被接受';
  return '请求已处理';
}

function buildItems(page, size) {
  const total = 17;
  const startIndex = (page - 1) * size;
  const items = [];
  for (let offset = 0; offset < size; offset += 1) {
    const index = startIndex + offset;
    if (index >= total) break;
    items.push({
      id: `ORD-${1000 + index}`,
      name: ORDER_NAMES[index % ORDER_NAMES.length],
      count: (index % 5) + 1,
      amount: Number((((index % 9) + 1) * 12.5).toFixed(2)),
      status: ORDER_STATUS[index % ORDER_STATUS.length],
      urgent: index % 4 === 0,
      createdAt: new Date(Date.now() - index * 3600 * 1000).toISOString(),
    });
  }
  return {
    page,
    size,
    total,
    pages: Math.ceil(total / size),
    hasNext: startIndex + items.length < total,
    items,
  };
}

// 把示例接口挂到服务上，路径统一以 /demo 开头
function mount(app) {
  app.all('/demo/echo', (req, res) => {
    res.json({
      message: '内置回声接口已收到这次请求',
      request: {
        method: req.method,
        path: req.originalUrl,
        headers: toHeaderRows(req.headers),
        query: req.query || {},
        body: describeBody(req),
        receivedAt: new Date().toISOString(),
      },
    });
  });

  app.all('/demo/status', (req, res) => {
    const raw = pickParam(req, 'code');
    const code = raw === undefined ? 400 : Number(raw);
    if (!Number.isInteger(code) || code < 200 || code > 599) {
      return res.status(400).json({
        message: '状态码取值需要在 200 到 599 之间',
        received: raw === undefined ? '' : String(raw),
        tip: '在目标地址上写成 /demo/status?code=500 这样即可',
      });
    }
    if (code === 204 || code === 304) return res.status(code).end();
    return res.status(code).json({
      code,
      message: describeStatus(code),
      at: new Date().toISOString(),
      tip: '这是内置报错接口按参数返回的响应',
    });
  });

  app.get('/demo/items', (req, res) => {
    const rawPage = pickParam(req, 'page');
    const rawSize = pickParam(req, 'size');
    if (rawPage !== undefined && !/^[1-9]\d*$/.test(String(rawPage))) {
      return res.status(400).json({ message: '页码需要是不小于 1 的整数', received: String(rawPage) });
    }
    if (rawSize !== undefined && !/^[1-9]\d*$/.test(String(rawSize))) {
      return res.status(400).json({ message: '每页条数需要是不小于 1 的整数', received: String(rawSize) });
    }
    const page = rawPage === undefined ? 1 : Number(rawPage);
    const size = Math.min(rawSize === undefined ? 3 : Number(rawSize), 20);
    return res.json(buildItems(page, size));
  });

  app.all('/demo/slow', (req, res) => {
    const raw = pickParam(req, 'ms');
    const ms = raw === undefined ? 1000 : Number(raw);
    if (!Number.isFinite(ms) || ms < 0 || ms > MAX_WAIT_MS) {
      return res.status(400).json({
        message: `等待时长需要是 0 到 ${MAX_WAIT_MS} 之间的毫秒数`,
        received: raw === undefined ? '' : String(raw),
      });
    }
    // 等待期间调用方可能提前断开，写回内容前先守住这种情况
    res.on('error', () => {});
    setTimeout(() => {
      if (res.writableEnded || res.destroyed) return;
      res.json({
        message: '内置延迟接口已返回',
        waitedMs: ms,
        finishedAt: new Date().toISOString(),
      });
    }, ms);
    return undefined;
  });
}

// 提供给页面与说明文档的清单，去掉内部字段
function listEndpoints() {
  return ENDPOINTS.map((item) => ({
    id: item.id,
    name: item.name,
    method: item.method,
    path: item.path,
    summary: item.summary,
    example: item.example,
  }));
}

module.exports = { mount, listEndpoints, ENDPOINTS };
