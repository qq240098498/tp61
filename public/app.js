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
    // 参数区：当前选中的用例 id、表格预演结果，以及批量发送中的行序号
    batchCaseId: '',
    batchPreview: null,
    batchRunning: false,
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
    batchCase: document.getElementById('batch-case'),
    batchPlaceholders: document.getElementById('batch-placeholders'),
    batchData: document.getElementById('batch-data'),
    batchSample: document.getElementById('batch-sample'),
    batchPreviewBtn: document.getElementById('batch-preview'),
    batchRun: document.getElementById('batch-run'),
    batchClear: document.getElementById('batch-clear'),
    batchPreviewBox: document.getElementById('batch-preview-box'),
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
    dom.sendRequest.textContent = busy && activeAction === 'send' ? '发送中…' : '发送请求';
    dom.saveCase.textContent = busy && activeAction === 'save' ? '正在保存…' : '保存为用例';
    syncBatchButtons();
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
    renderBatchCaseOptions();
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

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'btn btn-small btn-danger';
    deleteButton.textContent = '删除';
    deleteButton.addEventListener('click', () => {
      removeCase(item);
    });

    actions.append(fillButton, viewButton, deleteButton);
    row.append(main, actions);
    return row;
  }

  // 回填：把用例保存下来的内容写回请求区，可以直接点发送请求重发一次
  function applyCase(item) {
    if (state.busy) return;
    fillDraft(item);
    state.selectedId = item.id;
    renderCases();
    renderDetail(item);
    showNotice(`用例「${item.name}」已回填到请求区，可直接点发送请求`, 'success');
  }

  async function openDetail(id) {
    if (state.busy) return;
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
    if (state.busy) return;
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

  // ---------------- 按数据行执行（参数区） ----------------

  // 占位扫描、表格解析、预演校验与替换等纯逻辑放在 public/batch-core.js，浏览器与 Node 测试共用
  const {
    scanPlaceholders,
    columnLabel,
    buildBatchPreview,
  } = window.BatchCore;

  function renderBatchCaseOptions() {
    const current = state.batchCaseId;
    dom.batchCase.textContent = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = state.cases.length ? '请选择一条用例' : '还没有可用用例，请先在左侧保存';
    dom.batchCase.appendChild(placeholder);
    state.cases.forEach((item) => {
      const option = document.createElement('option');
      option.value = item.id;
      const count = scanPlaceholders(item).length;
      option.textContent = count ? `${item.name}（${count} 个占位）` : item.name;
      dom.batchCase.appendChild(option);
    });
    if (current && state.cases.some((item) => item.id === current)) {
      dom.batchCaseId = current;
      dom.batchCase.value = current;
    } else {
      state.batchCaseId = '';
      dom.batchCase.value = '';
    }
    renderBatchPlaceholders();
  }

  function renderBatchPlaceholders() {
    const item = findSelectedCase();
    dom.batchPlaceholders.textContent = '';
    if (!item) {
      dom.batchPlaceholders.appendChild(buildTextNote('选择用例后，这里列出它里面可以被表格列替换的占位位置。'));
      return;
    }
    const names = scanPlaceholders(item);
    if (!names.length) {
      const note = buildTextNote('这条用例里还没有占位位置。在目标地址、请求头或请求内容里写成 {{名字}} 的形式，例如 /demo/items?page={{page}}，保存后即可按数据行替换。');
      dom.batchPlaceholders.appendChild(note);
      return;
    }
    names.forEach((name) => {
      const chip = document.createElement('span');
      chip.className = 'ph-chip';
      chip.textContent = `{{${name}}}`;
      dom.batchPlaceholders.appendChild(chip);
    });
  }

  function renderBatchPreview(preview) {
    const box = dom.batchPreviewBox;
    box.textContent = '';

    const summary = document.createElement('div');
    summary.className = 'batch-summary';
    const dataCount = preview.rows.length;
    summary.appendChild(
      buildChip(`按 ${dataCount} 行数据执行`, dataCount ? '' : 'chip-bad')
    );
    summary.appendChild(buildChip(`${preview.validCount} 行成立可发送`, preview.validCount ? 'chip-ok' : 'chip-bad'));
    summary.appendChild(buildChip(`${preview.invalidCount} 行不成立`, preview.invalidCount ? 'chip-bad' : ''));
    box.appendChild(summary);

    if (preview.headerBlocking.length) {
      const headBlock = document.createElement('div');
      headBlock.className = 'batch-header-errors batch-block-bad';
      const title = document.createElement('p');
      title.className = 'batch-block-title';
      title.textContent = '表头问题（下列问题会让数据行无法确定取值，全部不成立）';
      headBlock.appendChild(title);
      preview.headerBlocking.forEach((error) => {
        const line = document.createElement('p');
        line.className = 'batch-error-line';
        line.textContent = error.message;
        headBlock.appendChild(line);
      });
      box.appendChild(headBlock);
    }

    if (preview.headerWarnings.length) {
      const headBlock = document.createElement('div');
      headBlock.className = 'batch-header-errors batch-block-warn';
      const title = document.createElement('p');
      title.className = 'batch-block-title';
      title.textContent = '表头提示（下列列名用不上，不影响其它列对应的行照常执行）';
      headBlock.appendChild(title);
      preview.headerWarnings.forEach((error) => {
        const line = document.createElement('p');
        line.className = 'batch-warn-line';
        line.textContent = error.message;
        headBlock.appendChild(line);
      });
      box.appendChild(headBlock);
    }

    if (!preview.rows.length) {
      box.appendChild(buildTextNote('粘贴的内容只有表头、还没有数据行，至少再补一行数据。'));
      return;
    }

    preview.rows.forEach((row) => {
      box.appendChild(buildBatchRowCard(preview, row));
    });
  }

  function buildBatchRowCard(preview, row) {
    const valid = !row.errors.length && !row.blockedByHeader;
    const card = document.createElement('div');
    card.className = valid ? 'batch-row batch-row-ok' : 'batch-row batch-row-bad';

    const head = document.createElement('div');
    head.className = 'batch-row-head';

    const title = document.createElement('span');
    title.className = 'batch-row-title';
    title.textContent = `第 ${row.rowNumber} 行`;
    head.appendChild(title);

    const stateNode = document.createElement('span');
    stateNode.className = 'batch-row-state';
    if (row.status === 'running') {
      stateNode.textContent = '发送中…';
      stateNode.classList.add('state-running');
    } else if (row.status === 'done') {
      const httpOk = row.result && row.result.ok && row.result.status < 400;
      stateNode.textContent = row.result && row.result.ok
        ? `已完成 ${row.result.status} · ${formatDuration(row.result.timeMs)}`
        : `未完成${row.result && row.result.failure ? `：${row.result.failure.reason}` : ''}`;
      stateNode.classList.add(httpOk ? 'state-ok' : 'state-bad');
    } else {
      stateNode.textContent = valid ? '成立，待发送' : '不成立，跳过';
      stateNode.classList.add(valid ? 'state-ok' : 'state-bad');
    }
    head.appendChild(stateNode);
    card.appendChild(head);

    if (row.blockedByHeader && !row.errors.length) {
      const line = document.createElement('p');
      line.className = 'batch-error-line';
      line.textContent = `第 ${row.rowNumber} 行：表头存在重名，取值无法确定，这一行不参与发送（见上方表头问题）`;
      card.appendChild(line);
    }

    row.errors.forEach((error) => {
      const line = document.createElement('p');
      line.className = 'batch-error-line';
      const where = error.column >= 0
        ? `第 ${row.rowNumber} 行第 ${columnLabel(error.column)} 列：`
        : `第 ${row.rowNumber} 行：`;
      line.textContent = where + error.message;
      card.appendChild(line);
    });

    if (valid && row.request) {
      card.appendChild(buildBatchRequestView(row.request));
    }

    // 用不到的多出来的列给个提示，但不阻断这一行
    if (valid && row.unusedHeaders.length) {
      const note = buildTextNote(`本行第 ${row.unusedHeaders.map((entry) => columnLabel(entry.column)).join('、')} 列在用例里没有占位位置，取值不会参与替换`);
      card.appendChild(note);
    }

    return card;
  }

  // 预演时展示某一行替换后真正会发出去的内容：地址、请求头、请求内容
  function buildBatchRequestView(request) {
    const wrap = document.createElement('div');
    wrap.className = 'batch-request';

    const urlLine = document.createElement('p');
    urlLine.className = 'batch-request-line';
    urlLine.textContent = `${request.method} ${request.url}`;
    wrap.appendChild(urlLine);

    if (request.headers.length) {
      request.headers.forEach((row) => {
        const line = document.createElement('p');
        line.className = 'batch-request-line';
        line.textContent = `${row.key}: ${row.value}`;
        wrap.appendChild(line);
      });
    }

    if (request.body) {
      wrap.appendChild(buildPre(request.body));
    }
    return wrap;
  }

  function resetBatchPreview() {
    state.batchPreview = null;
    dom.batchPreviewBox.textContent = '';
    dom.batchRun.disabled = true;
  }

  function handleBatchPreview() {
    const item = findSelectedCase();
    if (!item) {
      showNotice('请先选择一条用例', 'error');
      dom.batchCase.focus();
      return;
    }
    if (!scanPlaceholders(item).length) {
      showNotice('这条用例里没有 {{占位名}}，无法按数据行替换', 'error');
      return;
    }
    const preview = buildBatchPreview(item, dom.batchData.value);
    state.batchPreview = preview;
    renderBatchPreview(preview);
    dom.batchRun.disabled = preview.validCount === 0;
    if (!preview.rows.length) {
      showNotice('请粘贴至少一行带表头的表格数据', 'error');
    } else if (preview.validCount === 0) {
      showNotice('没有成立的数据行，请按提示修正后再预演', 'error');
    } else if (preview.invalidCount === 0) {
      showNotice(`预演完成：${preview.validCount} 行都成立，可按行发送`, 'success');
    } else {
      showNotice(`预演完成：${preview.validCount} 行成立、${preview.invalidCount} 行不成立（不参与发送）`, 'success');
    }
  }

  async function runBatch() {
    const preview = state.batchPreview;
    if (!preview || state.batchRunning || state.busy) return;
    const runnable = preview.rows.filter((row) => row.request);
    if (!runnable.length) return;

    state.batchRunning = true;
    syncBatchButtons();
    // 重新发送时清掉上一轮的结果，避免尚未处理到的行短暂残留旧状态
    runnable.forEach((row) => {
      row.status = '';
      row.result = null;
    });
    let okCount = 0;
    let failCount = 0;

    for (const row of runnable) {
      row.status = 'running';
      renderBatchPreview(preview);
      try {
        // 逐行复用单条发送接口：替换后的草稿仍走服务端同一套校验与发送
        const result = await request('/api/send', { method: 'POST', body: row.request });
        row.status = 'done';
        row.result = result;
        if (result.ok && result.status < 400) okCount += 1;
        else failCount += 1;
      } catch (err) {
        row.status = 'done';
        row.result = { ok: false, failure: { reason: err.message, detail: '' } };
        failCount += 1;
      }
      renderBatchPreview(preview);
    }

    state.batchRunning = false;
    syncBatchButtons();
    showNotice(`按行发送完成：成功 ${okCount} 行，失败 ${failCount} 行，另有 ${preview.invalidCount} 行因不成立已跳过`, failCount ? 'error' : 'success');
  }

  function syncBatchButtons() {
    const hasPreview = !!state.batchPreview;
    const locked = state.batchRunning;
    dom.batchPreviewBtn.disabled = locked || state.busy;
    dom.batchCase.disabled = locked || state.busy;
    dom.batchData.disabled = locked;
    dom.batchSample.disabled = locked || state.busy;
    dom.batchClear.disabled = locked;
    dom.batchRun.disabled = locked || state.busy || !hasPreview || !(state.batchPreview && state.batchPreview.validCount > 0);
    dom.batchRun.textContent = locked ? '发送中…' : `按行发送${hasPreview && state.batchPreview.validCount ? `（${state.batchPreview.validCount} 行）` : ''}`;
  }

  function fillBatchSample() {
    const item = findSelectedCase();
    if (!item) {
      showNotice('请先选择一条用例', 'error');
      return;
    }
    const names = scanPlaceholders(item);
    if (!names.length) {
      showNotice('这条用例里没有 {{占位名}}', 'error');
      return;
    }
    const samples = names.map((name, index) => {
      const lower = name.toLowerCase();
      if (lower.includes('page')) return ['1', '2'];
      if (lower.includes('size') || lower.includes('count') || lower.includes('num')) return ['2', '3'];
      if (lower.includes('code') || lower.includes('status')) return ['200', '404'];
      if (lower.includes('ms') || lower.includes('wait')) return ['100', '300'];
      return [`示例${index + 1}-甲`, `示例${index + 1}-乙`];
    });
    const lines = [names.join('\t')];
    for (let r = 0; r < 2; r += 1) {
      lines.push(samples.map((pair) => pair[r]).join('\t'));
    }
    dom.batchData.value = lines.join('\n');
    resetBatchPreview();
    syncBatchButtons();
    showNotice('已按占位位置填好两行示例数据，可直接生成预演', 'info');
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

    // ---- 参数区 ----
    dom.batchCase.addEventListener('change', () => {
      state.batchCaseId = dom.batchCase.value;
      renderBatchPlaceholders();
      resetBatchPreview();
      syncBatchButtons();
    });

    dom.batchData.addEventListener('input', () => {
      // 表格内容改动后，上一次预演已经失效，需要重新生成
      if (state.batchPreview) resetBatchPreview();
      syncBatchButtons();
    });

    dom.batchPreviewBtn.addEventListener('click', handleBatchPreview);
    dom.batchRun.addEventListener('click', () => {
      runBatch();
    });
    dom.batchSample.addEventListener('click', fillBatchSample);
    dom.batchClear.addEventListener('click', () => {
      if (state.batchRunning) return;
      dom.batchData.value = '';
      resetBatchPreview();
      syncBatchButtons();
      showNotice('参数区表格与预演已清空', 'info');
    });
  }

  async function init() {
    bindEvents();
    renderHeaderRows();
    renderEmptyDetail();
    renderEmptyResult();
    renderCases();
    renderBatchCaseOptions();
    renderBatchPlaceholders();
    syncBatchButtons();
    await checkHealth();
    await loadDemos();
    try {
      await loadCases();
    } catch (err) {
      showNotice(err.message, 'error');
    }
    syncBatchButtons();
  }

  init();
})();
