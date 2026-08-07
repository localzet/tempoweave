'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync, backup } = require('node:sqlite');
const { uuid, nowIso, roundMoney, fingerprintTimeEntry, durationSeconds, parseTags, generateScheduleDates, forecast, workingDaysBetween } = require('./domain');

class Store {
  constructor(dbPath) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, encrypted_value BLOB NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'RUB', tax_rate REAL NOT NULL DEFAULT 6,
        active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, client_id TEXT REFERENCES clients(id) ON DELETE SET NULL, name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#6d5dfc', currency TEXT NOT NULL DEFAULT 'RUB', active INTEGER NOT NULL DEFAULT 1,
        billing_mode TEXT NOT NULL DEFAULT 'hourly', fixed_amount REAL NOT NULL DEFAULT 0,
        start_date TEXT, end_date TEXT, kimai_customer_id INTEGER, kimai_project_id INTEGER, kimai_activity_id INTEGER,
        jira_project_key TEXT, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rate_rules (
        id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE, match_type TEXT NOT NULL,
        match_value TEXT NOT NULL DEFAULT '', hourly_rate REAL NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
        valid_from TEXT, valid_to TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS time_entries (
        id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        activity_name TEXT NOT NULL DEFAULT '', jira_issue_key TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]', started_at TEXT NOT NULL, ended_at TEXT, duration_seconds INTEGER NOT NULL DEFAULT 0,
        billable INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'local', kimai_id INTEGER,
        kimai_project_id INTEGER, kimai_activity_id INTEGER, sync_state TEXT NOT NULL DEFAULT 'pending', fingerprint TEXT UNIQUE,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_time_entries_period ON time_entries(started_at, ended_at);
      CREATE INDEX IF NOT EXISTS idx_time_entries_project ON time_entries(project_id);
      CREATE INDEX IF NOT EXISTS idx_time_entries_sync ON time_entries(sync_state);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL,
        dedupe_key TEXT NOT NULL UNIQUE, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
        last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        received_at TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'RUB', reference TEXT NOT NULL DEFAULT '',
        tax_rate REAL NOT NULL DEFAULT 6, tax_amount REAL NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual', receipt_id TEXT, schedule_item_id TEXT REFERENCES schedule_items(id) ON DELETE SET NULL,
        allocation_mode TEXT NOT NULL DEFAULT 'auto', period_start TEXT, period_end TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_payments_project_date ON payments(project_id, received_at);
      CREATE TABLE IF NOT EXISTS payment_allocations (
        id TEXT PRIMARY KEY, payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
        time_entry_id TEXT REFERENCES time_entries(id) ON DELETE SET NULL, period_start TEXT, period_end TEXT,
        amount REAL NOT NULL DEFAULT 0, hours REAL NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payment_schedules (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
        type TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedule_items (
        id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES payment_schedules(id) ON DELETE CASCADE,
        source_key TEXT NOT NULL, due_date TEXT NOT NULL, label TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'planned', paid_amount REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(schedule_id, source_key)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        payment_id TEXT REFERENCES payments(id) ON DELETE SET NULL, receipt_url TEXT NOT NULL DEFAULT '',
        receipt_number TEXT NOT NULL DEFAULT '', issued_at TEXT NOT NULL, amount REAL NOT NULL, tax_rate REAL NOT NULL DEFAULT 6,
        tax_amount REAL NOT NULL DEFAULT 0, buyer TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active', source TEXT NOT NULL DEFAULT 'npd', raw_json TEXT NOT NULL DEFAULT '{}',
        fingerprint TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS adjustments (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, amount REAL NOT NULL, effective_at TEXT NOT NULL, reason TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jira_issues (
        key TEXT PRIMARY KEY, project_key TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL DEFAULT '',
        assignee TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', raw_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_log (
        id TEXT PRIMARY KEY, integration TEXT NOT NULL, direction TEXT NOT NULL, status TEXT NOT NULL,
        message TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
    `);
    this.ensureColumn('payments', 'schedule_item_id', 'TEXT REFERENCES schedule_items(id) ON DELETE SET NULL');
    this.ensureColumn('payments', 'allocation_mode', "TEXT NOT NULL DEFAULT 'auto'");
    this.ensureColumn('payments', 'period_start', 'TEXT');
    this.ensureColumn('payments', 'period_end', 'TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_payments_schedule_item ON payments(schedule_item_id);');
    this.setSettingDefault('app.currency', 'RUB');
    this.setSettingDefault('app.taxRate', 6);
    this.setSettingDefault('app.weekHoursTarget', 40);
    this.setSettingDefault('app.autoSyncMinutes', 5);
    this.setSettingDefault('app.forecastDays', 30);
  }

  ensureColumn(table, column, definition) {
    const allowed = new Set(['payments']);
    if (!allowed.has(table)) throw new Error(`Unsupported migration table: ${table}`);
    const columns = this.all(`PRAGMA table_info(${table})`).map((row) => row.name);
    if (!columns.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  close() { this.db.close(); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const out = fn(); this.db.exec('COMMIT'); return out; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  all(sql, params = []) { const stmt=this.db.prepare(sql); return Array.isArray(params) ? stmt.all(...params) : stmt.all(params); }
  get(sql, params = []) { const stmt=this.db.prepare(sql); return Array.isArray(params) ? stmt.get(...params) : stmt.get(params); }
  run(sql, params = []) { const stmt=this.db.prepare(sql); return Array.isArray(params) ? stmt.run(...params) : stmt.run(params); }

  setSettingDefault(key, value) {
    if (!this.get('SELECT key FROM settings WHERE key = ?', [key])) this.setSetting(key, value);
  }
  setSetting(key, value) {
    this.run(`INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`, [key, JSON.stringify(value), nowIso()]);
  }
  getSetting(key, fallback = null) {
    const row = this.get('SELECT value_json FROM settings WHERE key = ?', [key]);
    if (!row) return fallback;
    try { return JSON.parse(row.value_json); } catch { return fallback; }
  }
  listSettings() {
    return Object.fromEntries(this.all('SELECT key,value_json FROM settings').map((r) => { try { return [r.key, JSON.parse(r.value_json)]; } catch { return [r.key, null]; } }));
  }

  saveEncryptedSecret(key, encryptedBuffer) {
    this.run(`INSERT INTO secrets(key,encrypted_value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value,updated_at=excluded.updated_at`, [key, encryptedBuffer, nowIso()]);
  }
  getEncryptedSecret(key) { return this.get('SELECT encrypted_value FROM secrets WHERE key = ?', [key])?.encrypted_value || null; }
  deleteSecret(key) { this.run('DELETE FROM secrets WHERE key = ?', [key]); }

  listClients() { return this.all('SELECT * FROM clients ORDER BY active DESC,name'); }
  saveClient(input) {
    const id = input.id || uuid(); const now = nowIso();
    const name = String(input.name || '').trim();
    const taxRate = Number(input.taxRate ?? 6);
    if (!name) throw new Error('Client name is required');
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) throw new Error('Client tax rate must be between 0 and 100');
    this.run(`INSERT INTO clients(id,name,currency,tax_rate,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,currency=excluded.currency,tax_rate=excluded.tax_rate,active=excluded.active,updated_at=excluded.updated_at`,
      [id, name, input.currency || 'RUB', taxRate, input.active === false ? 0 : 1, now, now]);
    return this.get('SELECT * FROM clients WHERE id=?', [id]);
  }

  listProjects() {
    return this.all(`SELECT p.*,c.name client_name,c.tax_rate client_tax_rate FROM projects p LEFT JOIN clients c ON c.id=p.client_id ORDER BY p.active DESC,p.name`);
  }
  getProject(id) { return this.get('SELECT p.*,c.name client_name,c.tax_rate client_tax_rate FROM projects p LEFT JOIN clients c ON c.id=p.client_id WHERE p.id=?', [id]); }
  getProjectTaxRate(id) {
    const row = this.get(`SELECT COALESCE(c.tax_rate, ?) tax_rate FROM projects p LEFT JOIN clients c ON c.id=p.client_id WHERE p.id=?`, [this.getSetting('app.taxRate', 6), id]);
    return Number(row?.tax_rate ?? this.getSetting('app.taxRate', 6));
  }
  saveProject(input) {
    const id = input.id || uuid(); const now = nowIso();
    const name = String(input.name || '').trim();
    const fixedAmount = Number(input.fixedAmount || 0);
    if (!name) throw new Error('Project name is required');
    if (!Number.isFinite(fixedAmount) || fixedAmount < 0) throw new Error('Fixed project amount must be non-negative');
    this.run(`INSERT INTO projects(id,client_id,name,color,currency,active,billing_mode,fixed_amount,start_date,end_date,kimai_customer_id,kimai_project_id,kimai_activity_id,jira_project_key,notes,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET client_id=excluded.client_id,name=excluded.name,color=excluded.color,currency=excluded.currency,
      active=excluded.active,billing_mode=excluded.billing_mode,fixed_amount=excluded.fixed_amount,start_date=excluded.start_date,end_date=excluded.end_date,
      kimai_customer_id=excluded.kimai_customer_id,kimai_project_id=excluded.kimai_project_id,kimai_activity_id=excluded.kimai_activity_id,jira_project_key=excluded.jira_project_key,notes=excluded.notes,updated_at=excluded.updated_at`,
      [id,input.clientId||null,name,/^#[0-9a-f]{6}$/i.test(String(input.color||''))?String(input.color):'#6d5dfc',input.currency||'RUB',input.active===false?0:1,input.billingMode||'hourly',fixedAmount,input.startDate||null,input.endDate||null,input.kimaiCustomerId||null,input.kimaiProjectId||null,input.kimaiActivityId||null,String(input.jiraProjectKey||'').toUpperCase(),input.notes||'',now,now]);
    return this.getProject(id);
  }

  listRateRules(projectId = null) {
    return projectId ? this.all('SELECT * FROM rate_rules WHERE project_id=? OR project_id IS NULL ORDER BY priority DESC,created_at', [projectId]) : this.all('SELECT * FROM rate_rules ORDER BY priority DESC,created_at');
  }
  saveRateRule(input) {
    const id=input.id||uuid(); const now=nowIso();
    this.run(`INSERT INTO rate_rules(id,project_id,match_type,match_value,hourly_rate,priority,valid_from,valid_to,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,match_type=excluded.match_type,match_value=excluded.match_value,hourly_rate=excluded.hourly_rate,priority=excluded.priority,valid_from=excluded.valid_from,valid_to=excluded.valid_to,active=excluded.active,updated_at=excluded.updated_at`,
      [id,input.projectId||null,input.matchType||'global',String(input.matchValue||''),Number(input.hourlyRate||0),Number(input.priority||0),input.validFrom||null,input.validTo||null,input.active===false?0:1,now,now]);
    return this.get('SELECT * FROM rate_rules WHERE id=?',[id]);
  }
  deleteRateRule(id) { this.run('DELETE FROM rate_rules WHERE id=?',[id]); }

  resolveRate(entry) {
    const date = String(entry.started_at || entry.startedAt || nowIso()).slice(0,10);
    const rules = this.all(`SELECT * FROM rate_rules WHERE active=1 AND (project_id IS NULL OR project_id=?)
      AND (valid_from IS NULL OR valid_from<=?) AND (valid_to IS NULL OR valid_to>=?) ORDER BY priority DESC, CASE match_type WHEN 'jira' THEN 5 WHEN 'activity' THEN 4 WHEN 'tag' THEN 3 WHEN 'project' THEN 2 ELSE 1 END DESC`, [entry.project_id || entry.projectId || null,date,date]);
    const tags = parseTags(entry.tags_json ? JSON.parse(entry.tags_json) : entry.tags);
    for (const r of rules) {
      const needle = String(r.match_value || '').toLowerCase();
      if (r.match_type === 'global') return Number(r.hourly_rate);
      if (r.match_type === 'project' && (!needle || String(entry.project_id || entry.projectId) === r.project_id || String(entry.project_id || entry.projectId).toLowerCase() === needle)) return Number(r.hourly_rate);
      if (r.match_type === 'activity' && String(entry.activity_name || entry.activityName || '').toLowerCase().includes(needle)) return Number(r.hourly_rate);
      if (r.match_type === 'jira' && String(entry.jira_issue_key || entry.jiraIssueKey || '').toLowerCase().startsWith(needle)) return Number(r.hourly_rate);
      if (r.match_type === 'tag' && tags.some((t) => t.toLowerCase() === needle)) return Number(r.hourly_rate);
    }
    return 0;
  }

  createTimer(input) {
    const id = uuid(); const now=nowIso(); const startedAt=input.startedAt||now;
    this.run(`INSERT INTO time_entries(id,project_id,activity_name,jira_issue_key,description,tags_json,started_at,ended_at,duration_seconds,billable,source,kimai_project_id,kimai_activity_id,sync_state,fingerprint,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id,input.projectId||null,input.activityName||'',String(input.jiraIssueKey||'').toUpperCase(),input.description||'',JSON.stringify(parseTags(input.tags)),startedAt,null,0,input.billable===false?0:1,'local',input.kimaiProjectId||null,input.kimaiActivityId||null,'local',null,now,now]);
    return this.getTimeEntry(id);
  }
  stopTimer(id, endedAt = nowIso()) {
    return this.transaction(() => {
      const row=this.getTimeEntry(id); if(!row) throw new Error('Timer not found'); if(row.ended_at) return row;
      const duration=durationSeconds(row.started_at,endedAt);
      const entry={...row,ended_at:endedAt,duration_seconds:duration};
      const fingerprint=fingerprintTimeEntry({projectId:row.project_id,kimaiProjectId:row.kimai_project_id,activityName:row.activity_name,kimaiActivityId:row.kimai_activity_id,startedAt:row.started_at,endedAt,description:row.description,jiraIssueKey:row.jira_issue_key,tags:JSON.parse(row.tags_json)});
      this.run('UPDATE time_entries SET ended_at=?,duration_seconds=?,sync_state=?,fingerprint=?,updated_at=? WHERE id=?',[endedAt,duration,'pending',fingerprint,nowIso(),id]);
      this.enqueue('kimai.push',id,{entryId:id},`kimai.push:${id}`);
      return this.getTimeEntry(id);
    });
  }
  saveTimeEntry(input) {
    const id=input.id||uuid(); const now=nowIso(); const tags=parseTags(input.tags); const dur=input.durationSeconds!=null?Number(input.durationSeconds):durationSeconds(input.startedAt,input.endedAt);
    const fp=input.fingerprint||fingerprintTimeEntry(input);
    this.run(`INSERT INTO time_entries(id,project_id,activity_name,jira_issue_key,description,tags_json,started_at,ended_at,duration_seconds,billable,source,kimai_id,kimai_project_id,kimai_activity_id,sync_state,fingerprint,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,activity_name=excluded.activity_name,jira_issue_key=excluded.jira_issue_key,description=excluded.description,tags_json=excluded.tags_json,started_at=excluded.started_at,ended_at=excluded.ended_at,duration_seconds=excluded.duration_seconds,billable=excluded.billable,kimai_project_id=excluded.kimai_project_id,kimai_activity_id=excluded.kimai_activity_id,sync_state=excluded.sync_state,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at`,
      [id,input.projectId||null,input.activityName||'',String(input.jiraIssueKey||'').toUpperCase(),input.description||'',JSON.stringify(tags),input.startedAt,input.endedAt||null,dur,input.billable===false?0:1,input.source||'manual',input.kimaiId||null,input.kimaiProjectId||null,input.kimaiActivityId||null,input.syncState||'pending',fp,now,now]);
    if(input.endedAt && (input.syncState||'pending')==='pending') this.enqueue('kimai.push',id,{entryId:id},`kimai.push:${id}`);
    return this.getTimeEntry(id);
  }
  upsertRemoteTimeEntry(input) {
    const byRemote=input.kimaiId?this.get('SELECT * FROM time_entries WHERE kimai_id=?',[input.kimaiId]):null;
    const byFp=input.fingerprint?this.get('SELECT * FROM time_entries WHERE fingerprint=?',[input.fingerprint]):null;
    if(byRemote||byFp) {
      const current=byRemote||byFp; const id=current.id;
      this.run(`UPDATE time_entries SET project_id=COALESCE(?,project_id),activity_name=?,jira_issue_key=?,description=?,tags_json=?,started_at=?,ended_at=?,duration_seconds=?,billable=?,kimai_id=?,kimai_project_id=?,kimai_activity_id=?,sync_state='synced',fingerprint=?,source=CASE WHEN source='local' THEN source ELSE 'kimai' END,updated_at=? WHERE id=?`,
        [input.projectId||null,input.activityName||'',String(input.jiraIssueKey||'').toUpperCase(),input.description||'',JSON.stringify(parseTags(input.tags)),input.startedAt,input.endedAt||null,Number(input.durationSeconds||durationSeconds(input.startedAt,input.endedAt)),input.billable===false?0:1,input.kimaiId||current.kimai_id||null,input.kimaiProjectId||null,input.kimaiActivityId||null,input.fingerprint||null,nowIso(),id]);
      return this.getTimeEntry(id);
    }
    return this.saveTimeEntry({...input,id:input.id||uuid(),source:'kimai',syncState:'synced'});
  }
  getTimeEntry(id) { return this.get('SELECT * FROM time_entries WHERE id=?',[id]); }
  listRunningTimers() { return this.all(`SELECT t.*,p.name project_name,p.color project_color FROM time_entries t LEFT JOIN projects p ON p.id=t.project_id WHERE t.ended_at IS NULL ORDER BY t.started_at`); }
  listTimeEntries(from,to,projectId=null) {
    const params=[from,to]; let where='t.started_at < ? AND COALESCE(t.ended_at, ?) >= ?';
    params.splice(0,2,to,to,from);
    if(projectId){where+=' AND t.project_id=?';params.push(projectId);}
    return this.all(`SELECT t.*,p.name project_name,p.color project_color,c.name client_name FROM time_entries t LEFT JOIN projects p ON p.id=t.project_id LEFT JOIN clients c ON c.id=p.client_id WHERE ${where} ORDER BY t.started_at`,params);
  }
  deleteTimeEntry(id) { this.transaction(()=>{this.run('DELETE FROM outbox WHERE entity_id=?',[id]);this.run('DELETE FROM time_entries WHERE id=?',[id]);}); }

  enqueue(kind,entityId,payload,dedupeKey) {
    const now=nowIso();
    this.run(`INSERT INTO outbox(id,kind,entity_id,payload_json,dedupe_key,attempts,next_attempt_at,last_error,created_at,updated_at) VALUES(?,?,?,?,?,0,?,NULL,?,?)
      ON CONFLICT(dedupe_key) DO UPDATE SET payload_json=excluded.payload_json,next_attempt_at=excluded.next_attempt_at,last_error=NULL,updated_at=excluded.updated_at`,
      [uuid(),kind,entityId,JSON.stringify(payload||{}),dedupeKey,now,now,now]);
  }
  dueOutbox(limit=50) { return this.all('SELECT * FROM outbox WHERE next_attempt_at<=? ORDER BY created_at LIMIT ?',[nowIso(),limit]); }
  completeOutbox(id) { this.run('DELETE FROM outbox WHERE id=?',[id]); }
  failOutbox(id,error,attempts) { const delay=Math.min(3600,Math.pow(2,Math.min(10,attempts))*15); this.run('UPDATE outbox SET attempts=?,last_error=?,next_attempt_at=?,updated_at=? WHERE id=?',[attempts,String(error).slice(0,2000),new Date(Date.now()+delay*1000).toISOString(),nowIso(),id]); }
  outboxStatus() { return this.get(`SELECT COUNT(*) pending,SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) failed FROM outbox`)||{pending:0,failed:0}; }

  createPayment(input) {
    const project=this.getProject(input.projectId); if(!project) throw new Error('Project not found');
    const id=input.id||uuid(); const existing=this.getPayment(id); const oldScheduleItemId=existing?.schedule_item_id||null;
    const taxRate=Number(input.taxRate ?? this.getProjectTaxRate(input.projectId)); const amount=roundMoney(input.amount); const now=nowIso();
    if(!Number.isFinite(amount)||amount<=0)throw new Error('Payment amount must be greater than zero');
    if(!Number.isFinite(taxRate)||taxRate<0||taxRate>100)throw new Error('Payment tax rate must be between 0 and 100');
    const scheduleItemId=input.scheduleItemId !== undefined ? (input.scheduleItemId||null) : oldScheduleItemId;
    const receiptId=input.receiptId !== undefined ? (input.receiptId||null) : (existing?.receipt_id||null);
    if(scheduleItemId){
      const owned=this.get(`SELECT i.id FROM schedule_items i JOIN payment_schedules s ON s.id=i.schedule_id WHERE i.id=? AND s.project_id=?`,[scheduleItemId,input.projectId]);
      if(!owned)throw new Error('Selected payout schedule item belongs to another project or does not exist');
    }
    this.transaction(()=>{
      const allocationMode=input.autoAllocate===false?'advance':'auto'; const periodStart=input.periodStart||null; const periodEnd=input.periodEnd||null;
      this.run(`INSERT INTO payments(id,project_id,received_at,amount,currency,reference,tax_rate,tax_amount,notes,source,receipt_id,schedule_item_id,allocation_mode,period_start,period_end,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,received_at=excluded.received_at,amount=excluded.amount,currency=excluded.currency,reference=excluded.reference,tax_rate=excluded.tax_rate,tax_amount=excluded.tax_amount,notes=excluded.notes,receipt_id=excluded.receipt_id,schedule_item_id=excluded.schedule_item_id,allocation_mode=excluded.allocation_mode,period_start=excluded.period_start,period_end=excluded.period_end,updated_at=excluded.updated_at`,
        [id,input.projectId,input.receivedAt||now.slice(0,10),amount,input.currency||project.currency||'RUB',input.reference||'',taxRate,roundMoney(amount*taxRate/100),input.notes||'',input.source||existing?.source||'manual',receiptId,scheduleItemId,allocationMode,periodStart,periodEnd,now,now]);
      this.run('DELETE FROM payment_allocations WHERE payment_id=?',[id]);
      if(allocationMode==='auto') this.autoAllocatePayment(id,periodStart,periodEnd);
      else for(const a of input.allocations||[]) this.addAllocation(id,a);
      this.reconcileSchedulePayment(id,oldScheduleItemId);
    });
    return this.getPayment(id);
  }
  getPayment(id){return this.get('SELECT * FROM payments WHERE id=?',[id]);}
  listPayments(projectId=null){
    const select=`SELECT pay.*,p.name project_name,i.label schedule_label,i.due_date schedule_due_date FROM payments pay JOIN projects p ON p.id=pay.project_id LEFT JOIN schedule_items i ON i.id=pay.schedule_item_id`;
    return projectId?this.all(`${select} WHERE pay.project_id=? ORDER BY pay.received_at DESC`,[projectId]):this.all(`${select} ORDER BY pay.received_at DESC`);
  }
  addAllocation(paymentId,a){this.run('INSERT INTO payment_allocations(id,payment_id,time_entry_id,period_start,period_end,amount,hours,note,created_at) VALUES(?,?,?,?,?,?,?,?,?)',[uuid(),paymentId,a.timeEntryId||null,a.periodStart||null,a.periodEnd||null,roundMoney(a.amount||0),Number(a.hours||0),a.note||'',nowIso()]);}
  autoAllocatePayment(paymentId,periodStart=null,periodEnd=null){
    const payment=this.getPayment(paymentId); if(!payment) throw new Error('Payment not found');
    let remaining=Number(payment.amount);
    const params=[payment.project_id]; let filter='t.project_id=? AND t.ended_at IS NOT NULL AND t.billable=1';
    if(periodStart){filter+=' AND t.started_at>=?';params.push(periodStart);} if(periodEnd){filter+=' AND t.started_at<=?';params.push(periodEnd);}
    const entries=this.all(`SELECT t.*,COALESCE(SUM(a.amount),0) allocated_amount,COALESCE(SUM(a.hours),0) allocated_hours FROM time_entries t LEFT JOIN payment_allocations a ON a.time_entry_id=t.id WHERE ${filter} GROUP BY t.id ORDER BY t.started_at`,params);
    for(const e of entries){
      if(remaining<=0.009)break;
      const rate=this.resolveRate(e); const hours=e.duration_seconds/3600; const earned=roundMoney(hours*rate); const unpaid=Math.max(0,earned-Number(e.allocated_amount||0));
      if(unpaid<=0.009)continue; const amount=Math.min(remaining,unpaid); const allocHours=rate>0?Math.min(hours-Number(e.allocated_hours||0),amount/rate):0;
      this.addAllocation(paymentId,{timeEntryId:e.id,amount,hours:allocHours,note:'Автораспределение по старым начислениям'}); remaining=roundMoney(remaining-amount);
    }
    if(remaining>0.009)this.addAllocation(paymentId,{amount:remaining,hours:0,periodStart,periodEnd,note:'Аванс / переплата'});
  }
  deletePayment(id){
    const payment=this.getPayment(id); if(!payment)return;
    this.transaction(()=>{this.run('DELETE FROM payments WHERE id=?',[id]);if(payment.schedule_item_id)this.recomputeScheduleItem(payment.schedule_item_id);});
  }

  recomputeScheduleItem(itemId){
    const item=this.get('SELECT * FROM schedule_items WHERE id=?',[itemId]); if(!item)return;
    const paid=roundMoney(Number(this.get('SELECT COALESCE(SUM(amount),0) total FROM payments WHERE schedule_item_id=?',[itemId])?.total||0));
    const target=Number(item.amount||0); const status=paid<=0.009?'planned':(target<=0.009||paid+0.009>=target?'paid':'partial');
    this.run('UPDATE schedule_items SET paid_amount=?,status=?,updated_at=? WHERE id=?',[paid,status,nowIso(),itemId]);
  }

  reconcileSchedulePayment(paymentId,previousScheduleItemId=null){
    const payment=this.getPayment(paymentId); if(!payment)return;
    let item=payment.schedule_item_id?this.get('SELECT * FROM schedule_items WHERE id=?',[payment.schedule_item_id]):null;
    if(!item){
      item=this.get(`SELECT i.* FROM schedule_items i JOIN payment_schedules s ON s.id=i.schedule_id WHERE s.project_id=? AND i.status IN ('planned','partial') ORDER BY ABS(julianday(i.due_date)-julianday(?)),i.due_date LIMIT 1`,[payment.project_id,payment.received_at]);
      if(item)this.run('UPDATE payments SET schedule_item_id=?,updated_at=? WHERE id=?',[item.id,nowIso(),paymentId]);
    }
    if(previousScheduleItemId&&previousScheduleItemId!==item?.id)this.recomputeScheduleItem(previousScheduleItemId);
    if(item)this.recomputeScheduleItem(item.id);
  }

  saveAdjustment(input){const id=input.id||uuid(),now=nowIso();this.run(`INSERT INTO adjustments(id,project_id,kind,amount,effective_at,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,amount=excluded.amount,effective_at=excluded.effective_at,reason=excluded.reason,updated_at=excluded.updated_at`,[id,input.projectId,input.kind,Number(input.amount),input.effectiveAt||now.slice(0,10),input.reason||'',now,now]);return this.get('SELECT * FROM adjustments WHERE id=?',[id]);}
  listAdjustments(projectId=null){return projectId?this.all('SELECT * FROM adjustments WHERE project_id=? ORDER BY effective_at DESC',[projectId]):this.all('SELECT a.*,p.name project_name FROM adjustments a JOIN projects p ON p.id=a.project_id ORDER BY effective_at DESC');}

  saveSchedule(input){const existing=this.get('SELECT id FROM payment_schedules WHERE project_id=?',[input.projectId]);const id=input.id||existing?.id||uuid(),now=nowIso();this.run(`INSERT INTO payment_schedules(id,project_id,type,config_json,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET type=excluded.type,config_json=excluded.config_json,enabled=excluded.enabled,updated_at=excluded.updated_at`,[id,input.projectId,input.type||'interval',JSON.stringify(input.config||{}),input.enabled===false?0:1,now,now]);return this.get('SELECT * FROM payment_schedules WHERE project_id=?',[input.projectId]);}
  listSchedules(){return this.all('SELECT s.*,p.name project_name,p.fixed_amount FROM payment_schedules s JOIN projects p ON p.id=s.project_id ORDER BY p.name');}
  materializeSchedules(from,to){
    return this.transaction(()=>{
      for(const s of this.listSchedules()){
        const dates=generateScheduleDates({type:s.type,config:JSON.parse(s.config_json),enabled:!!s.enabled},from,to,s.fixed_amount);
        for(const item of dates){const now=nowIso();this.run(`INSERT INTO schedule_items(id,schedule_id,source_key,due_date,label,amount,status,paid_amount,created_at,updated_at) VALUES(?,?,?,?,?,?,'planned',0,?,?) ON CONFLICT(schedule_id,source_key) DO UPDATE SET due_date=excluded.due_date,label=excluded.label,amount=excluded.amount,updated_at=excluded.updated_at`,[uuid(),s.id,item.sourceKey,item.dueDate,item.label,item.amount,now,now]);}
        const keys=dates.map((item)=>item.sourceKey);
        if(keys.length)this.run(`DELETE FROM schedule_items WHERE schedule_id=? AND due_date BETWEEN ? AND ? AND paid_amount=0 AND source_key NOT IN (${keys.map(()=>'?').join(',')})`,[s.id,from,to,...keys]);
        else this.run('DELETE FROM schedule_items WHERE schedule_id=? AND due_date BETWEEN ? AND ? AND paid_amount=0',[s.id,from,to]);
      }
      return this.listScheduleItems(from,to);
    });
  }
  listScheduleItems(from,to){return this.all(`SELECT i.*,s.project_id,p.name project_name,p.color project_color FROM schedule_items i JOIN payment_schedules s ON s.id=i.schedule_id JOIN projects p ON p.id=s.project_id WHERE i.due_date BETWEEN ? AND ? ORDER BY i.due_date`,[from,to]);}
  markScheduleItem(id,status,paidAmount=0){this.run('UPDATE schedule_items SET status=?,paid_amount=?,updated_at=? WHERE id=?',[status,Number(paidAmount),nowIso(),id]);}

  saveReceipt(input){
    const raw=input.raw||{}; const id=input.id||uuid(); const now=nowIso(); const fp=input.fingerprint||require('node:crypto').createHash('sha256').update(`${input.receiptNumber||''}|${input.issuedAt}|${input.amount}|${input.receiptUrl||''}`).digest('hex'); const taxRate=Number(input.taxRate??(input.projectId?this.getProjectTaxRate(input.projectId):this.getSetting('app.taxRate',6)));
    this.run(`INSERT INTO receipts(id,project_id,payment_id,receipt_url,receipt_number,issued_at,amount,tax_rate,tax_amount,buyer,description,status,source,raw_json,fingerprint,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET project_id=COALESCE(excluded.project_id,receipts.project_id),payment_id=COALESCE(excluded.payment_id,receipts.payment_id),receipt_url=excluded.receipt_url,receipt_number=excluded.receipt_number,issued_at=excluded.issued_at,amount=excluded.amount,tax_rate=excluded.tax_rate,tax_amount=excluded.tax_amount,buyer=excluded.buyer,description=excluded.description,status=excluded.status,source=excluded.source,raw_json=excluded.raw_json,updated_at=excluded.updated_at`,[id,input.projectId||null,input.paymentId||null,input.receiptUrl||'',input.receiptNumber||'',input.issuedAt,roundMoney(input.amount),taxRate,roundMoney(Number(input.amount)*taxRate/100),input.buyer||'',input.description||'',input.status||'active',input.source||'npd',JSON.stringify(raw),fp,now,now]);
    return this.get('SELECT * FROM receipts WHERE fingerprint=?',[fp]);
  }
  listReceipts(){return this.all(`SELECT r.*,p.name project_name,pay.reference payment_reference FROM receipts r LEFT JOIN projects p ON p.id=r.project_id LEFT JOIN payments pay ON pay.id=r.payment_id ORDER BY r.issued_at DESC`);}
  linkReceipt(receiptId,paymentId,projectId=null){
    const receipt=this.get('SELECT * FROM receipts WHERE id=?',[receiptId]); if(!receipt)throw new Error('Receipt not found');
    const payment=this.getPayment(paymentId); if(!payment)throw new Error('Payment not found');
    if(projectId&&projectId!==payment.project_id)throw new Error('Receipt project must match the payment project');
    const resolvedProjectId=projectId||payment.project_id;
    this.transaction(()=>{
      if(receipt.payment_id&&receipt.payment_id!==paymentId)this.run('UPDATE payments SET receipt_id=NULL,updated_at=? WHERE id=? AND receipt_id=?',[nowIso(),receipt.payment_id,receiptId]);
      this.run('UPDATE receipts SET payment_id=?,project_id=?,updated_at=? WHERE id=?',[paymentId,resolvedProjectId,nowIso(),receiptId]);
      this.run('UPDATE payments SET receipt_id=?,updated_at=? WHERE id=?',[receiptId,nowIso(),paymentId]);
    });
    return this.get('SELECT * FROM receipts WHERE id=?',[receiptId]);
  }

  saveJiraIssues(issues){this.transaction(()=>{for(const i of issues)this.run(`INSERT INTO jira_issues(key,project_key,summary,status,assignee,url,raw_json,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET project_key=excluded.project_key,summary=excluded.summary,status=excluded.status,assignee=excluded.assignee,url=excluded.url,raw_json=excluded.raw_json,updated_at=excluded.updated_at`,[i.key,i.projectKey||i.key.split('-')[0],i.summary||'',i.status||'',i.assignee||'',i.url||'',JSON.stringify(i.raw||i),nowIso()]);});}
  searchJiraIssues(query=''){const q=`%${query.toLowerCase()}%`;return this.all(`SELECT * FROM jira_issues WHERE lower(key) LIKE ? OR lower(summary) LIKE ? ORDER BY updated_at DESC LIMIT 100`,[q,q]);}

  logSync(integration,direction,status,message,details={}){this.run('INSERT INTO sync_log(id,integration,direction,status,message,details_json,created_at) VALUES(?,?,?,?,?,?,?)',[uuid(),integration,direction,status,message,JSON.stringify(details),nowIso()]);}
  listSyncLog(limit=100){return this.all('SELECT * FROM sync_log ORDER BY created_at DESC LIMIT ?',[limit]);}

  projectFinancials(projectId,from=null,to=null){
    const project=this.getProject(projectId); if(!project)return null;
    const params=[projectId]; let tf='project_id=? AND ended_at IS NOT NULL AND billable=1'; let pf='project_id=?'; let af='project_id=?';
    if(from){tf+=' AND started_at>=?';pf+=' AND received_at>=?';af+=' AND effective_at>=?';params.push(from);} if(to){tf+=' AND started_at<=?';pf+=' AND received_at<=?';af+=' AND effective_at<=?';}
    const tParams=[projectId,...(from?[from]:[]),...(to?[to]:[])]; const pParams=[projectId,...(from?[from]:[]),...(to?[to]:[])]; const aParams=[projectId,...(from?[from]:[]),...(to?[to]:[])];
    const entries=this.all(`SELECT * FROM time_entries WHERE ${tf} ORDER BY started_at`,tParams);
    const payments=this.all(`SELECT * FROM payments WHERE ${pf}`,pParams);
    const adjustments=this.all(`SELECT * FROM adjustments WHERE ${af}`,aParams);
    const entryIds=entries.map((entry)=>entry.id);
    const allocations=entryIds.length?this.all(`SELECT * FROM payment_allocations WHERE time_entry_id IN (${entryIds.map(()=>'?').join(',')})`,entryIds):[];
    let earned=0,hours=0; const perEntry=[];
    for(const e of entries){const rate=this.resolveRate(e),h=e.duration_seconds/3600,amount=roundMoney(h*rate);earned+=amount;hours+=h;perEntry.push({id:e.id,hours:h,rate,amount});}
    if(project.billing_mode==='fixed'){
      const includeFixed=!from&&!to || (!project.end_date && !from) || (project.end_date && (!from||project.end_date>=String(from).slice(0,10)) && (!to||project.end_date<=String(to).slice(0,10)));
      earned=includeFixed?Number(project.fixed_amount||0):0;
    }
    const moneyAdj=adjustments.filter(a=>a.kind==='money').reduce((s,a)=>s+Number(a.amount),0); const hoursAdj=adjustments.filter(a=>a.kind==='hours').reduce((s,a)=>s+Number(a.amount),0);
    const paid=payments.reduce((s,p)=>s+Number(p.amount),0); const tax=payments.reduce((s,p)=>s+Number(p.tax_amount),0); const allocatedHours=allocations.reduce((s,a)=>s+Number(a.hours||0),0); const allocatedAmount=allocations.reduce((s,a)=>s+Number(a.amount||0),0);
    return {project,earned:roundMoney(earned+moneyAdj),workedHours:Math.round((hours+hoursAdj)*100)/100,paid:roundMoney(paid),tax:roundMoney(tax),netPaid:roundMoney(paid-tax),moneyDebt:roundMoney(earned+moneyAdj-paid),unpaidHours:Math.round(Math.max(0,hours+hoursAdj-allocatedHours)*100)/100,overpayment:roundMoney(Math.max(0,paid-(earned+moneyAdj))),allocatedAmount:roundMoney(allocatedAmount),entries:perEntry};
  }

  dashboard(from,to){
    const projects=this.listProjects().filter(p=>p.active); const financials=projects.map(p=>this.projectFinancials(p.id,from,to)).filter(Boolean);
    const entries=this.listTimeEntries(from,to); const daily=new Map();
    for(const e of entries){if(!e.ended_at)continue;const day=e.started_at.slice(0,10);const rate=this.resolveRate(e);daily.set(day,(daily.get(day)||0)+(e.duration_seconds/3600)*rate);}
    const horizonDays=Number(this.getSetting('app.forecastDays',30)); const horizonTo=new Date(Date.now()+horizonDays*86400000); const workdays=workingDaysBetween(new Date(),horizonTo); const projected=forecast([...daily.values()],workdays);
    const totals=financials.reduce((a,f)=>({earned:a.earned+f.earned,paid:a.paid+f.paid,tax:a.tax+f.tax,debt:a.debt+Math.max(0,f.moneyDebt),overpayment:a.overpayment+f.overpayment,hours:a.hours+f.workedHours,unpaidHours:a.unpaidHours+f.unpaidHours}),{earned:0,paid:0,tax:0,debt:0,overpayment:0,hours:0,unpaidHours:0});
    return {from,to,totals:Object.fromEntries(Object.entries(totals).map(([k,v])=>[k,roundMoney(v)])),projects:financials,forecast:projected,running:this.listRunningTimers(),outbox:this.outboxStatus(),recentSync:this.listSyncLog(20)};
  }

  async backupTo(destination){await backup(this.db,destination);return destination;}
  exportJson(){
    const tables=['settings','clients','projects','rate_rules','time_entries','payments','payment_allocations','payment_schedules','schedule_items','receipts','adjustments','jira_issues','sync_log'];
    return {format:'tempoweave-export-v1',exportedAt:nowIso(),data:Object.fromEntries(tables.map(t=>[t,this.all(`SELECT * FROM ${t}`)]))};
  }
}

module.exports={Store};
