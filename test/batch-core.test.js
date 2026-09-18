// 按数据行执行预演逻辑的校验：直接 require 前端纯逻辑，不经过浏览器
// 运行：node test/batch-core.test.js
const assert = require('assert');
const {
  scanPlaceholders,
  buildBatchPreview,
  columnLabel,
} = require('../public/batch-core.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.stack}`);
    process.exitCode = 1;
  }
}

// 用例：地址、请求头取值、JSON 请求内容里各放一个占位位置
const item = {
  name: '模板用例',
  method: 'POST',
  url: '/demo/items?page={{page}}',
  headers: [
    { key: 'Content-Type', value: 'application/json' },
    { key: 'X-Trace', value: 'trace-{{traceId}}' },
  ],
  body: '{\n  "sku": "{{sku}}"\n}',
};

test('扫描占位位置：按出现顺序去重', () => {
  assert.deepStrictEqual(scanPlaceholders(item), ['page', 'traceId', 'sku']);
  // 占位两侧允许空格
  assert.deepStrictEqual(scanPlaceholders({ url: '/x?a={{ a }}&b={{a}}', headers: [], body: '' }), ['a']);
});

test('列号用 A、B、C… 表示，超过 26 列进位', () => {
  assert.strictEqual(columnLabel(0), 'A');
  assert.strictEqual(columnLabel(25), 'Z');
  assert.strictEqual(columnLabel(26), 'AA');
});

test('全部成立：逐行替换出真实地址、请求头与请求内容', () => {
  const table = ['page\ttraceId\tsku', '1\tt-1\tSKU-甲', '2\tt-2\tSKU-乙'].join('\n');
  const preview = buildBatchPreview(item, table);
  assert.strictEqual(preview.rows.length, 2);
  assert.strictEqual(preview.validCount, 2);
  assert.strictEqual(preview.invalidCount, 0);
  assert.strictEqual(preview.rows[0].rowNumber, 2); // 含表头
  assert.strictEqual(preview.rows[0].request.url, '/demo/items?page=1');
  assert.strictEqual(preview.rows[0].request.headers[1].value, 'trace-t-1');
  assert.strictEqual(preview.rows[0].request.body, '{\n  "sku": "SKU-甲"\n}');
  // 替换后的 JSON 仍能解析
  JSON.parse(preview.rows[1].request.body);
  assert.strictEqual(preview.rows[1].request.url, '/demo/items?page=2');
});

test('情形一：某一格为空 -> 该行不成立并指出第几行第几列，其余行照常成立', () => {
  const table = ['page\ttraceId\tsku', '1\tt-1\tSKU-甲', '2\tt-2\t'].join('\n');
  const preview = buildBatchPreview(item, table);
  assert.strictEqual(preview.validCount, 1);
  assert.strictEqual(preview.invalidCount, 1);
  const bad = preview.rows[1];
  assert.strictEqual(bad.rowNumber, 3);
  assert.strictEqual(bad.request, null);
  const cellError = bad.errors.find((e) => e.column === 2); // 第 C 列 sku 为空
  assert.ok(cellError, '应定位到第 3 行第 C 列');
  assert.match(cellError.message, /sku/);
  // 第一行仍然成立，没被一行错误连坐
  assert.strictEqual(preview.rows[0].request.url, '/demo/items?page=1');
});

test('情形二：行的列数与表头对不上 -> 指出不成立，其余行照常成立', () => {
  const table = ['page\ttraceId\tsku', '1\tt-1\tSKU-甲', '2\tt-2'].join('\n'); // 第三行少一列
  const preview = buildBatchPreview(item, table);
  assert.strictEqual(preview.validCount, 1);
  const bad = preview.rows[1];
  assert.strictEqual(bad.rowNumber, 3);
  assert.ok(bad.errors.some((e) => e.column === -1 && /2 列/.test(e.message) && /3 列/.test(e.message)));
  assert.strictEqual(bad.request, null);
  assert.ok(preview.rows[0].request);
});

test('情形三：表头名字找不到占位位置 -> 表头警告指出列，但不影响对应行成立', () => {
  const table = ['page\ttraceId\tsku\textra', '1\tt-1\tSKU-甲\t无关值'].join('\n');
  const preview = buildBatchPreview(item, table);
  // 多出来的列在表头与数据里列数一致，不应判行不成立
  assert.strictEqual(preview.invalidCount, 0);
  assert.strictEqual(preview.validCount, 1);
  const warn = preview.headerWarnings.find((e) => e.column === 3);
  assert.ok(warn, '应在第 D 列给出找不到占位位置的警告');
  assert.match(warn.message, /extra/);
  // 用不上的列在行卡片上也有提示
  assert.deepStrictEqual(preview.rows[0].unusedHeaders.map((e) => e.name), ['extra']);
  assert.strictEqual(preview.rows[0].request.body, '{\n  "sku": "SKU-甲"\n}');
});

test('情形四：表头重名 -> 数据行全部不成立，并指出重复出现在哪几列', () => {
  const table = ['page\tpage\tsku', '1\t9\tSKU-甲', '2\t8\tSKU-乙'].join('\n');
  const preview = buildBatchPreview(item, table);
  assert.strictEqual(preview.validCount, 0);
  assert.strictEqual(preview.invalidCount, 2);
  const dup = preview.headerBlocking.find((e) => /page/.test(e.message));
  assert.ok(dup, '应给出 page 重名的表头致命问题');
  assert.match(dup.message, /A、B/);
  preview.rows.forEach((row) => {
    assert.strictEqual(row.request, null);
    assert.strictEqual(row.blockedByHeader, true);
  });
});

test('空表头：表头警告指出列；对应数据格不参与空值判定', () => {
  const table = ['page\ttraceId\t', '1\tt-1\t'].join('\n'); // 第三列表头为空
  const preview = buildBatchPreview(item, table);
  // sku 占位位置缺列 -> 替换后仍含占位符，行不成立（原因是缺列而非空格）
  assert.strictEqual(preview.validCount, 0);
  assert.ok(preview.headerWarnings.some((e) => e.column === 2 && /没有写名字/.test(e.message)));
  assert.ok(preview.rows[0].errors.some((e) => /\{\{sku\}\}/.test(e.message)));
});

test('替换后 JSON 不合法：取值含未转义引号时该行不成立', () => {
  const table = ['page\ttraceId\tsku', '1\tt-1\tA"B'].join('\n');
  const preview = buildBatchPreview(item, table);
  assert.strictEqual(preview.validCount, 0);
  assert.ok(preview.rows[0].errors.some((e) => /合法 JSON/.test(e.message)));
});

test('占位位置缺少对应表头列：替换后仍保留占位符，该行不成立', () => {
  const table = ['page\tsku', '1\tSKU-甲'].join('\n'); // 缺 traceId
  const preview = buildBatchPreview(item, table);
  assert.strictEqual(preview.validCount, 0);
  assert.ok(preview.rows[0].errors.some((e) => /traceId/.test(e.message)));
});

test('支持逗号 CSV 与引号包裹', () => {
  const table = 'page,traceId,sku\n1,t-1,"SKU,带逗号"';
  const preview = buildBatchPreview(item, table);
  assert.strictEqual(preview.validCount, 1);
  assert.strictEqual(preview.rows[0].request.body, '{\n  "sku": "SKU,带逗号"\n}');
});

console.log(`\n共 ${passed} 条用例通过`);
