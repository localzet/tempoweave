'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, safeStorage, dialog, shell, net } = require('electron');
const { Store } = require('./db');
const { SyncEngine } = require('./sync');
const { KimaiClient } = require('./integrations/kimai');
const { fetchReceipt, importText } = require('./npd');

let mainWindow = null;
let store = null;
let syncEngine = null;
let syncTimer = null;

function ok(data) { return { ok: true, data }; }
function fail(error) { return { ok: false, error: String(error?.message || error) }; }
function handler(channel, fn) {
  ipcMain.handle(channel, async (_event, payload) => {
    try { return ok(await fn(payload || {})); } catch (error) { console.error(channel, error); return fail(error); }
  });
}

function assertSecureStorage() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secret encryption is unavailable on this system');
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
    throw new Error('Linux secret service is unavailable: refusing to store tokens with basic_text encryption');
  }
}
function encryptSecret(value) {
  assertSecureStorage();
  return safeStorage.encryptString(String(value));
}
function decryptSecret(key) {
  const blob = store.getEncryptedSecret(key);
  if (!blob) return '';
  assertSecureStorage();
  return safeStorage.decryptString(Buffer.from(blob));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#0d1020',
    title: 'TempoWeave',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function registerIpc() {
  handler('app:bootstrap', () => ({
    settings: store.listSettings(),
    clients: store.listClients(),
    projects: store.listProjects(),
    rateRules: store.listRateRules(),
    running: store.listRunningTimers(),
    payments: store.listPayments(),
    adjustments: store.listAdjustments(),
    schedules: store.listSchedules(),
    receipts: store.listReceipts(),
    outbox: store.outboxStatus()
  }));
  handler('dashboard:get', ({ from, to }) => store.dashboard(from, to));
  handler('settings:set', ({ key, value }) => { store.setSetting(key, value); scheduleAutoSync(); return store.getSetting(key); });
  handler('secrets:set', ({ key, value }) => { if (!value) store.deleteSecret(key); else store.saveEncryptedSecret(key, encryptSecret(value)); return true; });
  handler('secrets:delete', ({ key }) => { store.deleteSecret(key); return true; });
  handler('clients:save', (data) => store.saveClient(data));
  handler('projects:save', (data) => store.saveProject(data));
  handler('rates:save', (data) => store.saveRateRule(data));
  handler('rates:delete', ({ id }) => store.deleteRateRule(id));
  handler('timers:start', (data) => store.createTimer(data));
  handler('timers:stop', ({ id }) => { const row = store.stopTimer(id); void triggerSync(); return row; });
  handler('timers:running', () => store.listRunningTimers());
  handler('entries:list', ({ from, to, projectId }) => store.listTimeEntries(from, to, projectId || null));
  handler('entries:save', (data) => { const row = store.saveTimeEntry(data); void triggerSync(); return row; });
  handler('entries:delete', ({ id }) => store.deleteTimeEntry(id));
  handler('payments:list', ({ projectId }) => store.listPayments(projectId || null));
  handler('payments:save', (data) => store.createPayment(data));
  handler('payments:delete', ({ id }) => store.deletePayment(id));
  handler('adjustments:list', ({ projectId }) => store.listAdjustments(projectId || null));
  handler('adjustments:save', (data) => store.saveAdjustment(data));
  handler('schedules:list', () => store.listSchedules());
  handler('schedules:save', (data) => store.saveSchedule(data));
  handler('schedules:materialize', ({ from, to }) => store.materializeSchedules(from, to));
  handler('schedules:mark', ({ id, status, paidAmount }) => store.markScheduleItem(id, status, paidAmount));
  handler('receipts:list', () => store.listReceipts());
  handler('receipts:fetch', async ({ url, projectId, paymentId }) => {
    const receipt = store.saveReceipt({ ...(await fetchReceipt(url)), projectId: projectId || null, paymentId: paymentId || null });
    return paymentId ? store.linkReceipt(receipt.id, paymentId, projectId || null) : receipt;
  });
  handler('receipts:import-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Импорт чеков НПД', properties: ['openFile'], filters: [{ name: 'JSON / CSV', extensions: ['json', 'csv', 'txt'] }] });
    if (result.canceled || !result.filePaths[0]) return [];
    const filePath = result.filePaths[0];
    const receipts = importText(fs.readFileSync(filePath, 'utf8'), path.basename(filePath));
    return receipts.map((r) => store.saveReceipt(r));
  });
  handler('receipts:link', ({ receiptId, paymentId, projectId }) => store.linkReceipt(receiptId, paymentId, projectId || null));
  handler('jira:test', () => syncEngine.jiraClient().test());
  handler('jira:sync', ({ jql }) => syncEngine.syncJira(jql));
  handler('jira:search', ({ query }) => store.searchJiraIssues(query || ''));
  handler('kimai:test', () => syncEngine.kimaiClient().test());
  handler('kimai:catalogs', () => syncEngine.kimaiClient().catalogs());
  handler('kimai:pull', ({ begin, end }) => syncEngine.pullKimai(begin, end));
  handler('kimai:push', () => syncEngine.processOutbox());
  handler('data:backup', async () => {
    const result = await dialog.showSaveDialog(mainWindow, { title: 'Резервная копия TempoWeave', defaultPath: `tempoweave-${new Date().toISOString().slice(0,10)}.sqlite`, filters: [{ name: 'SQLite', extensions: ['sqlite'] }] });
    if (result.canceled || !result.filePath) return null;
    return store.backupTo(result.filePath);
  });
  handler('data:export', async () => {
    const result = await dialog.showSaveDialog(mainWindow, { title: 'Экспорт данных TempoWeave', defaultPath: `tempoweave-export-${new Date().toISOString().slice(0,10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return null;
    fs.writeFileSync(result.filePath, JSON.stringify(store.exportJson(), null, 2));
    return result.filePath;
  });
  handler('shell:open', ({ url }) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only HTTP(S) URLs can be opened');
    return shell.openExternal(url);
  });
}

async function triggerSync() {
  if (!net.isOnline()) return { offline: true };
  mainWindow?.webContents.send('sync:status', { state: 'running' });
  try {
    const result = await syncEngine.processOutbox();
    mainWindow?.webContents.send('sync:status', { state: result.failed ? 'warning' : 'ok', ...result });
    return result;
  } catch (error) {
    mainWindow?.webContents.send('sync:status', { state: 'error', error: String(error.message || error) });
    return { error: String(error.message || error) };
  }
}

function scheduleAutoSync() {
  if (syncTimer) clearInterval(syncTimer);
  const minutes = Math.max(1, Number(store.getSetting('app.autoSyncMinutes', 5)));
  syncTimer = setInterval(() => { void triggerSync(); }, minutes * 60_000);
}

app.whenReady().then(() => {
  const dataDir = app.getPath('userData');
  store = new Store(path.join(dataDir, 'tempoweave.sqlite'));
  syncEngine = new SyncEngine({ store, getSecret: decryptSecret });
  registerIpc();
  createWindow();
  scheduleAutoSync();
  setTimeout(() => { void triggerSync(); }, 2500);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (syncTimer) clearInterval(syncTimer); store?.close(); });
