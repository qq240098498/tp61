// 按数据行执行的纯逻辑：占位扫描、表格解析、逐行校验与替换。
// 不依赖浏览器 DOM，既能被页面直接引用，也能在 Node 下单测。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BatchCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 占位写法：{{名字}}，名字允许中文、字母、数字、空格、下划线、中划线；首尾空格忽略
  const PLACEHOLDER_PATTERN = /\{\{\s*([^}\s][^}]*?)\s*\}\}/g;
  // 一次最多执行的数据行数，超出部分不参与并在预演里明确提示
  const MAX_BATCH_ROWS = 200;

  // 从用例的地址、请求头取值、请求内容里扫描占位，按首次出现顺序去重
  function scanPlaceholders(item) {
    const sources = [item && item.url, item && item.body];
    ((item && item.headers) || []).forEach((row) => {
      sources.push(typeof row.value === 'string' ? row.value : '');
    });
    const names = [];
    const seen = new Set();
    sources.forEach((text) => {
      if (typeof text !== 'string') return;
      PLACEHOLDER_PATTERN.lastIndex = 0;
      let match = null;
      while ((match = PLACEHOLDER_PATTERN.exec(text)) !== null) {
        const name = match[1].trim();
        if (!seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
      }
    });
    return names;
  }

  // 把粘贴内容按「一行一条记录、制表符分列」拆开，跳过完全空白的行，保留物理行号。
  // 只含空格的行也算空行；但含制表符的行保留（多列全空时要逐格报错，不能直接吞掉）
  function parseTable(rawText) {
    const lines = String(rawText || '').replace(/\r\n?/g, '\n').split('\n');
    const records = [];
    lines.forEach((line, index) => {
      if (line.trim() === '' && !line.includes('\t')) return;
      records.push({ lineNo: index + 1, cells: line.split('\t') });
    });
    return records;
  }

  // 按一行数据替换占位，得到这次真正会发出去的请求内容
  function applyRowToCase(item, values) {
    const replace = (text) => {
      if (typeof text !== 'string' || text === '') return text || '';
      return text.replace(PLACEHOLDER_PATTERN, (whole, raw) => {
        const name = raw.trim();
        return Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole;
      });
    };
    return {
      name: item.name,
      method: item.method,
      url: replace(item.url),
      headers: (item.headers || []).map((row) => ({ key: row.key, value: replace(row.value) })),
      body: item.body ? replace(item.body) : '',
    };
  }

  // 替换后的内容仍要满足发送校验：内置路径不能含空白、完整地址要合法、JSON 要能解析
  function preflightDraft(draft) {
    const url = draft.url.trim();
    if (!url) return '替换后目标地址为空';
    if (url.startsWith('/')) {
      if (/\s/.test(url)) return '替换后的目标地址里出现了空格或换行';
    } else {
      let parsed = null;
      try {
        parsed = new URL(url);
      } catch (err) {
        return '替换后的目标地址不是合法地址';
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return '替换后的目标地址只支持 http 与 https 两种协议';
      }
    }
    const contentType = draft.headers.find((row) => row.key.toLowerCase() === 'content-type');
    const isJson = contentType && contentType.value.toLowerCase().includes('json');
    if (isJson && draft.body.trim()) {
      try {
        JSON.parse(draft.body);
      } catch (err) {
        return `替换后的请求内容不是合法 JSON：${err.message}`;
      }
    }
    return '';
  }

  // 核心：把「用例 + 粘贴表格」整理成一份预演计划，逐行给出是否成立、原因与替换后的请求
  function buildBatchPlan(item, rawText) {
    const placeholders = scanPlaceholders(item);
    const records = parseTable(rawText);
    const plan = {
      placeholders,
      headerLineNo: 0,
      headers: [],
      headerProblems: [],
      missingPlaceholders: [],
      ambiguousPlaceholders: [],
      rows: [],
      validCount: 0,
      invalidCount: 0,
      ignoredTail: 0,
      fatal: '',
    };

    if (!records.length) {
      plan.fatal = '表格内容为空：请先粘贴一行表头，再在下面逐行粘贴数据';
      return plan;
    }

    if (!placeholders.length) {
      plan.fatal = '这条用例里没有可替换的占位：请先在目标地址、请求头取值或请求内容里写 {{占位名}}';
      return plan;
    }

    const headerCells = records[0].cells;
    plan.headerLineNo = records[0].lineNo;
    const headerNames = headerCells.map((cell) => cell.trim());
    const occurrence = new Map();
    headerNames.forEach((name) => {
      occurrence.set(name, (occurrence.get(name) || 0) + 1);
    });

    // 表头逐列检查：空表头、重名、用例里找不到对应占位
    headerNames.forEach((name, col) => {
      plan.headers.push({ name, col });
      if (!name) {
        plan.headerProblems.push({ col, kind: 'empty', message: `表头第 ${col + 1} 列为空，需要填写用例里的占位名` });
        return;
      }
      if (occurrence.get(name) > 1) {
        plan.headerProblems.push({ col, kind: 'duplicate', message: `表头「${name}」重名，无法确定该用哪一列的取值` });
      }
      if (!placeholders.includes(name)) {
        plan.headerProblems.push({ col, kind: 'extra', message: `表头「${name}」在用例里找不到对应的占位位置，该列不会参与发送` });
      }
    });

    // 占位 -> 唯一可用的列下标；重名或缺列的占位单独记下
    const mappedColumns = new Map();
    placeholders.forEach((name) => {
      const columns = [];
      headerNames.forEach((header, col) => {
        if (header === name) columns.push(col);
      });
      if (columns.length === 0) {
        plan.missingPlaceholders.push(name);
      } else if (columns.length > 1) {
        plan.ambiguousPlaceholders.push(name);
      } else {
        mappedColumns.set(name, columns[0]);
      }
    });

    const dataRecords = records.slice(1);
    plan.ignoredTail = Math.max(dataRecords.length - MAX_BATCH_ROWS, 0);

    dataRecords.slice(0, MAX_BATCH_ROWS).forEach((record) => {
      const cells = record.cells;
      const problems = [];

      // 列数与表头对不上：分别指出缺了哪一列、多出来哪一列
      if (cells.length < headerNames.length) {
        for (let col = cells.length; col < headerNames.length; col += 1) {
          problems.push({ col, message: `缺少对应「${headerNames[col] || '空表头'}」的这一列，该行只有 ${cells.length} 列` });
        }
      } else if (cells.length > headerNames.length) {
        for (let col = headerNames.length; col < cells.length; col += 1) {
          problems.push({ col, message: `该列多出来了，表头只定义了 ${headerNames.length} 列` });
        }
      }

      // 只检查数据行里实际存在的格子；落在行尾之外的列已在上面按缺列报过。
      // 空表头、重名、多余列在表头问题里统一说明，这些列的数据直接忽略，不连累整行作废。
      headerNames.forEach((name, col) => {
        if (col >= cells.length) return;
        const value = cells[col];
        const hasData = typeof value === 'string' && value.trim() !== '';
        if (mappedColumns.has(name) && !hasData) {
          problems.push({ col, message: `单元格为空，占位「${name}」没有取值可替换` });
        }
      });

      plan.missingPlaceholders.forEach((name) => {
        problems.push({ col: -1, message: `用例里的占位「${name}」没有对应的表头列，无法替换` });
      });
      plan.ambiguousPlaceholders.forEach((name) => {
        problems.push({ col: -1, message: `占位「${name}」对应了重名的表头列，无法确定取值` });
      });

      let draft = null;
      if (!problems.length) {
        const values = {};
        mappedColumns.forEach((col, name) => {
          values[name] = cells[col];
        });
        draft = applyRowToCase(item, values);
        const preflightError = preflightDraft(draft);
        if (preflightError) problems.push({ col: -1, message: preflightError });
      }

      const valid = problems.length === 0;
      plan.rows.push({ key: record.lineNo, lineNo: record.lineNo, cells, problems, valid, draft });
      if (valid) plan.validCount += 1;
      else plan.invalidCount += 1;
    });

    return plan;
  }

  return {
    PLACEHOLDER_PATTERN,
    MAX_BATCH_ROWS,
    scanPlaceholders,
    parseTable,
    applyRowToCase,
    preflightDraft,
    buildBatchPlan,
  };
});
