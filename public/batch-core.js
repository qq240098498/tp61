// 按数据行执行的纯逻辑：占位位置扫描、表格解析、预演校验与替换
// 不依赖页面 DOM，既能被 public/app.js 复用，也能在 Node 下直接 require 做校验
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.BatchCore = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 占位位置统一写成 {{名字}}，可出现在目标地址、请求头名称/取值、请求内容里
  const PLACEHOLDER_PATTERN = /\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g;

  // 扫描一条用例里用到的占位名字，按首次出现的顺序去重
  function scanPlaceholders(item) {
    const sources = [item.url];
    (item.headers || []).forEach((row) => {
      sources.push(row.key, row.value);
    });
    sources.push(item.body);
    const names = [];
    sources.forEach((text) => {
      if (typeof text !== 'string') return;
      PLACEHOLDER_PATTERN.lastIndex = 0;
      let match = null;
      while ((match = PLACEHOLDER_PATTERN.exec(text)) !== null) {
        const name = match[1].trim();
        if (name && !names.includes(name)) names.push(name);
      }
    });
    return names;
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 把一段文本里的某个占位名（容许两侧空格）替换成实际取值
  function applyPlaceholder(text, name, value) {
    if (typeof text !== 'string') return text;
    const pattern = new RegExp(`\\{\\{\\s*${escapeRegExp(name)}\\s*\\}\\}`, 'g');
    return text.replace(pattern, value);
  }

  // 解析一行：支持制表符粘贴的 TSV，也支持带引号的逗号 CSV
  // TSV（从 Excel/WPS 直接复制）里引号是普通字符，只有逗号 CSV 才按引号包裹处理
  function splitTableRow(line, delimiter) {
    const quotedCsv = delimiter === ',';
    const cells = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (quotedCsv && quoted) {
        if (char === '"') {
          if (line[i + 1] === '"') {
            current += '"';
            i += 1;
          } else {
            quoted = false;
          }
        } else {
          current += char;
        }
      } else if (quotedCsv && char === '"') {
        quoted = true;
      } else if (char === delimiter) {
        cells.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current);
    return cells;
  }

  // 把粘贴进来的整块表格拆成行；第一行当表头，行列号都按"含表头、从 1 开始"对外展示
  function parseTable(text) {
    const rawLines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    // 去掉结尾因最后一次换行产生的空行，中间的空行保留（会按列数对不上报错）
    while (rawLines.length && rawLines[rawLines.length - 1] === '') rawLines.pop();
    if (!rawLines.length) return { delimiter: '\t', lines: [] };
    const firstLine = rawLines[0];
    const delimiter = firstLine.includes('\t') ? '\t' : ',';
    const lines = rawLines.map((line) => splitTableRow(line, delimiter));
    return { delimiter, lines };
  }

  function columnLabel(index) {
    // 第 1 列显示为 A、第 2 列 B……超过 26 列再进位，方便对照粘贴的表格
    let n = index + 1;
    let label = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      label = String.fromCharCode(65 + rem) + label;
      n = Math.floor((n - 1) / 26);
    }
    return label;
  }

  // 预演核心：校验表头与每一行，并为成立的行构造替换后真正会发出去的请求内容
  // headerWarnings 只让对应列"用不上"，不阻断其它行；headerBlocking（重名等）会让所有数据行不成立
  function buildBatchPreview(item, rawText) {
    const placeholders = scanPlaceholders(item);
    const parsed = parseTable(rawText);
    const preview = {
      item,
      placeholders,
      headerWarnings: [],
      headerBlocking: [],
      rows: [],
      validCount: 0,
      invalidCount: 0,
    };

    if (!parsed.lines.length) {
      preview.headerBlocking.push({ column: -1, message: '还没有粘贴表格内容' });
      return preview;
    }

    const headers = parsed.lines[0].map((cell) => String(cell).trim());

    // 表头逐列检查：空表头、重名、名字在用例里找不到占位位置
    const nameToColumns = new Map();
    headers.forEach((name, column) => {
      if (!name) {
        preview.headerWarnings.push({ column, message: `表头第 ${columnLabel(column)} 列没有写名字，这一列的取值不会参与替换` });
        return;
      }
      if (!placeholders.includes(name)) {
        preview.headerWarnings.push({
          column,
          message: `表头「${name}」（第 ${columnLabel(column)} 列）在用例里找不到对应的占位位置 {{${name}}}，这一列的取值不会参与替换`,
        });
      }
      const columns = nameToColumns.get(name) || [];
      columns.push(column);
      nameToColumns.set(name, columns);
    });
    nameToColumns.forEach((columns, name) => {
      if (columns.length > 1) {
        preview.headerBlocking.push({
          column: columns[0],
          columns: columns.slice(),
          message: `表头「${name}」在第 ${columns.map(columnLabel).join('、')} 列重复出现，无法确定按哪一列替换`,
        });
      }
    });
    const hasBlockingHeader = preview.headerBlocking.length > 0;
    const missingInHeader = placeholders.filter((name) => !nameToColumns.has(name));

    for (let r = 1; r < parsed.lines.length; r += 1) {
      const cells = parsed.lines[r].map((cell) => String(cell));
      const rowNumber = r + 1; // 加上表头那一行
      const errors = [];

      if (cells.length !== headers.length) {
        const diff = cells.length - headers.length;
        const where = diff > 0
          ? `多出 ${diff} 列（第一个多余值在第 ${columnLabel(headers.length)} 列之后）`
          : `少了 ${-diff} 列（从第 ${columnLabel(cells.length)} 列起缺值）`;
        errors.push({ column: -1, message: `共有 ${cells.length} 列，表头有 ${headers.length} 列，${where}` });
      }

      // 空单元格：只要表头里对应得上占位位置，空着就无法替换
      cells.forEach((value, column) => {
        const headerName = headers[column];
        if (value.trim() === '' && headerName && placeholders.includes(headerName)) {
          errors.push({ column, message: `「${headerName}」这一格是空的，无法替换占位位置` });
        }
      });

      // 列名 -> 本行取值（取该列第一次出现的位置，重名时仅用于提示，不实际发送）
      const valueMap = new Map();
      headers.forEach((name, column) => {
        if (name && !valueMap.has(name) && cells[column] !== undefined) valueMap.set(name, cells[column]);
      });

      let request = null;
      // 表头重名时不再做替换，避免取错列；只保留行自身的问题与重名提示
      if (!errors.length && !hasBlockingHeader) {
        request = {
          name: item.name,
          method: item.method,
          url: item.url,
          headers: (item.headers || []).map((row) => ({ key: row.key, value: row.value })),
          body: item.body,
        };
        valueMap.forEach((value, name) => {
          if (!placeholders.includes(name)) return; // 用不上的列直接忽略
          request.url = applyPlaceholder(request.url, name, value);
          request.headers = request.headers.map((row) => ({
            key: applyPlaceholder(row.key, name, value),
            value: applyPlaceholder(row.value, name, value),
          }));
          request.body = applyPlaceholder(request.body, name, value);
        });

        // 替换后再按真实会发出去的内容做一遍把关
        missingInHeader.forEach((name) => {
          errors.push({ column: -1, message: `占位位置 {{${name}}} 在表头里没有对应列，替换后仍保留占位符` });
        });
        if (request.url.startsWith('/') && /\s/.test(request.url)) {
          errors.push({ column: -1, message: `替换后的目标地址里出现空白：${request.url}` });
        } else if (!request.url.startsWith('/')) {
          try {
            const parsedUrl = new URL(request.url);
            if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
              errors.push({ column: -1, message: '替换后的目标地址只支持 http 与 https 两种协议' });
            }
          } catch (err) {
            errors.push({ column: -1, message: `替换后的目标地址格式不正确：${request.url}` });
          }
        }
        if (request.body.trim() && (request.method === 'GET' || request.method === 'HEAD')) {
          errors.push({ column: -1, message: `请求方式为 ${request.method} 时不能带请求内容` });
        }
        const contentType = request.headers.find((row) => row.key.toLowerCase() === 'content-type');
        if (request.body.trim() && contentType && contentType.value.toLowerCase().includes('json')) {
          try {
            JSON.parse(request.body);
          } catch (err) {
            errors.push({ column: -1, message: `替换后的请求内容不是合法 JSON：${err.message}` });
          }
        }
      }

      const unusedHeaders = headers
        .map((name, column) => ({ name, column }))
        .filter((entry) => entry.name && !placeholders.includes(entry.name));

      preview.rows.push({
        rowNumber,
        cells,
        errors,
        blockedByHeader: hasBlockingHeader,
        request: errors.length || hasBlockingHeader ? null : request,
        unusedHeaders: hasBlockingHeader ? [] : unusedHeaders,
      });
    }

    preview.validCount = preview.rows.filter((row) => !row.errors.length && !row.blockedByHeader).length;
    preview.invalidCount = preview.rows.length - preview.validCount;
    return preview;
  }

  return {
    PLACEHOLDER_PATTERN,
    scanPlaceholders,
    applyPlaceholder,
    splitTableRow,
    parseTable,
    columnLabel,
    buildBatchPreview,
  };
});
