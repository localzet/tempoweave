'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  fingerprintTimeEntry,
  generateScheduleDates,
  forecast,
  csvParse,
  toKimaiLocal
} = require('../src/main/domain');
const { Store } = require('../src/main/db');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tempoweave-test-'));
  const store = new Store(path.join(dir, 'db.sqlite'));
  return { store, cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('fingerprint is stable for reordered tags', () => {
  const base = {
    projectId: 'p1', activityName: 'Dev', startedAt: '2026-08-01T10:00:00Z',
    endedAt: '2026-08-01T11:00:00Z', description: 'Build feature', jiraIssueKey: 'ABC-1'
  };
  assert.equal(fingerprintTimeEntry({ ...base, tags: ['b', 'a'] }), fingerprintTimeEntry({ ...base, tags: ['a', 'b'] }));
});

test('interval and monthly payout schedules are deterministic', () => {
  const interval = generateScheduleDates({ type: 'interval', enabled: true, config: { anchorDate: '2026-08-01', everyDays: 14, amount: 1000 } }, '2026-08-01', '2026-09-01');
  assert.deepEqual(interval.map(x => x.dueDate), ['2026-08-01', '2026-08-15', '2026-08-29']);
  const monthly = generateScheduleDates({ type: 'monthly', enabled: true, config: { dayOfMonth: 31, amount: 1000 } }, '2026-02-01', '2026-03-31');
  assert.deepEqual(monthly.map(x => x.dueDate), ['2026-02-28', '2026-03-31']);
});

test('forecast returns bounded non-negative range', () => {
  const result = forecast([100, 120, 90, 130, 110, 140, 150], 20);
  assert.ok(result.expected > 0);
  assert.ok(result.low >= 0);
  assert.ok(result.high >= result.expected);
});

test('CSV parser supports quoted separators', () => {
  const rows = csvParse('date,amount,description\n2026-08-01,1200,"Dev, API"\n');
  assert.equal(rows[0].description, 'Dev, API');
});

test('Kimai local datetime contains no timezone suffix', () => {
  assert.match(toKimaiLocal('2026-08-01T10:20:30Z'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
});

test('parallel timers, rates, partial payment and debt are reconciled', () => {
  const { store, cleanup } = tempStore();
  try {
    const client = store.saveClient({ name: 'Acme', currency: 'RUB', taxRate: 6 });
    const project = store.saveProject({ name: 'Build', clientId: client.id, currency: 'RUB', kimaiProjectId: 10, kimaiActivityId: 20 });
    store.saveRateRule({ projectId: project.id, matchType: 'project', hourlyRate: 1000, priority: 10 });

    const first = store.createTimer({ projectId: project.id, startedAt: '2026-08-01T10:00:00Z' });
    const second = store.createTimer({ projectId: project.id, startedAt: '2026-08-01T10:30:00Z' });
    assert.equal(store.listRunningTimers().length, 2);
    store.stopTimer(first.id, '2026-08-01T12:00:00Z');
    store.stopTimer(second.id, '2026-08-01T11:30:00Z');

    let fin = store.projectFinancials(project.id);
    assert.equal(fin.workedHours, 3);
    assert.equal(fin.earned, 3000);
    assert.equal(fin.moneyDebt, 3000);

    const payment = store.createPayment({ projectId: project.id, amount: 1500, receivedAt: '2026-08-02', taxRate: 6, autoAllocate: true });
    fin = store.projectFinancials(project.id);
    assert.equal(payment.tax_amount, 90);
    assert.equal(fin.moneyDebt, 1500);
    assert.equal(fin.unpaidHours, 1.5);

    store.saveAdjustment({ projectId: project.id, kind: 'money', amount: -200, effectiveAt: '2026-08-03', reason: 'Discount' });
    fin = store.projectFinancials(project.id);
    assert.equal(fin.moneyDebt, 1300);
  } finally { cleanup(); }
});

test('remote upsert deduplicates by fingerprint and Kimai id', () => {
  const { store, cleanup } = tempStore();
  try {
    const entry = {
      kimaiId: 42, startedAt: '2026-08-01T10:00:00Z', endedAt: '2026-08-01T11:00:00Z',
      durationSeconds: 3600, description: 'Task', activityName: 'Dev', tags: [], fingerprint: 'fixed-fingerprint'
    };
    store.upsertRemoteTimeEntry(entry);
    store.upsertRemoteTimeEntry(entry);
    assert.equal(store.all('SELECT * FROM time_entries').length, 1);
  } finally { cleanup(); }
});

test('scheduled payment reconciliation is idempotent across edit and delete', () => {
  const { store, cleanup } = tempStore();
  try {
    const client = store.saveClient({ name: 'Schedule Client', currency: 'RUB', taxRate: 6 });
    const project = store.saveProject({ name: 'Retainer', clientId: client.id, currency: 'RUB' });
    store.saveSchedule({ projectId: project.id, type: 'monthly', config: { dayOfMonth: 15, amount: 600, label: 'Аванс' } });
    const [item] = store.materializeSchedules('2026-08-01', '2026-08-31');

    const payment = store.createPayment({ projectId: project.id, scheduleItemId: item.id, amount: 400, receivedAt: '2026-08-15', autoAllocate: false });
    let savedItem = store.get('SELECT * FROM schedule_items WHERE id=?', [item.id]);
    assert.equal(savedItem.paid_amount, 400);
    assert.equal(savedItem.status, 'partial');

    store.createPayment({ id: payment.id, projectId: project.id, scheduleItemId: item.id, amount: 600, receivedAt: '2026-08-15', autoAllocate: false });
    savedItem = store.get('SELECT * FROM schedule_items WHERE id=?', [item.id]);
    assert.equal(savedItem.paid_amount, 600);
    assert.equal(savedItem.status, 'paid');

    store.deletePayment(payment.id);
    savedItem = store.get('SELECT * FROM schedule_items WHERE id=?', [item.id]);
    assert.equal(savedItem.paid_amount, 0);
    assert.equal(savedItem.status, 'planned');
  } finally { cleanup(); }
});

test('project client tax rate is used by default', () => {
  const { store, cleanup } = tempStore();
  try {
    store.setSetting('app.taxRate', 4);
    const client = store.saveClient({ name: 'Company', currency: 'RUB', taxRate: 6 });
    const project = store.saveProject({ name: 'Consulting', clientId: client.id, currency: 'RUB' });
    const payment = store.createPayment({ projectId: project.id, amount: 10000, receivedAt: '2026-08-01', autoAllocate: false });
    assert.equal(payment.tax_rate, 6);
    assert.equal(payment.tax_amount, 600);
  } finally { cleanup(); }
});

test('period unpaid hours only use allocations belonging to entries in that period', () => {
  const { store, cleanup } = tempStore();
  try {
    const project = store.saveProject({ name: 'Monthly work', currency: 'RUB' });
    store.saveRateRule({ projectId: project.id, matchType: 'project', hourlyRate: 100, priority: 10 });
    store.saveTimeEntry({ projectId: project.id, startedAt: '2026-07-10T10:00:00Z', endedAt: '2026-07-10T11:00:00Z', billable: true, syncState: 'synced' });
    store.saveTimeEntry({ projectId: project.id, startedAt: '2026-08-10T10:00:00Z', endedAt: '2026-08-10T11:00:00Z', billable: true, syncState: 'synced' });
    store.createPayment({ projectId: project.id, amount: 100, receivedAt: '2026-07-15', autoAllocate: true });

    const august = store.projectFinancials(project.id, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z');
    assert.equal(august.workedHours, 1);
    assert.equal(august.unpaidHours, 1);
  } finally { cleanup(); }
});

test('NPD receipt normalization and import are deterministic', () => {
  const { normalizeReceipt, importText, receiptJsonUrl } = require('../src/main/npd');
  const raw = { id: 'receipt-1', totalAmount: '12 345,67 ₽', operationTime: '05.08.2026 14:30', partner: { displayName: 'ООО Заказчик' }, services: [{ name: 'Разработка' }] };
  const receipt = normalizeReceipt(raw, 'https://lknpd.nalog.ru/api/v1/receipt/abc/print');
  assert.equal(receipt.amount, 12345.67);
  assert.equal(receipt.buyer, 'ООО Заказчик');
  assert.equal(receipt.description, 'Разработка');
  assert.match(receiptJsonUrl(receipt.receiptUrl), /\/json$/);
  const imported = importText(JSON.stringify([raw]));
  assert.equal(imported.length, 1);
  assert.equal(imported[0].receiptNumber, 'receipt-1');
});

test('Kimai push preflight reuses remote entry carrying the local marker', async () => {
  const { KimaiClient } = require('../src/main/integrations/kimai');
  const client = new KimaiClient({ baseUrl: 'https://kimai.example.test', token: 'token' });
  client.timesheets = async () => [{ id: 77, tags: ['work', 'tempoweave:entry-1'] }];
  client.createTimesheet = async () => { throw new Error('must not create duplicate'); };
  const remote = await client.ensureTimesheet({ id: 'entry-1', started_at: '2026-08-05T10:00:00Z' }, {});
  assert.equal(remote.id, 77);
});

test('editing a custom schedule removes obsolete unpaid items but preserves paid history', () => {
  const { store, cleanup } = tempStore();
  try {
    const project = store.saveProject({ name: 'Milestones', currency: 'RUB' });
    store.saveSchedule({ projectId: project.id, type: 'custom', config: { items: [
      { date: '2026-08-10', amount: 100, label: 'One' },
      { date: '2026-08-20', amount: 200, label: 'Two' }
    ] } });
    let items = store.materializeSchedules('2026-08-01', '2026-08-31');
    const paidItem = items.find((item) => item.due_date === '2026-08-10');
    store.createPayment({ projectId: project.id, scheduleItemId: paidItem.id, amount: 100, receivedAt: '2026-08-10', autoAllocate: false });

    store.saveSchedule({ projectId: project.id, type: 'custom', config: { items: [
      { date: '2026-08-25', amount: 300, label: 'Replacement' }
    ] } });
    items = store.materializeSchedules('2026-08-01', '2026-08-31');
    assert.ok(items.some((item) => item.due_date === '2026-08-10' && item.status === 'paid'));
    assert.ok(!items.some((item) => item.due_date === '2026-08-20'));
    assert.ok(items.some((item) => item.due_date === '2026-08-25'));
  } finally { cleanup(); }
});

test('dashboard reports gross debt and overpayment separately', () => {
  const { store, cleanup } = tempStore();
  try {
    const indebted = store.saveProject({ name: 'Indebted', currency: 'RUB' });
    const prepaid = store.saveProject({ name: 'Prepaid', currency: 'RUB' });
    store.saveRateRule({ projectId: indebted.id, matchType: 'project', hourlyRate: 100, priority: 10 });
    store.saveTimeEntry({ projectId: indebted.id, startedAt: '2026-08-01T10:00:00Z', endedAt: '2026-08-01T12:00:00Z', billable: true, syncState: 'synced' });
    store.createPayment({ projectId: prepaid.id, amount: 500, receivedAt: '2026-08-02', autoAllocate: false });
    const dashboard = store.dashboard('2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z');
    assert.equal(dashboard.totals.debt, 200);
    assert.equal(dashboard.totals.overpayment, 500);
  } finally { cleanup(); }
});

test('payment edits preserve linked receipts and receipt links stay bidirectional', () => {
  const { store, cleanup } = tempStore();
  try {
    const project = store.saveProject({ name: 'Receipt project', currency: 'RUB' });
    const payment = store.createPayment({ projectId: project.id, amount: 1000, receivedAt: '2026-08-05', autoAllocate: false });
    const receipt = store.saveReceipt({
      receiptNumber: 'r-1000', issuedAt: '2026-08-05T12:00:00Z', amount: 1000,
      receiptUrl: 'https://lknpd.nalog.ru/api/v1/receipt/demo/json', raw: { id: 'r-1000' }
    });
    store.linkReceipt(receipt.id, payment.id);
    assert.equal(store.getPayment(payment.id).receipt_id, receipt.id);
    assert.equal(store.get('SELECT payment_id,project_id FROM receipts WHERE id=?', [receipt.id]).payment_id, payment.id);

    store.createPayment({ id: payment.id, projectId: project.id, amount: 1200, receivedAt: '2026-08-06', autoAllocate: false });
    assert.equal(store.getPayment(payment.id).receipt_id, receipt.id);
  } finally { cleanup(); }
});

test('NPD URL validation rejects lookalike hosts and insecure links', () => {
  const { receiptJsonUrl } = require('../src/main/npd');
  assert.throws(() => receiptJsonUrl('https://evilnalog.ru/api/v1/receipt/x/print'), /Only HTTPS/);
  assert.throws(() => receiptJsonUrl('http://lknpd.nalog.ru/api/v1/receipt/x/print'), /Only HTTPS/);
  assert.match(receiptJsonUrl('https://lknpd.nalog.ru/api/v1/receipt/x/print'), /\/json$/);
});

test('Kimai update sends PATCH and retains the TempoWeave marker', async () => {
  const { KimaiClient } = require('../src/main/integrations/kimai');
  const client = new KimaiClient({ baseUrl: 'https://kimai.example.test', token: 'token' });
  let captured;
  client.request = async (path, options) => { captured = { path, options, body: JSON.parse(options.body) }; return { id: 88 }; };
  const result = await client.updateTimesheet({
    id: 'entry-88', kimai_id: 88, project_id: 'project-1', started_at: '2026-08-05T10:00:00Z',
    ended_at: '2026-08-05T11:00:00Z', tags_json: JSON.stringify(['backend']), jira_issue_key: 'ABC-9',
    description: 'Work', billable: 1
  }, { kimai_project_id: 10, kimai_activity_id: 20 });
  assert.equal(result.id, 88);
  assert.equal(captured.path, '/api/timesheets/88');
  assert.equal(captured.options.method, 'PATCH');
  assert.match(captured.body.tags, /tempoweave:entry-88/);
  assert.match(captured.body.tags, /ABC-9/);
});

test('Kimai pull expands date-only filters to complete HTML5 datetimes', async () => {
  const { KimaiClient, formatKimaiFilterDate } = require('../src/main/integrations/kimai');
  assert.equal(formatKimaiFilterDate('2026-08-01'), '2026-08-01T00:00:00');
  assert.equal(formatKimaiFilterDate('2026-08-05', true), '2026-08-05T23:59:59');

  const client = new KimaiClient({ baseUrl: 'https://kimai.example.test/api/', token: 'token' });
  assert.equal(client.baseUrl, 'https://kimai.example.test');
  client.paginate = async (requestPath) => requestPath;
  const requestPath = await client.timesheets('2026-08-01', '2026-08-05');
  const url = new URL(requestPath, 'https://kimai.example.test');
  assert.equal(url.pathname, '/api/timesheets');
  assert.equal(url.searchParams.get('begin'), '2026-08-01T00:00:00');
  assert.equal(url.searchParams.get('end'), '2026-08-05T23:59:59');
  assert.equal(url.searchParams.get('orderBy'), 'begin');
  assert.equal(url.searchParams.get('order'), 'ASC');
});

test('Kimai errors retain validation details', () => {
  const { kimaiErrorMessage } = require('../src/main/integrations/kimai');
  assert.equal(
    kimaiErrorMessage({ message: 'Bad Request', violations: [{ propertyPath: 'begin', message: 'Invalid datetime' }] }, '', ''),
    'Bad Request; begin: Invalid datetime'
  );
});
