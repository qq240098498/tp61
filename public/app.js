(function () {
  'use strict';

  // 页面状态：用例列表、内置示例接口、请求头草稿行、最近一次响应结果与结果视图
  const state = {
    cases: [],
    selectedId: '',
    headers: [{ key: '', value: '' }],
    demos: [],
    busy: false,
    result: null,
    resultView: 'structured',
    // 按数据行执行：最近一次预演计划、逐行执行结果与执行中标记
    batch: {
      plan: null,
      results: {},
      running: false,
    },
  };

  const dom = {
    health: document.getElementById('health-badge'),
    notice: document.getElementById('notice'),
    name: document.getElementById('field-name'),
    method: document.getElementById('field-method'),
    url: document.getElementById('field-url'),
    body: document.getElementById('field-body'),
    headerRows: document.getElementById('header-rows'),
    addHeader: document.getElementById('add-header'),
    demos: document.getElementById('demo-list'),
    demoSummary: document.getElementById('demo-summary'),
    sendRequest: document.getElementById('send-request'),
    saveCase: document.getElementById('save-case'),
    resetDraft: document.getElementById('reset-draft'),
    resultBody: document.getElementById('result-body'),
    resultSummary: document.getElementById('result-summary'),
    clearResult: document.getElementById('clear-result'),
    caseList: document.getElementById('case-list'),
    caseSummary: document.getElementById('case-summary'),
    refreshCases: document.getElementById('refresh-cases'),
    caseDetail: document.getElementById('case-detail'),
    closeDetail: document.getElementById('close-detail'),
    batchPanel: document.getElementById('batch-panel'),
    batchCase: document.getElementById('batch-case'),
    batchPlaceholderHint: document.getElementById('batch-placeholder-hint'),
    batchCaseMeta: document.getElementById('batch-case-meta'),
    batchTable: document.getElementById('batch-table'),
    batchSample: document.getElementById('batch-sample'),
    batchPreview: document.getElementById('batch-preview'),
    batchRun: document.getElementById('batch-run'),
    batchClear: document.getElementById('batch-clear'),
    batchPreviewArea: document.getElementById('batch-preview-area'),
  };

  const emptyDetailHint = '在用例列表点「详情」，这里显示该用例保存下来的目标地址、请求头与请求内容。';
  // 结构化视图最多铺开的层级条目数量，避免内容过大时页面卡顿
  const TREE_LIMIT = 800;
  let noticeTimer = 0;

  // ---------------- 后端交互 ----------------

  // 统一请求入口：把服务端返回的错误码与出错位置打包进异常对象
  async function request(path, options) {
    const config = options || {};
    const init = { method: config.method || 'GET' };
    if (config.body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(config.body);
    }

    let response = null;
    try {
      response = await fetch(path, init);
    } catch (err) {
      const error = new Error('无法连接服务，请确认服务已启动');
      error.code = 'NETWORK_ERROR';
      error.field = '';
      throw error;
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      payload = null;
    }

    if (!response.ok) {
      const info = (payload && payload.error) || {};
      const error = new Error(info.message || `操作失败（状态码 ${response.status}）`);
      error.code = info.code || 'request_failed';
      error.field = typeof info.field === 'string' ? info.field : '';
      throw error;
    }
    return payload;
  }

  function setBusy(busy, activeAction) {
    state.busy = busy;
    dom.sendRequest.disabled = busy;
    dom.saveCase.disabled = busy;
    dom.resetDraft.disabled = busy;
    dom.refreshCases.disabled = busy;
    dom.batchCase.disabled = busy || state.batch.running;
    dom.batchTable.disabled = busy || state.batch.running;
    dom.batchPreview.disabled = busy;
    dom.batchRun.disabled = busy || state.batch.running;
    dom.batchSample.disabled = busy;
    dom.batchClear.disabled = busy;
    dom.sendRequest.textContent = busy && activeAction === 'send' ? '发送中…' : '发送请求';
    dom.saveCase.textContent = busy && activeAction === 'save' ? '正在保存…' : '保存为用例';
  }

  // ---------------- 页面消息与出错标记 ----------------

  function showNotice(message, type) {
    dom.notice.textContent = message;
    dom.notice.className = `notice notice-${type || 'info'}`;
    dom.notice.hidden = false;
    window.clearTimeout(noticeTimer);
    const stay = type === 'error' ? 6000 : 3500;
    noticeTimer = window.setTimeout(() => {
      dom.notice.hidden = true;
    }, stay);
  }

  function clearFieldErrors() {
    document.querySelectorAll('.field-error').forEach((node) => {
      node.hidden = true;
      node.textContent = '';
    });
    [dom.name, dom.url, dom.body, dom.headerRows].forEach((node) => node.classList.remove('invalid'));
  }

  // 服务端给出的位置可能是 headers.2.key 这种形式，标记时按区块归位
  function normalizeField(field) {
    if (typeof field !== 'string' || !field) return '';
    const key = field.split('.')[0];
    return ['name', 'method', 'url', 'headers', 'body'].includes(key) ? key : '';
  }

  function showFieldError(field, message) {
    const key = normalizeField(field);
    if (!key) return;
    const slot = document.querySelector(`[data-error="${key}"]`);
    if (slot) {
      slot.textContent = message;
      slot.hidden = false;
    }
    const target = {
      name: dom.name,
      method: dom.method,
      url: dom.url,
      headers: dom.headerRows,
      body: dom.body,
    }[key];
    if (target) target.classList.add('invalid');
  }

  // ---------------- 请求区 ----------------

  function renderHeaderRows() {
    dom.headerRows.textContent = '';
    if (!state.headers.length) {
      const empty = document.createElement('p');
      empty.className = 'rows-empty';
      empty.textContent = '暂无请求头';
      dom.headerRows.appendChild(empty);
      return;
    }

    state.headers.forEach((row, index) => {
      const line = document.createElement('div');
      line.className = 'header-row';

      const keyInput = document.createElement('input');
      keyInput.type = 'text';
      keyInput.className = 'header-key';
      keyInput.value = row.key;
      keyInput.autocomplete = 'off';
      keyInput.dataset.index = String(index);
      keyInput.dataset.part = 'key';
      keyInput.setAttribute('aria-label', `第 ${index + 1} 行请求头名称`);

      const valueInput = document.createElement('input');
      valueInput.type = 'text';
      valueInput.className = 'header-value';
      valueInput.value = row.value;
      valueInput.autocomplete = 'off';
      valueInput.dataset.index = String(index);
      valueInput.dataset.part = 'value';
      valueInput.setAttribute('aria-label', `第 ${index + 1} 行请求头取值`);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-ghost btn-small';
      remove.textContent = '删除';
      remove.dataset.action = 'remove-header';
      remove.dataset.index = String(index);

      line.append(keyInput, valueInput, remove);
      dom.headerRows.appendChild(line);
    });
  }

  function collectDraft() {
    return {
      name: dom.name.value.trim(),
      method: dom.method.value,
      url: dom.url.value.trim(),
      headers: state.headers.map((row) => ({ key: row.key.trim(), value: row.value })),
      body: dom.body.value,
    };
  }

  // 把一份请求内容写回表单，既用于示例接口填入，也用于用例回填
  function fillDraft(draft) {
    dom.name.value = typeof draft.name === 'string' ? draft.name : '';
    dom.method.value = draft.method || 'GET';
    dom.url.value = draft.url || '';
    dom.body.value = typeof draft.body === 'string' ? draft.body : '';
    state.headers = Array.isArray(draft.headers) && draft.headers.length
      ? draft.headers.map((row) => ({
          key: typeof row.key === 'string' ? row.key : '',
          value: typeof row.value === 'string' ? row.value : '',
        }))
      : [{ key: '', value: '' }];
    renderHeaderRows();
    clearFieldErrors();
  }

  function resetDraft(silent) {
    fillDraft({ name: '', method: 'GET', url: '', headers: [], body: '' });
    if (!silent) showNotice('草稿已清空', 'info');
  }

  // ---------------- 内置示例接口 ----------------

  async function loadDemos() {
    try {
      const data = await request('/api/demos');
      state.demos = data && Array.isArray(data.endpoints) ? data.endpoints : [];
    } catch (err) {
      state.demos = [];
    }
    renderDemos();
  }

  function renderDemos() {
    dom.demos.textContent = '';
    if (!state.demos.length) {
      dom.demoSummary.textContent = '读取失败';
      const hint = document.createElement('p');
      hint.className = 'rows-empty';
      hint.textContent = '内置示例接口暂时读取不到，可以直接在目标地址里填写完整地址';
      dom.demos.appendChild(hint);
      return;
    }

    dom.demoSummary.textContent = `共 ${state.demos.length} 个`;
    state.demos.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'demo-item';

      const main = document.createElement('div');
      main.className = 'demo-main';

      const title = document.createElement('div');
      title.className = 'demo-title';
      const nameNode = document.createElement('span');
      nameNode.className = 'demo-name';
      nameNode.textContent = item.name;
      title.append(nameNode, buildTag(item.method, item.method === 'GET' ? 'get' : 'any'));

      const pathNode = document.createElement('p');
      pathNode.className = 'demo-path';
      pathNode.textContent = item.path;

      const summaryNode = document.createElement('p');
      summaryNode.className = 'demo-summary';
      summaryNode.textContent = item.summary;

      main.append(title, pathNode, summaryNode);

      const fill = document.createElement('button');
      fill.type = 'button';
      fill.className = 'btn btn-small';
      fill.textContent = '填入请求区';
      fill.addEventListener('click', () => {
        fillDraft(item.example);
        state.selectedId = '';
        renderCases();
        showNotice(`已把「${item.name}」填入请求区，点发送请求即可看到结果`, 'info');
      });

      row.append(main, fill);
      dom.demos.appendChild(row);
    });
  }

  // ---------------- 发送请求与结果展示 ----------------

  async function sendRequest() {
    if (state.busy) return;
    clearFieldErrors();

    const draft = collectDraft();
    if (!draft.url) {
      showFieldError('url', '请填写目标地址');
      showNotice('请填写目标地址', 'error');
      dom.url.focus();
      return;
    }
    if (draft.body.trim() && (draft.method === 'GET' || draft.method === 'HEAD')) {
      showFieldError('body', `请求方式为 ${draft.method} 时不带请求内容，请清空请求内容或更换请求方式`);
      showNotice('请求方式与请求内容不匹配，请调整后再发送', 'error');
      return;
    }

    setBusy(true, 'send');
    renderResultPending(draft);
    try {
      const result = await request('/api/send', { method: 'POST', body: draft });
      state.result = result;
      renderResult(result);
      if (result.ok) {
        showNotice(`请求已完成：状态码 ${result.status}，耗时 ${formatDuration(result.timeMs)}`, 'success');
      } else {
        showNotice(`请求失败：${result.failure.reason}`, 'error');
      }
    } catch (err) {
      state.result = null;
      if (err.field) showFieldError(err.field, err.message);
      dom.resultSummary.textContent = '';
      dom.resultBody.textContent = '';
      dom.clearResult.hidden = false;
      dom.resultBody.appendChild(buildFailurePanel('这次请求没有发出去', err.message, ''));
      showNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function renderResultPending(draft) {
    dom.resultSummary.textContent = '正在等待响应';
    dom.clearResult.hidden = true;
    dom.resultBody.textContent = '';

    const block = document.createElement('div');
    block.className = 'result-pending';
    const title = document.createElement('p');
    title.className = 'pending-title';
    title.textContent = '请求已发出，正在等待响应…';
    const sub = document.createElement('p');
    sub.className = 'empty-sub';
    sub.textContent = `${draft.method} ${draft.url} 已按照填写的内容发出去，收到回应后这里会显示状态、耗时、响应头与响应内容。`;
    block.append(title, sub);
    dom.resultBody.appendChild(block);
  }

  function renderEmptyResult() {
    dom.resultSummary.textContent = '';
    dom.clearResult.hidden = true;
    dom.resultBody.textContent = '';
    dom.resultBody.appendChild(
      buildEmptyBlock(
        '还没有发送过请求',
        '填好请求方式与目标地址后点「发送请求」，这里会显示响应状态、耗时、响应头与响应内容。'
      )
    );
  }

  function renderResult(result) {
    dom.resultBody.textContent = '';
    dom.clearResult.hidden = false;

    const head = document.createElement('div');
    head.className = 'result-head';

    if (result.ok) {
      head.appendChild(buildStatusBadge(result.status, result.statusText));
      head.appendChild(buildChip(`耗时 ${formatDuration(result.timeMs)}`));
      head.appendChild(buildChip(`内容 ${formatBytes(result.size)}`));
      // 状态码落在 400 及以上时，页面同样按失败口径提醒
      if (result.status >= 400) head.appendChild(buildChip('本次响应为失败状态', 'chip-bad'));
      dom.resultSummary.textContent = `最近一次：${result.status} ${result.statusText}`.trim();
    } else {
      head.appendChild(buildStatusBadge(0, '未完成'));
      head.appendChild(buildChip(`已等待 ${formatDuration(result.timeMs)}`));
      dom.resultSummary.textContent = '最近一次：请求未完成';
    }
    dom.resultBody.appendChild(head);

    const targetLine = document.createElement('p');
    targetLine.className = 'result-target';
    targetLine.textContent = result.internal
      ? `目标地址（本机内置示例接口）：${result.targetUrl}`
      : `目标地址：${result.targetUrl}`;
    dom.resultBody.appendChild(targetLine);

    if (!result.ok) {
      dom.resultBody.appendChild(
        buildFailurePanel('请求没有完成', result.failure.reason, result.failure.detail)
      );
      return;
    }

    const headerSection = buildSection('响应头');
    if (result.headers.length) {
      headerSection.appendChild(buildHeaderTable(result.headers));
    } else {
      headerSection.appendChild(buildTextNote('本次响应没有返回响应头'));
    }
    dom.resultBody.appendChild(headerSection);

    const bodySection = buildSection('响应内容');
    bodySection.appendChild(buildBodyView(result));
    dom.resultBody.appendChild(bodySection);
  }

  function buildFailurePanel(title, reason, detail) {
    const panel = document.createElement('div');
    panel.className = 'failure-panel';

    const titleNode = document.createElement('p');
    titleNode.className = 'failure-title';
    titleNode.textContent = title;

    const reasonNode = document.createElement('p');
    reasonNode.className = 'failure-reason';
    reasonNode.textContent = `失败原因：${reason}`;

    panel.append(titleNode, reasonNode);

    if (detail) {
      const detailNode = document.createElement('p');
      detailNode.className = 'failure-detail';
      detailNode.textContent = `详细信息：${detail}`;
      panel.appendChild(detailNode);
    }
    return panel;
  }

  function buildBodyView(result) {
    const wrap = document.createElement('div');
    wrap.className = 'body-view';

    const text = typeof result.body === 'string' ? result.body : '';
    if (!text.trim()) {
      wrap.appendChild(buildTextNote(result.status === 204 ? '本次响应为成功且没有返回内容' : '本次响应没有返回内容'));
      return wrap;
    }

    const tabs = document.createElement('div');
    tabs.className = 'view-tabs';
    tabs.append(
      buildTab('结构化', state.resultView === 'structured', () => switchResultView('structured')),
      buildTab('原始文本', state.resultView === 'raw', () => switchResultView('raw'))
    );
    wrap.appendChild(tabs);

    const parsed = tryParseJson(text);
    if (state.resultView === 'raw') {
      wrap.appendChild(buildPre(text));
    } else if (parsed.ok) {
      wrap.appendChild(buildJsonTree(parsed.value, '', { left: TREE_LIMIT }));
    } else {
      wrap.appendChild(buildTextNote('响应内容不是结构化数据，已按文本显示'));
      wrap.appendChild(buildPre(text));
    }

    if (result.truncated) {
      wrap.appendChild(buildTextNote('响应内容较大，这里只保留了开头的一部分用于展示'));
    }
    return wrap;
  }

  function switchResultView(view) {
    state.resultView = view;
    if (state.result) renderResult(state.result);
  }

  function tryParseJson(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (err) {
      return { ok: false, value: null };
    }
  }

  function buildPre(text) {
    const pre = document.createElement('pre');
    pre.className = 'result-pre';
    pre.textContent = text;
    return pre;
  }

  // 结构化视图：对象与数组逐层铺开，取值按类型区分显示
  function buildJsonTree(value, label, counter) {
    counter.left -= 1;
    const node = document.createElement('div');
    node.className = 'json-node';

    if (value !== null && typeof value === 'object') {
      const isArray = Array.isArray(value);
      const keys = isArray ? value.map((_, index) => index) : Object.keys(value);

      const head = document.createElement('div');
      head.className = 'json-line';
      head.appendChild(buildJsonKey(label));
      head.appendChild(buildJsonTag(`${isArray ? '数组' : '对象'} ${keys.length} 项`));
      node.appendChild(head);

      const children = document.createElement('div');
      children.className = 'json-children';

      if (!keys.length) {
        children.appendChild(buildJsonLine('', isArray ? '空数组' : '空对象', 'empty'));
      } else {
        let shown = 0;
        for (let index = 0; index < keys.length; index += 1) {
          if (counter.left <= 0) break;
          const key = keys[index];
          children.appendChild(
            buildJsonTree(value[key], isArray ? `[${key}]` : String(key), counter)
          );
          shown += 1;
        }
        if (shown < keys.length) {
          children.appendChild(buildTextNote(`还有 ${keys.length - shown} 项未展开，可切换到原始文本查看完整内容`));
        }
      }

      node.appendChild(children);
      return node;
    }

    node.appendChild(buildJsonLine(label, describePrimitive(value), primitiveKind(value)));
    return node;
  }

  function buildJsonLine(label, text, kind) {
    const line = document.createElement('div');
    line.className = 'json-line';
    if (label) line.appendChild(buildJsonKey(label));
    const valueNode = document.createElement('span');
    valueNode.className = `json-value json-${kind}`;
    valueNode.textContent = text;
    line.appendChild(valueNode);
    return line;
  }

  function buildJsonKey(label) {
    const key = document.createElement('span');
    key.className = 'json-key';
    key.textContent = label || '整体内容';
    return key;
  }

  function buildJsonTag(text) {
    const tag = document.createElement('span');
    tag.className = 'json-tag';
    tag.textContent = text;
    return tag;
  }

  function describePrimitive(value) {
    if (value === null) return 'null';
    if (typeof value === 'string') return `"${value}"`;
    return String(value);
  }

  function primitiveKind(value) {
    if (value === null) return 'null';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    return 'string';
  }

  // ---------------- 用例区 ----------------

  async function loadCases() {
    const list = await request('/api/cases');
    state.cases = Array.isArray(list) ? list : [];
    if (state.selectedId && !state.cases.some((item) => item.id === state.selectedId)) {
      state.selectedId = '';
    }
    renderCases();
  }

  function renderCases() {
    dom.caseSummary.textContent = `共 ${state.cases.length} 条`;
    dom.caseList.textContent = '';

    if (!state.cases.length) {
      dom.caseList.appendChild(
        buildEmptyBlock('还没有保存过用例', '在请求区填好内容后点「保存为用例」，用例会出现在这里。')
      );
      return;
    }
    state.cases.forEach((item) => {
      dom.caseList.appendChild(buildCaseRow(item));
    });

    renderBatchCaseOptions();
    renderBatchCaseHint();
    // 用例被删除后，预演计划如果指向的用例已经不存在，就一并作废
    if (state.batch.plan && !state.cases.some((item) => item.id === state.batch.plan.caseId)) {
      clearBatchPlan();
    }
  }

  function buildEmptyBlock(title, subtitle) {
    const block = document.createElement('div');
    block.className = 'empty';
    const titleNode = document.createElement('p');
    titleNode.className = 'empty-title';
    titleNode.textContent = title;
    const subNode = document.createElement('p');
    subNode.className = 'empty-sub';
    subNode.textContent = subtitle;
    block.append(titleNode, subNode);
    return block;
  }

  function buildTextNote(text) {
    const note = document.createElement('p');
    note.className = 'text-note';
    note.textContent = text;
    return note;
  }

  function buildTag(text, kind) {
    const tag = document.createElement('span');
    tag.className = `method method-${kind || 'any'}`;
    tag.textContent = text;
    return tag;
  }

  function buildCaseRow(item) {
    const row = document.createElement('article');
    row.className = 'case-item';
    if (item.id === state.selectedId) row.classList.add('active');

    const main = document.createElement('div');
    main.className = 'case-main';

    const title = document.createElement('div');
    title.className = 'case-title';
    const nameNode = document.createElement('span');
    nameNode.className = 'case-name';
    nameNode.textContent = item.name;
    title.append(buildTag(item.method, String(item.method).toLowerCase()), nameNode);
    if (item.url.startsWith('/')) title.appendChild(buildTag('内置', 'inner'));

    const urlNode = document.createElement('p');
    urlNode.className = 'case-url';
    urlNode.textContent = item.url;

    const metaNode = document.createElement('p');
    metaNode.className = 'case-meta';
    metaNode.textContent = `请求头 ${item.headers.length} 行 · 保存于 ${formatTime(item.createdAt)}`;

    main.append(title, urlNode, metaNode);

    const actions = document.createElement('div');
    actions.className = 'case-actions';

    const fillButton = document.createElement('button');
    fillButton.type = 'button';
    fillButton.className = 'btn btn-small';
    fillButton.textContent = '回填';
    fillButton.addEventListener('click', () => {
      applyCase(item);
    });

    const viewButton = document.createElement('button');
    viewButton.type = 'button';
    viewButton.className = 'btn btn-small';
    viewButton.textContent = '详情';
    viewButton.addEventListener('click', () => {
      openDetail(item.id);
    });

    const batchButton = document.createElement('button');
    batchButton.type = 'button';
    batchButton.className = 'btn btn-small';
    batchButton.textContent = '按行执行';
    batchButton.addEventListener('click', () => {
      jumpToBatch(item);
    });

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn btn-small btn-danger';
    deleteButton.textContent = '删除';
    deleteButton.addEventListener('click', () => {
      removeCase(item);
    });

    actions.append(fillButton, viewButton, batchButton, deleteButton);
    row.append(main, actions);
    return row;
  }

  // 回填：把用例保存下来的内容写回请求区，可以直接点发送请求重发一次
  function applyCase(item) {
    if (state.busy || state.batch.running) return;
    fillDraft(item);
    state.selectedId = item.id;
    renderCases();
    renderDetail(item);
    showNotice(`用例「${item.name}」已回填到请求区，可直接点发送请求`, 'success');
  }

  async function openDetail(id) {
    if (state.busy || state.batch.running) return;
    try {
      const item = await request(`/api/cases/${encodeURIComponent(id)}`);
      state.selectedId = item.id;
      renderCases();
      renderDetail(item);
    } catch (err) {
      showNotice(err.message, 'error');
      if (err.code === 'CASE_NOT_FOUND') {
        state.selectedId = '';
        renderEmptyDetail();
        try {
          await loadCases();
        } catch (reloadError) {
          showNotice(reloadError.message, 'error');
        }
      }
    }
  }

  function renderDetail(item) {
    dom.caseDetail.textContent = '';

    const head = document.createElement('div');
    head.className = 'detail-head';
    const nameNode = document.createElement('h3');
    nameNode.textContent = item.name;
    head.append(buildTag(item.method, String(item.method).toLowerCase()), nameNode);

    const fillButton = document.createElement('button');
    fillButton.type = 'button';
    fillButton.className = 'btn btn-small';
    fillButton.textContent = '回填到请求区';
    fillButton.addEventListener('click', () => {
      applyCase(item);
    });
    head.appendChild(fillButton);

    dom.caseDetail.append(head);
    dom.caseDetail.append(buildDetailRow('目标地址', item.url, false));
    dom.caseDetail.append(
      buildDetailRow(
        '请求头',
        item.headers.length ? item.headers.map((row) => `${row.key}: ${row.value}`).join('\n') : '暂无内容',
        true
      )
    );
    dom.caseDetail.append(buildDetailRow('请求内容', item.body || '暂无内容', true));
    dom.caseDetail.append(
      buildDetailRow('保存时间', `${formatTime(item.createdAt)}（最近更新 ${formatTime(item.updatedAt)}）`, false)
    );
    dom.closeDetail.hidden = false;
  }

  function buildDetailRow(label, text, block) {
    const wrap = document.createElement('div');
    wrap.className = 'detail-row';

    const labelNode = document.createElement('span');
    labelNode.className = 'detail-label';
    labelNode.textContent = label;

    const valueNode = document.createElement(block ? 'pre' : 'p');
    valueNode.className = 'detail-value';
    valueNode.textContent = text;

    wrap.append(labelNode, valueNode);
    return wrap;
  }

  function renderEmptyDetail() {
    dom.closeDetail.hidden = true;
    dom.caseDetail.textContent = '';
    const subNode = document.createElement('p');
    subNode.className = 'empty-sub';
    subNode.textContent = emptyDetailHint;
    dom.caseDetail.appendChild(subNode);
  }

  // ---------------- 保存与删除 ----------------

  async function saveCase() {
    if (state.busy) return;
    clearFieldErrors();

    const draft = collectDraft();
    if (!draft.name) {
      showFieldError('name', '请填写用例名称');
      showNotice('请填写用例名称', 'error');
      dom.name.focus();
      return;
    }
    if (!draft.url) {
      showFieldError('url', '请填写目标地址');
      showNotice('请填写目标地址', 'error');
      dom.url.focus();
      return;
    }

    setBusy(true, 'save');
    try {
      const created = await request('/api/cases', { method: 'POST', body: draft });
      state.selectedId = created.id;
      await loadCases();
      renderDetail(created);
      showNotice(`用例「${created.name}」已保存，请求区内容保留可直接发送`, 'success');
    } catch (err) {
      if (err.field) showFieldError(err.field, err.message);
      showNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function removeCase(item) {
    if (state.busy || state.batch.running) return;
    const confirmed = window.confirm(`确认删除用例「${item.name}」？删除后无法恢复。`);
    if (!confirmed) return;

    setBusy(true);
    try {
      await request(`/api/cases/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      if (state.selectedId === item.id) state.selectedId = '';
      await loadCases();
      if (!state.selectedId) renderEmptyDetail();
      showNotice(`用例「${item.name}」已删除`, 'success');
    } catch (err) {
      showNotice(err.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  // ---------------- 按数据行执行 ----------------

  // 占位扫描、表格解析、逐行校验与替换的纯逻辑在 batch.js，浏览器与 Node 自测共用一份
  const { scanPlaceholders, buildBatchPlan } = window.BatchCore;

  function getSelectedBatchCase() {
    return state.cases.find((item) => item.id === dom.batchCase.value) || null;
  }

  function renderBatchCaseOptions() {
    const current = dom.batchCase.value;
    dom.batchCase.textContent = '';
    if (!state.cases.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '还没有可用用例，请先在请求区保存';
      dom.batchCase.appendChild(option);
      dom.batchRun.disabled = true;
      return;
    }
    state.cases.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = `${item.method} ${item.name}`;
      dom.batchCase.appendChild(option);
    });
    if (current && state.cases.some((item) => item.id === current)) {
      dom.batchCase.value = current;
    }
  }

  function renderBatchCaseHint() {
    const item = getSelectedBatchCase();
    dom.batchCaseMeta.textContent = '';
    if (!item) {
      dom.batchPlaceholderHint.textContent = '保存至少一条用例后，才能按数据行执行';
      return;
    }
    const names = scanPlaceholders(item);
    if (!names.length) {
      dom.batchPlaceholderHint.textContent = '这条用例里还没有占位：可在目标地址、请求头取值或请求内容里写成 {{占位名}}，表头里的名字要与它一致';
    } else {
      dom.batchPlaceholderHint.textContent = `这条用例里共有 ${names.length} 个占位：${names.map((name) => `{{${name}}}`).join('、')}`;
    }
    const meta = document.createElement('span');
    meta.className = 'batch-meta-text';
    meta.textContent = `${item.method} ${item.url}`;
    dom.batchCaseMeta.appendChild(meta);
  }

  function clearBatchPlan() {
    state.batch.plan = null;
    state.batch.results = {};
    dom.batchPreviewArea.hidden = true;
    dom.batchPreviewArea.textContent = '';
    dom.batchRun.disabled = true;
    dom.batchRun.textContent = '按有效行执行（0 行）';
  }

  function previewBatch() {
    if (state.batch.running) return;
    const item = getSelectedBatchCase();
    if (!item) {
      showNotice('请先选择一条用例', 'error');
      return;
    }
    if (!scanPlaceholders(item).length) {
      showNotice('这条用例里还没有占位，请先在地址、请求头取值或请求内容里写 {{占位名}}', 'error');
      return;
    }
    state.batch.plan = buildBatchPlan(item, dom.batchTable.value);
    state.batch.plan.caseId = item.id;
    state.batch.results = {};
    renderBatchPlan();
  }

  function renderBatchPlan() {
    const plan = state.batch.plan;
    const area = dom.batchPreviewArea;
    area.hidden = false;
    area.textContent = '';

    if (!plan) {
      area.appendChild(buildTextNote('粘贴表格后点「预演」，这里会列出每一行替换后实际发出的内容'));
      return;
    }
    if (plan.fatal) {
      dom.batchRun.disabled = true;
      dom.batchRun.textContent = '按有效行执行（0 行）';
      area.appendChild(buildFailurePanel('无法预演', plan.fatal, ''));
      return;
    }

    // 汇总：总共几行、有效几行、无效几行、表头有哪些问题
    const summary = document.createElement('div');
    summary.className = 'batch-summary';
    summary.appendChild(buildChip(`数据行 ${plan.rows.length} 行`));
    summary.appendChild(buildChip(`可执行 ${plan.validCount} 行`, plan.validCount ? 'chip-ok' : ''));
    summary.appendChild(buildChip(`不成立 ${plan.invalidCount} 行`, plan.invalidCount ? 'chip-bad' : ''));
    if (plan.ignoredTail) {
      summary.appendChild(buildChip(`超出上限未参与 ${plan.ignoredTail} 行`, 'chip-bad'));
    }
    area.appendChild(summary);

    const headerProblems = plan.headerProblems.map((problem) => {
      const line = document.createElement('li');
      line.textContent = problem.message;
      return line;
    });
    plan.missingPlaceholders.forEach((name) => {
      const line = document.createElement('li');
      line.textContent = `用例缺少表头列：占位「${name}」在表格里找不到同名表头，所有数据行都无法补全这个位置`;
      headerProblems.push(line);
    });
    if (headerProblems.length) {
      const block = document.createElement('div');
      block.className = 'batch-header-problems';
      const title = document.createElement('p');
      title.className = 'batch-problem-title';
      title.textContent = `表头本身存在 ${headerProblems.length} 处问题（表头位于粘贴内容第 ${plan.headerLineNo} 行）：`;
      const list = document.createElement('ul');
      headerProblems.forEach((node) => list.appendChild(node));
      block.append(title, list);
      area.appendChild(block);
    }

    if (!plan.rows.length) {
      area.appendChild(buildTextNote('只有表头、没有数据行：在表头下面每粘贴一行数据，就会对应执行一次'));
    }

    const list = document.createElement('div');
    list.className = 'batch-rows';
    plan.rows.forEach((row) => list.appendChild(buildBatchRowCard(row)));
    area.appendChild(list);

    dom.batchRun.disabled = plan.validCount === 0 || state.batch.running;
    dom.batchRun.textContent = `按有效行执行（${plan.validCount} 行）`;
  }

  function buildBatchRowCard(row) {
    const card = document.createElement('div');
    card.className = row.valid ? 'batch-row batch-row-ok' : 'batch-row batch-row-bad';
    card.dataset.lineNo = String(row.lineNo);

    const head = document.createElement('div');
    head.className = 'batch-row-head';
    const title = document.createElement('span');
    title.className = 'batch-row-title';
    title.textContent = `粘贴内容第 ${row.lineNo} 行`;
    const status = document.createElement('span');
    status.className = row.valid ? 'batch-row-status status-ok-text' : 'batch-row-status status-bad-text';
    status.textContent = row.valid ? '成立，可执行' : '不成立，跳过';
    head.append(title, status);
    card.appendChild(head);

    if (row.problems.length) {
      const problemBox = document.createElement('ul');
      problemBox.className = 'batch-row-problems';
      row.problems.forEach((problem) => {
        const li = document.createElement('li');
        li.textContent = problem.col >= 0
          ? `第 ${problem.col + 1} 列：${problem.message}`
          : problem.message;
        problemBox.appendChild(li);
      });
      card.appendChild(problemBox);
    }

    if (row.valid && row.draft) {
      card.appendChild(buildDraftDetails(row.draft));
    }

    const resultSlot = document.createElement('div');
    resultSlot.className = 'batch-row-result';
    resultSlot.dataset.slot = String(row.lineNo);
    card.appendChild(resultSlot);
    return card;
  }

  // 预演里折叠展示替换后真正会发出去的内容
  function buildDraftDetails(draft) {
    const details = document.createElement('details');
    details.className = 'batch-draft';
    const summary = document.createElement('summary');
    summary.textContent = '替换后实际发出的内容';
    details.appendChild(summary);

    const urlLine = document.createElement('p');
    urlLine.className = 'batch-draft-url';
    urlLine.textContent = `${draft.method} ${draft.url}`;
    details.appendChild(urlLine);

    if (draft.headers.length) {
      const headerTitle = document.createElement('p');
      headerTitle.className = 'batch-draft-label';
      headerTitle.textContent = '请求头';
      details.appendChild(headerTitle);
      draft.headers.forEach((row) => {
        const line = document.createElement('p');
        line.className = 'batch-draft-line';
        line.textContent = `${row.key}: ${row.value}`;
        details.appendChild(line);
      });
    }

    const bodyTitle = document.createElement('p');
    bodyTitle.className = 'batch-draft-label';
    bodyTitle.textContent = '请求内容';
    details.appendChild(bodyTitle);
    const pre = document.createElement('pre');
    pre.className = 'result-pre';
    pre.textContent = draft.body || '（无请求内容）';
    details.appendChild(pre);
    return details;
  }

  function setBatchRunning(running) {
    state.batch.running = running;
    dom.batchCase.disabled = running;
    dom.batchTable.disabled = running;
    dom.batchPreview.disabled = running;
    dom.batchClear.disabled = running;
    dom.batchSample.disabled = running;
    // 逐行执行期间，主请求区与列表操作也一并锁住，避免两条发送链路交叉
    dom.sendRequest.disabled = running;
    dom.saveCase.disabled = running;
    dom.resetDraft.disabled = running;
    dom.refreshCases.disabled = running;
    dom.batchRun.disabled = running || !state.batch.plan || state.batch.plan.validCount === 0;
  }

  async function runBatch() {
    const plan = state.batch.plan;
    if (!plan || state.batch.running) return;
    const validRows = plan.rows.filter((row) => row.valid);
    if (!validRows.length) {
      showNotice('没有可执行的数据行，请先按预演提示修正', 'error');
      return;
    }

    setBatchRunning(true);
    state.batch.results = {};
    renderBatchPlan();

    let transportFailed = 0;
    let statusBad = 0;
    let done = 0;
    for (const row of validRows) {
      done += 1;
      markRowProgress(row.lineNo, `发送中（有效行第 ${done}/${validRows.length} 行）…`);
      dom.batchRun.textContent = `正在执行 ${done}/${validRows.length}…`;
      try {
        const result = await request('/api/send', { method: 'POST', body: row.draft });
        state.batch.results[row.lineNo] = { ok: true, result };
        if (!result.ok || result.status >= 400) {
          if (!result.ok) transportFailed += 1;
          else statusBad += 1;
        }
      } catch (err) {
        state.batch.results[row.lineNo] = { ok: false, error: err.message };
        transportFailed += 1;
      }
      renderRowResult(row.lineNo);
    }

    setBatchRunning(false);
    dom.batchRun.textContent = `按有效行执行（${plan.validCount} 行）`;
    const skipped = plan.invalidCount;
    showNotice(
      `执行完成：成功 ${done - transportFailed - statusBad} 行，失败状态 ${statusBad} 行，请求未完成 ${transportFailed} 行` +
        (skipped ? `，另有 ${skipped} 行不成立已跳过` : ''),
      transportFailed || statusBad ? 'error' : 'success'
    );
  }

  function markRowProgress(lineNo, text) {
    const slot = document.querySelector(`.batch-row-result[data-slot="${lineNo}"]`);
    if (!slot) return;
    slot.textContent = '';
    slot.appendChild(buildChip(text, 'chip-pending'));
  }

  function renderRowResult(lineNo) {
    const slot = document.querySelector(`.batch-row-result[data-slot="${lineNo}"]`);
    if (!slot) return;
    const entry = state.batch.results[lineNo];
    slot.textContent = '';
    if (!entry) return;

    const head = document.createElement('div');
    head.className = 'result-head';

    if (!entry.ok) {
      head.appendChild(buildStatusBadge(0, '未发出'));
      slot.appendChild(head);
      slot.appendChild(buildFailurePanel('这一行没有发出去', entry.error, ''));
      return;
    }

    const result = entry.result;
    if (result.ok) {
      head.appendChild(buildStatusBadge(result.status, result.statusText));
      head.appendChild(buildChip(`耗时 ${formatDuration(result.timeMs)}`));
      head.appendChild(buildChip(`内容 ${formatBytes(result.size)}`));
    } else {
      head.appendChild(buildStatusBadge(0, '未完成'));
      head.appendChild(buildChip(`已等待 ${formatDuration(result.timeMs)}`));
    }
    slot.appendChild(head);

    if (!result.ok) {
      slot.appendChild(buildFailurePanel('请求没有完成', result.failure.reason, result.failure.detail));
      return;
    }

    if (result.body) {
      const details = document.createElement('details');
      details.className = 'batch-draft';
      const summary = document.createElement('summary');
      summary.textContent = '响应内容';
      details.appendChild(summary);
      const pre = document.createElement('pre');
      pre.className = 'result-pre';
      pre.textContent = result.body;
      details.appendChild(pre);
      slot.appendChild(details);
    }
  }

  // 依据所选用例的占位生成一份两行的示例数据，方便第一次使用时照着改
  function fillBatchSample() {
    const item = getSelectedBatchCase();
    if (!item) return;
    let names = scanPlaceholders(item);
    if (!names.length) {
      showNotice('这条用例里还没有占位，请先在地址、请求头取值或请求内容里写 {{占位名}}', 'error');
      return;
    }
    const valueFor = (name, suffix) => {
      const key = name.toLowerCase();
      if (key.includes('page')) return String(1 + suffix);
      if (key.includes('size') || key.includes('count') || key.includes('num')) return String(2 + suffix);
      if (key.includes('code') || key.includes('status')) return String(200 + suffix);
      if (key.includes('ms') || key.includes('time') || key.includes('wait')) return String(200 + suffix * 100);
      if (key.includes('sku') || key.includes('id')) return `DEMO-${1001 + suffix}`;
      return `${name}${suffix + 1}`;
    };
    const lines = [names.join('\t')];
    lines.push(names.map((name) => valueFor(name, 0)).join('\t'));
    lines.push(names.map((name) => valueFor(name, 1)).join('\t'));
    dom.batchTable.value = lines.join('\n');
    clearBatchPlan();
    showNotice('已按用例的占位填入两行示例数据，可直接点「预演」', 'info');
  }

  // 在用例列表点「按行执行」：切到该用例并把参数区滚动到可视区域
  function jumpToBatch(item) {
    if (state.busy || state.batch.running) return;
    dom.batchCase.value = item.id;
    renderBatchCaseHint();
    clearBatchPlan();
    dom.batchPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!scanPlaceholders(item).length) {
      showNotice(`用例「${item.name}」里还没有占位，请先在用例的地址、请求头或请求内容里写 {{占位名}}`, 'error');
    }
  }

  // ---------------- 结果区小零件 ----------------

  function buildSection(title) {
    const section = document.createElement('div');
    section.className = 'result-section';
    const head = document.createElement('p');
    head.className = 'result-section-title';
    head.textContent = title;
    section.appendChild(head);
    return section;
  }

  function buildStatusBadge(code, statusText) {
    const badge = document.createElement('span');
    badge.className = 'status-badge';
    if (!code) {
      badge.classList.add('status-bad');
    } else if (code >= 500) {
      badge.classList.add('status-bad');
    } else if (code >= 400) {
      badge.classList.add('status-warn');
    } else if (code >= 300) {
      badge.classList.add('status-info');
    } else {
      badge.classList.add('status-ok');
    }
    badge.textContent = code ? `${code} ${statusText}`.trim() : statusText;
    return badge;
  }

  function buildChip(text, extraClass) {
    const chip = document.createElement('span');
    chip.className = extraClass ? `chip ${extraClass}` : 'chip';
    chip.textContent = text;
    return chip;
  }

  function buildTab(text, active, onClick) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = active ? 'view-tab active' : 'view-tab';
    tab.textContent = text;
    tab.addEventListener('click', onClick);
    return tab;
  }

  function buildHeaderTable(headers) {
    const list = document.createElement('div');
    list.className = 'header-table';
    headers.forEach((row) => {
      const line = document.createElement('div');
      line.className = 'header-line';
      const keyNode = document.createElement('span');
      keyNode.className = 'header-line-key';
      keyNode.textContent = row.key;
      const valueNode = document.createElement('span');
      valueNode.className = 'header-line-value';
      valueNode.textContent = row.value;
      line.append(keyNode, valueNode);
      list.appendChild(line);
    });
    return list;
  }

  // ---------------- 工具函数 ----------------

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '时间未知';
    const pad = (num) => String(num).padStart(2, '0');
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
  }

  function formatDuration(ms) {
    const value = Number(ms) || 0;
    if (value >= 1000) return `${(value / 1000).toFixed(2)} 秒`;
    return `${value} 毫秒`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} 字节`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(2)} MB`;
  }

  async function checkHealth() {
    try {
      await request('/api/health');
      dom.health.textContent = '服务已连接';
      dom.health.classList.add('ok');
    } catch (err) {
      dom.health.textContent = '服务未连接';
      dom.health.classList.add('bad');
    }
  }

  // ---------------- 事件绑定与入口 ----------------

  function bindEvents() {
    dom.headerRows.addEventListener('input', (event) => {
      const target = event.target;
      const index = Number(target.dataset ? target.dataset.index : NaN);
      const part = target.dataset ? target.dataset.part : '';
      if (!Number.isInteger(index) || !state.headers[index] || !part) return;
      state.headers[index][part] = target.value;
      const slot = document.querySelector('[data-error="headers"]');
      if (slot) slot.hidden = true;
      dom.headerRows.classList.remove('invalid');
    });

    dom.headerRows.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action="remove-header"]');
      if (!button) return;
      const index = Number(button.dataset.index);
      if (!Number.isInteger(index) || !state.headers[index]) return;
      state.headers.splice(index, 1);
      renderHeaderRows();
    });

    dom.addHeader.addEventListener('click', () => {
      state.headers.push({ key: '', value: '' });
      renderHeaderRows();
      const inputs = dom.headerRows.querySelectorAll('input');
      const last = inputs[inputs.length - 2];
      if (last) last.focus();
    });

    dom.sendRequest.addEventListener('click', sendRequest);
    dom.saveCase.addEventListener('click', saveCase);

    dom.resetDraft.addEventListener('click', () => {
      if (state.busy) return;
      resetDraft(false);
    });

    dom.clearResult.addEventListener('click', () => {
      state.result = null;
      renderEmptyResult();
      showNotice('结果区已清空', 'info');
    });

    dom.refreshCases.addEventListener('click', async () => {
      if (state.busy) return;
      try {
        await loadCases();
        showNotice('用例列表已刷新', 'info');
      } catch (err) {
        showNotice(err.message, 'error');
      }
    });

    dom.closeDetail.addEventListener('click', () => {
      state.selectedId = '';
      renderCases();
      renderEmptyDetail();
    });

    // ---------------- 按数据行执行 ----------------

    dom.batchCase.addEventListener('change', () => {
      renderBatchCaseHint();
      clearBatchPlan();
    });

    dom.batchTable.addEventListener('input', () => {
      if (state.batch.running) return;
      // 内容变了就先收起旧预演，避免看到的还是上一次的行与结果
      if (state.batch.plan) clearBatchPlan();
    });

    dom.batchPreview.addEventListener('click', previewBatch);
    dom.batchRun.addEventListener('click', runBatch);
    dom.batchSample.addEventListener('click', fillBatchSample);
    dom.batchClear.addEventListener('click', () => {
      if (state.batch.running) return;
      dom.batchTable.value = '';
      clearBatchPlan();
      showNotice('表格数据与预演结果已清空', 'info');
    });
  }

  async function init() {
    bindEvents();
    renderHeaderRows();
    renderEmptyDetail();
    renderEmptyResult();
    renderCases();
    renderBatchCaseOptions();
    renderBatchCaseHint();
    dom.batchPreviewArea.appendChild(
      buildTextNote('粘贴表格后点「预演」，这里会列出每一行替换后实际发出的内容，以及不成立的行具体卡在哪一行哪一列')
    );
    await checkHealth();
    await loadDemos();
    try {
      await loadCases();
    } catch (err) {
      showNotice(err.message, 'error');
    }
  }

  init();
})();
