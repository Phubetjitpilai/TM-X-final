// Run: node --test tools/tests/test_telemetry_queue.cjs
// Exercise the Dashboard's actual handlers with mocked I/O, without a browser,
// a live database, or commands to the station.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../../Frontend-react/node_modules/typescript');

const source = ts.createSourceFile('Dashboard.tsx', fs.readFileSync(
  path.join(__dirname, '../../Frontend-react/src/pages/DashboardPage.tsx'), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const dashboard = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'DashboardPage');
const names = ['setQueueStrip', 'prepareDisplaySession', 'syncQueueStrip', 'onSessionStarted',
  'savePartEntryState', 'clearTelemetry', 'selectQueueTelemetry', 'remeasureSelected', 'updateStats',
  'ensureMeasurementSession', 'onMeasurementReplaced', 'partEntryForSession', 'startFromQueue'];
const code = ts.transpileModule(dashboard.body.statements.filter(n =>
  ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map(n => n.getText(source)).join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function fixture() {
  const calls = [];
  const c = {
    console, PART_ENTRY_STORAGE_KEY: 'test',
    exports: {}, require: () => require('../../Frontend-react/node_modules/react/jsx-runtime'),
    RemeasureStartOptions() {}, parsedQueue: { trigger_mode: 'auto' },
    displaySessionIdRef: { current: 42 },
    displayQueueRef: { current: [1, 2, 3].map(alpl => ({ alpl, state: 'ok', sessionId: 42 })) },
    sessionRef: { current: { session_id: 42, state: 'stopped', measured_count: 3, target_count: 3 } },
    reviewDisplayRef: { current: null }, statsRequestRef: { current: 0 },
    resultsRef: { current: ['OK', 'OK', 'OK'] }, clearedSidRef: { current: null },
    latestTelemetryRef: { current: { measurement_id: 103, session_id: 42, number_alpl: 3 } },
    telemetryRef: { current: { measurement_id: 102, session_id: 42, number_alpl: 2 } },
    selectedQueueIndex: 1, selectedQueueRef: { current: 1 },
    telemetryRequestRef: { current: 0 }, entryQueueRef: { current: null },
    reviewBusyRef: { current: false },
    mtTimerRef: { current: null }, setMtModal() {}, loadMeasurementsPage: async () => {},
    setQueueStripState() {}, setReviewPhase() {}, setReviewBusy() {}, setTelemetryLoading() {},
    setSelectedQueueIndex(i) { c.selectedQueueIndex = i; },
    setStats(stats) { c.stats = stats; },
    chipStateFor(i) { return c.resultsRef.current[i] === 'OK' ? 'ok' : c.resultsRef.current[i] === 'NG' ? 'ng' : 'done'; },
    isTelemetryCleared() { return c.clearedSidRef.current != null && c.clearedSidRef.current === c.sessionRef.current.session_id; },
    resetTelemetry() { c.latestTelemetryRef.current = null; c.telemetryRef.current = null; c.selectedQueueRef.current = null; },
    applyTelemetry(d) { c.telemetryRef.current = d; }, followLatestTelemetry() {},
    updateSession(d) { Object.assign(c.sessionRef.current, d); },
    showToast() {}, ApiError: class extends Error {}, dialog: { confirm: async () => true },
    localStorage: { setItem(k, v) { c.saved = JSON.parse(v); } },
    apiGet: async (url, params) => { calls.push(params); return { items: [{ number_alpl: params.number_alpl, measurement_id: 101 }] }; },
    apiPost: async () => started(43, 2), calls,
  };
  vm.createContext(c);
  vm.runInContext(code, c);
  return c;
}
function started(id, alpl, source = true) {
  return { session_id: id, target_count: source ? 1 : 3,
    queue_state: { queue: source ? [alpl] : [10, 11, 12],
      review_source: source ? { session_id: 42, number_alpl: alpl, measurement_id: 102 } : null } };
}

test('one-item Start retains all chips and exact source sessions', async () => {
  const c = fixture();
  await c.remeasureSelected();
  assert.equal(c.sessionRef.current.session_id, 43);
  assert.equal(c.displayQueueRef.current.length, 3);
  assert.equal(c.reviewDisplayRef.current.queueIndex, 1);
  c.sessionRef.current.state = 'stopped';
  await c.selectQueueTelemetry(0, 1);
  assert.equal(c.calls.at(-1).session_id, 42);
  c.displayQueueRef.current[1].sessionId = 43;
  await c.selectQueueTelemetry(1, 2);
  assert.equal(c.calls.at(-1).session_id, 43);
});

test('failed single-item Start does not leave a pending review or change queue', async () => {
  const c = fixture();
  c.apiPost = async () => { throw new Error('offline'); };
  await c.remeasureSelected();
  assert.equal(c.reviewDisplayRef.current, null);
  assert.equal(c.displayQueueRef.current.length, 3);
  assert.equal(c.latestTelemetryRef.current.measurement_id, 103);
  assert.equal(c.saved.reviewDisplay, null);
});

test('new normal Start clears once, late POST/SSE does not erase new results', () => {
  const c = fixture();
  c.onSessionStarted(started(43, 2));
  const normal = started(44, null, false);
  c.onSessionStarted(normal);
  assert.equal(c.reviewDisplayRef.current, null);
  assert.equal(c.displayQueueRef.current.map(q => q.alpl).join(','), '10,11,12');
  assert.equal(c.latestTelemetryRef.current, null);
  c.latestTelemetryRef.current = { measurement_id: 200 };
  c.sessionRef.current.measured_count = 1;
  c.onSessionStarted(normal);
  assert.equal(c.latestTelemetryRef.current.measurement_id, 200);
  assert.equal(c.sessionRef.current.measured_count, 1);
});

test('polling an unconfirmed or failed Start leaves the previous queue intact', () => {
  const c = fixture();
  const d = started(44, null, false);
  d.queue_state.start_confirmed = false;
  assert.equal(c.prepareDisplaySession(d), false);
  c.onSessionStarted(d);
  assert.equal(c.displayQueueRef.current.map(q => q.alpl).join(','), '1,2,3');
  assert.equal(c.latestTelemetryRef.current.measurement_id, 103);
  assert.equal(c.sessionRef.current.session_id, 42);
});

test('Clear after a single-item session stays empty on subsequent polling', () => {
  const c = fixture();
  const d = started(43, 2);
  c.onSessionStarted(d);
  c.clearTelemetry();
  c.prepareDisplaySession(d);
  c.syncQueueStrip({ ...d, state: 'stopped', measured_count: 1 });
  assert.equal(c.displayQueueRef.current.length, 0);
  assert.equal(c.clearedSidRef.current, 43);
});

test('persisted queue survives refresh after remeasure and retains other ALPLs', () => {
  const c = fixture();
  const d = started(43, 2);
  c.onSessionStarted(d);
  c.displayQueueRef.current[1].sessionId = 43;
  c.savePartEntryState();
  const restored = fixture();
  restored.displaySessionIdRef.current = c.saved.displaySessionId;
  restored.displayQueueRef.current = c.saved.displayQueue;
  restored.reviewDisplayRef.current = c.saved.reviewDisplay;
  restored.prepareDisplaySession(d);
  restored.syncQueueStrip({ ...d, state: 'stopped', measured_count: 1 });
  assert.equal(restored.displayQueueRef.current.map(q => q.sessionId).join(','), '42,43,42');
});

test('polling recovers a missed remeasure event and updates only its chip and total', async () => {
  const c = fixture();
  c.onSessionStarted(started(43, 2));
  c.apiGet = async (_, params) => ({ items: params.session_id === 43
    ? [{ number_alpl: 2, measurement_id: 201, result: 'NG' }]
    : [1, 2, 3].map(number_alpl => ({ number_alpl, measurement_id: 100 + number_alpl, result: 'OK' })) });
  await c.updateStats(43);
  assert.equal(c.displayQueueRef.current.map(q => q.sessionId).join(','), '42,43,42');
  assert.equal(c.displayQueueRef.current.map(q => q.state).join(','), 'ok,ng,ok');
  assert.equal(c.stats.total, 3);
  assert.equal(c.stats.ok, 2);
  assert.equal(c.stats.ng, 1);
  assert.equal(c.telemetryRef.current.measurement_id, 201);
});

test('Stop and timeout retain already measured entries', () => {
  const c = fixture();
  for (const state of ['stopped', 'timeout']) {
    c.syncQueueStrip({ session_id: 42, state, measured_count: 1, target_count: 3, queue_state: { queue: [1, 2, 3] } });
    assert.equal(c.displayQueueRef.current.length, 3);
    assert.equal(c.displayQueueRef.current[0].state, 'ok');
  }
});

test('updating the same measurement ID refreshes telemetry and keeps original chip session', async () => {
  const c = fixture();
  const d = started(43, 2);
  d.queue_state.review_source.update_existing = true;
  c.onSessionStarted(d);
  c.latestTelemetryRef.current = { measurement_id: 102, session_id: 42, number_alpl: 2, result: 'OK', value_x: 8.03 };
  const row = { measurement_id: 102, session_id: 42, number_alpl: 2, result: 'NG', value_x: 8.2 };
  c.apiGet = async (_, params) => ({ items: params.session_id === 42
    ? [{ number_alpl: 1, result: 'OK' }, row, { number_alpl: 3, result: 'OK' }]
        .filter(m => params.number_alpl == null || m.number_alpl === params.number_alpl) : [] });
  await c.onMeasurementReplaced({ ...row, session_id: 43, measurement_session_id: 42, piece: 1, measured: 1, target: 1 });
  await c.updateStats(43);
  assert.equal(c.telemetryRef.current.measurement_id, 102);
  assert.equal(c.telemetryRef.current.value_x, 8.2);
  assert.equal(c.latestTelemetryRef.current.result, 'NG');
  assert.equal(c.displayQueueRef.current.map(q => q.sessionId).join(','), '42,42,42');
  assert.equal(c.stats.ok, 2);
  assert.equal(c.stats.ng, 1);
  c.sessionRef.current.state = 'stopped';
  await c.selectQueueTelemetry(1, 2);
  assert.equal(c.telemetryRef.current.measurement_id, 102);
});

test('missed replacement SSE recovers changed values with the same ID after refresh', async () => {
  const c = fixture();
  const d = started(43, 2);
  d.queue_state.review_source.update_existing = true;
  c.onSessionStarted(d);
  c.sessionRef.current.measured_count = 1;
  c.sessionRef.current.state = 'stopped';
  c.latestTelemetryRef.current = { measurement_id: 102, number_alpl: 2, result: 'OK', value_x: 8.03 };
  c.savePartEntryState();
  const restored = fixture();
  restored.reviewDisplayRef.current = c.saved.reviewDisplay;
  restored.displayQueueRef.current = c.saved.displayQueue;
  restored.latestTelemetryRef.current = c.saved.lastTelemetry;
  restored.sessionRef.current = c.sessionRef.current;
  restored.apiGet = async (_, params) => ({ items: params.session_id === 42
    ? [{ measurement_id: 102, number_alpl: 2, result: 'NG', value_x: 8.2 }] : [] });
  await restored.updateStats(43);
  assert.equal(restored.telemetryRef.current.value_x, 8.2);
  assert.equal(restored.displayQueueRef.current[1].sessionId, 42);
});

test('standalone review sends the Auto/Manual choice made inside the popup', async () => {
  for (const mode of ['auto', 'manual']) {
    const c = fixture();
    c.parsedQueue.trigger_mode = mode === 'auto' ? 'manual' : 'auto';
    c.dialog.confirm = async (message, options) => {
      assert.equal(options.okLabel, '▶ Start');
      assert.equal(message.props.initialMode, c.parsedQueue.trigger_mode);
      message.props.onModeChange(mode);
      return true;
    };
    let posted;
    c.apiPost = async (url, body) => { posted = { url, body }; return started(43, 2); };
    await c.remeasureSelected();
    assert.equal(posted.url, '/api/review/start/102');
    assert.equal(posted.body.trigger_mode, mode);
  }
});

test('canceling the mode popup does not send Start', async () => {
  const c = fixture();
  let posted = false;
  c.dialog.confirm = async message => { message.props.onModeChange('manual'); return false; };
  c.apiPost = async () => { posted = true; };
  await c.remeasureSelected();
  assert.equal(posted, false);
  assert.equal(c.sessionRef.current.session_id, 42);
  assert.equal(c.reviewDisplayRef.current, null);
});

test('review during Running keeps the current trigger mode without a mode picker', async () => {
  const c = fixture();
  c.sessionRef.current.state = 'running';
  c.dialog.confirm = async message => { assert.equal(typeof message, 'string'); return true; };
  let posted;
  c.apiPost = async (url, body) => { posted = { url, body }; return {}; };
  await c.remeasureSelected();
  assert.equal(posted.url, '/api/review/command');
  assert.equal(posted.body.action, 'remeasure');
  assert.equal(posted.body.trigger_mode, undefined);
});

test('running Part Entry uses the execution queue and chosen mode, including after refresh', () => {
  const c = fixture();
  const staged = { mode: 'New', list: [100, 101], session_id: null };
  for (const triggerMode of ['auto', 'manual']) {
    const queue = { groups: [{ number_alpl: [2], package_size: '8x8' }], queue: [2],
      operator: 'Test', measure_mode: 'IPM', trigger_mode: triggerMode, review_source: { measurement_id: 102 } };
    const active = { state: 'running', session_id: 43, queue_state: JSON.stringify(queue) };
    const displayed = c.partEntryForSession(active, staged);
    assert.equal(displayed.list.join(','), '2');
    assert.equal(displayed.triggerMode, triggerMode);
    assert.equal(displayed.session_id, 43);
    assert.equal(c.partEntryForSession({ ...active, state: 'stopped' }, staged), staged);
  }
  assert.equal(c.partEntryForSession({ state: 'running', session_id: 43 }, staged), null);
});

test('normal Start sends optional tray capacity as null and preserves zero and a chosen number', async () => {
  for (const capacity of [undefined, null, 0, 12]) {
    const c = fixture();
    c.entryQueue = { mode: 'IPM', operator: 'Test', triggerMode: 'auto', trayCapacity: capacity,
      list: [10], groups: [{ number_alpl: [10], package_size: '8x8' }] };
    c.formatAlplRanges = numbers => numbers.join(',');
    c.setEntryQueue = () => {};
    c.refreshParts = () => {};
    let posted;
    c.apiPost = async (_, body) => { posted = body; return started(43, null, false); };
    await c.startFromQueue();
    assert.equal(posted.Tray_Capacity, capacity ?? null);
    assert.equal(c.entryQueueRef.current.trayCapacity, capacity);
    const restored = c.partEntryForSession({ state: 'running', session_id: 43, queue_state: {
      queue: [10], groups: posted.groups, tray_capacity: posted.Tray_Capacity, trigger_mode: 'auto' } }, null);
    assert.equal(restored.trayCapacity, capacity ?? null);
  }
});
