'use strict';

const state = {
  view: 'dashboard',
  data: null,
  dashboard: null,
  entries: [],
  scheduleItems: [],
  paymentScheduleItems: [],
  weekStart: monday(new Date()),
  editing: {}
};

const titles = {
  dashboard: ['Обзор', 'Доход, загрузка и расчёты'],
  week: ['Неделя', 'Календарь загрузки, параллельная работа и выплаты'],
  timers: ['Таймеры', 'Оффлайн и параллельный учёт времени'],
  projects: ['Проекты и ставки', 'Контрагенты, правила тарификации и графики выплат'],
  money: ['Выплаты и долги', 'Начислено, получено, налоги и расхождения'],
  receipts: ['Чеки НПД', 'Импорт чеков ФНС и сверка с выплатами'],
  integrations: ['Интеграции', 'Kimai и Jira без передачи токенов третьим сторонам'],
  settings: ['Настройки', 'Локальные параметры и резервное копирование']
};

const content = document.getElementById('content');
const pageTitle = document.getElementById('page-title');
const pageSubtitle = document.getElementById('page-subtitle');
const dialog = document.getElementById('quick-dialog');
const quickForm = document.getElementById('quick-timer-form');

function unwrap(result) {
  if (!result?.ok) throw new Error(result?.error || 'Unknown application error');
  return result.data;
}

async function call(promise, successMessage = '') {
  try {
    const result = unwrap(await promise);
    if (successMessage) toast(successMessage, 'ok');
    return result;
  } catch (error) {
    toast(error.message || String(error), 'error');
    throw error;
  }
}

function toast(message, type = '') {
  const host = document.getElementById('toast-host');
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[ch]));
}

function fmtMoney(value, currency = 'RUB') {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value || 0));
}
function fmtHours(value) { return `${Number(value || 0).toFixed(2).replace('.', ',')} ч`; }
function fmtDate(value, options = { day: '2-digit', month: 'short' }) { return new Intl.DateTimeFormat('ru-RU', options).format(new Date(value)); }
function localDate(date) {
  const d = new Date(date); const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function localDateTime(date) {
  const d = new Date(date); const pad = (n) => String(n).padStart(2, '0');
  return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function monday(date) {
  const d = new Date(date); d.setHours(0,0,0,0); const day = d.getDay(); d.setDate(d.getDate() + (day === 0 ? -6 : 1-day)); return d;
}
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate()+n); return d; }
function monthRange() { const d = new Date(); return { from: new Date(d.getFullYear(), d.getMonth(), 1).toISOString(), to: new Date(d.getFullYear(), d.getMonth()+1, 1).toISOString() }; }
function formData(form) { return Object.fromEntries(new FormData(form).entries()); }
function projectById(id) { return state.data.projects.find((p) => p.id === id); }
function clientById(id) { return state.data.clients.find((c) => c.id === id); }
function optionProjects(selected = '') {
  return `<option value="">Без проекта</option>${state.data.projects.filter(p=>p.active).map((p)=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${esc(p.name)}</option>`).join('')}`;
}
function optionClients(selected = '') {
  return `<option value="">Без контрагента</option>${state.data.clients.map((c)=>`<option value="${c.id}" ${c.id===selected?'selected':''}>${esc(c.name)}</option>`).join('')}`;
}
function statusBadge(value) {
  const map = { synced:['Синхронизировано','good'], pending:['В очереди','warn'], failed:['Ошибка','bad'], local:['Локально',''], remote:['Из Kimai','good'] };
  const [label, cls] = map[value] || [value || '—','']; return `<span class="badge ${cls}">${esc(label)}</span>`;
}
function serializeConfig(form, type) {
  const d = formData(form);
  if (type === 'interval') return { anchorDate: d.anchorDate, everyDays: Number(d.everyDays || 14), amount: Number(d.amount || 0), label: d.label || '' };
  if (type === 'monthly') return { dayOfMonth: Number(d.dayOfMonth || 1), amount: Number(d.amount || 0), label: d.label || '' };
  const items = String(d.items || '').split('\n').map(s=>s.trim()).filter(Boolean).map((line) => {
    const [date, amountOrPercent, ...labelParts] = line.split('|').map(x=>x.trim());
    const item = { date, label: labelParts.join(' | ') || 'Выплата' };
    if (String(amountOrPercent).endsWith('%')) item.percent = Number(amountOrPercent.slice(0,-1)); else item.amount = Number(amountOrPercent || 0);
    return item;
  });
  return { items };
}

async function refreshBootstrap() {
  state.data = await call(window.tempo.bootstrap());
  populateQuickTimer();
}

function populateQuickTimer() {
  const select = quickForm.elements.projectId;
  select.innerHTML = optionProjects();
}

async function navigate(view) {
  state.view = view;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  pageTitle.textContent = titles[view][0]; pageSubtitle.textContent = titles[view][1];
  await render();
}

async function render() {
  if (state.view === 'dashboard') return renderDashboard();
  if (state.view === 'week') return renderWeek();
  if (state.view === 'timers') return renderTimers();
  if (state.view === 'projects') return renderProjects();
  if (state.view === 'money') return renderMoney();
  if (state.view === 'receipts') return renderReceipts();
  if (state.view === 'integrations') return renderIntegrations();
  if (state.view === 'settings') return renderSettings();
}

async function renderDashboard() {
  const range = monthRange();
  state.dashboard = await call(window.tempo.dashboard(range));
  const d = state.dashboard, t = d.totals;
  const debtClass = t.debt > 0 ? 'negative' : 'positive';
  content.innerHTML = `
    <div class="grid cols-4">
      ${metric('Начислено', fmtMoney(t.earned), `${fmtHours(t.hours)} за текущий месяц`)}
      ${metric('Получено', fmtMoney(t.paid), `После налога: ${fmtMoney(t.paid-t.tax)}`, 'positive')}
      ${metric('Налог НПД', fmtMoney(t.tax), `${state.data.settings['app.taxRate'] || 6}% с выплат`, 'warning')}
      ${metric('Долг клиентов', fmtMoney(t.debt), `Переплата ${fmtMoney(t.overpayment)} · ${fmtHours(t.unpaidHours)} не закрыто`, debtClass)}
    </div>
    <div class="grid cols-2 section-gap">
      <div class="card">
        <div class="card-head"><div><h2>Финансы по проектам</h2><p>Начисления по ставкам против фактических выплат</p></div><span class="badge">${d.projects.length} проектов</span></div>
        ${d.projects.length ? d.projects.map(projectFinancialRow).join('') : '<div class="empty">Добавьте проект и ставку, чтобы увидеть аналитику.</div>'}
      </div>
      <div class="card">
        <div class="card-head"><div><h2>Прогноз на ${state.data.settings['app.forecastDays'] || 30} дней</h2><p>По недавней выработке, рабочим дням и ограниченному тренду</p></div><span class="badge ${d.forecast.confidence==='high'?'good':'warn'}">${esc(d.forecast.confidence)}</span></div>
        <div class="metric-value">${fmtMoney(d.forecast.expected)}</div>
        <div class="muted">Коридор: ${fmtMoney(d.forecast.low)} — ${fmtMoney(d.forecast.high)}</div>
        <div class="progress"><span style="width:${Math.min(100,Math.max(4,d.forecast.expected?70:4))}%"></span></div>
        <div class="grid cols-3 section-gap">
          <div><small class="muted">Ожидаемо/день</small><b>${fmtMoney(d.forecast.daily)}</b></div>
          <div><small class="muted">Тренд/день</small><b class="${d.forecast.trend>=0?'positive':'negative'}">${fmtMoney(d.forecast.trend)}</b></div>
          <div><small class="muted">Очередь Kimai</small><b>${d.outbox.pending || 0}</b></div>
        </div>
      </div>
    </div>
    <div class="grid cols-2 section-gap">
      <div class="card"><div class="card-head"><div><h2>Активные таймеры</h2><p>Параллельные сессии сохраняются оффлайн</p></div><button class="small-btn primary" data-action="open-timer">Запустить</button></div>${renderRunning(d.running)}</div>
      <div class="card"><div class="card-head"><div><h2>Последняя синхронизация</h2><p>Журнал Kimai и Jira</p></div></div>${renderSyncLog(d.recentSync)}</div>
    </div>`;
}

function metric(label, value, note, cls='') {
  return `<div class="card metric"><div class="metric-label">${label}</div><div class="metric-value ${cls}">${value}</div><div class="metric-note">${note}</div></div>`;
}
function projectFinancialRow(f) {
  const debt = f.moneyDebt;
  return `<div class="project-fin"><div><b><span class="color-dot" style="background:${esc(f.project.color)}"></span>${esc(f.project.name)}</b><small>${esc(f.project.client_name || '')}</small></div><div><small>Часы</small><b>${fmtHours(f.workedHours)}</b></div><div><small>Начислено</small><b>${fmtMoney(f.earned,f.project.currency)}</b></div><div><small>Получено</small><b>${fmtMoney(f.paid,f.project.currency)}</b></div><div><small>${debt>=0?'Долг':'Переплата'}</small><b class="${debt>0?'negative':'positive'}">${fmtMoney(Math.abs(debt),f.project.currency)}</b></div></div>`;
}
function renderRunning(running) {
  if (!running?.length) return '<div class="empty">Сейчас ничего не запущено.</div>';
  return `<div class="timer-list">${running.map(timerCard).join('')}</div>`;
}
function timerCard(t) {
  return `<div class="timer-card" style="--project-color:${esc(t.project_color || '#8b7cff')}"><div><b>${esc(t.project_name || 'Без проекта')}</b><div class="tiny muted">${esc(t.jira_issue_key || t.activity_name || 'Без активности')}</div></div><div class="clock live-clock" data-start="${esc(t.started_at)}">00:00:00</div><div class="timer-meta"><span>${esc(t.description || 'Без описания')}</span><button class="small-btn danger" data-action="stop-timer" data-id="${t.id}">Стоп</button></div></div>`;
}
function renderSyncLog(rows) {
  if (!rows?.length) return '<div class="empty">Синхронизаций ещё не было.</div>';
  return `<table><tbody>${rows.slice(0,8).map(r=>`<tr><td>${r.status==='ok'?'<span class="positive">●</span>':'<span class="negative">●</span>'}</td><td><b>${esc(r.integration)}</b><div class="tiny muted">${esc(r.direction)}</div></td><td>${esc(r.message)}</td><td class="tiny muted">${fmtDate(r.created_at,{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</td></tr>`).join('')}</tbody></table>`;
}

async function renderWeek() {
  const start = state.weekStart, end = addDays(start, 7);
  state.entries = await call(window.tempo.entries.list({ from:start.toISOString(), to:end.toISOString() }));
  state.scheduleItems = await call(window.tempo.schedules.materialize({ from:localDate(start), to:localDate(addDays(start,6)) }));
  const days = Array.from({length:7},(_,i)=>addDays(start,i));
  const dayStats = days.map((day) => {
    const date = localDate(day); const rows = state.entries.filter(e=>localDate(e.started_at)===date);
    const hours = rows.reduce((s,e)=>s+Number(e.duration_seconds||0)/3600,0);
    const money = rows.reduce((s,e)=>s+(Number(e.duration_seconds||0)/3600)*resolveRateClient(e),0);
    return {date,rows,hours,money,payouts:state.scheduleItems.filter(i=>i.due_date===date)};
  });
  content.innerHTML = `
    <div class="toolbar"><div class="toolbar-group"><button data-action="week-prev">←</button><label>Неделя<input id="week-picker" type="date" value="${localDate(start)}"></label><button data-action="week-next">→</button><button data-action="week-today" class="ghost">Сегодня</button></div><div class="toolbar-group"><button data-action="add-manual-entry" class="ghost">＋ Запись</button><button data-action="open-timer" class="primary">＋ Таймер</button></div></div>
    <div class="week-shell">
      <div class="week-summary"><div></div>${dayStats.map((s,i)=>`<div class="day-head ${localDate(new Date())===s.date?'today':''}"><b>${fmtDate(days[i],{weekday:'short',day:'2-digit',month:'2-digit'})}</b><small>${fmtHours(s.hours)} · ${fmtMoney(s.money)}</small>${s.payouts.map(p=>`<span class="payout-chip">${esc(p.label)} ${fmtMoney(p.amount)}</span>`).join('')}</div>`).join('')}</div>
      <div class="week-grid"><div class="time-axis">${Array.from({length:19},(_,i)=>`<span class="time-label" style="top:${i*60}px">${String(i+6).padStart(2,'0')}:00</span>`).join('')}</div>${dayStats.map((s,i)=>renderDayColumn(s,days[i])).join('')}</div>
    </div>`;
  document.getElementById('week-picker').addEventListener('change', (e)=>{state.weekStart=monday(new Date(`${e.target.value}T12:00:00`));renderWeek();});
}

function resolveRateClient(entry) {
  const date = entry.started_at.slice(0,10); const rules = state.data.rateRules.filter(r=>r.active && (!r.project_id || r.project_id===entry.project_id) && (!r.valid_from||r.valid_from<=date) && (!r.valid_to||r.valid_to>=date)).sort((a,b)=>b.priority-a.priority);
  const tags = JSON.parse(entry.tags_json || '[]');
  for (const r of rules) {
    const n=String(r.match_value||'').toLowerCase();
    if(r.match_type==='global') return Number(r.hourly_rate);
    if(r.match_type==='project' && (!n || r.project_id===entry.project_id)) return Number(r.hourly_rate);
    if(r.match_type==='activity' && String(entry.activity_name||'').toLowerCase().includes(n)) return Number(r.hourly_rate);
    if(r.match_type==='jira' && String(entry.jira_issue_key||'').toLowerCase().startsWith(n)) return Number(r.hourly_rate);
    if(r.match_type==='tag' && tags.some(t=>String(t).toLowerCase()===n)) return Number(r.hourly_rate);
  }
  return 0;
}

function renderDayColumn(stat, day) {
  const laid = layoutEntries(stat.rows);
  return `<div class="day-column ${localDate(new Date())===stat.date?'today':''}" data-date="${stat.date}">${laid.map(({e,lane,lanes})=>{
    const start=new Date(e.started_at), end=e.ended_at?new Date(e.ended_at):new Date(); const top=Math.max(0,(start.getHours()+start.getMinutes()/60-6)*60); const rawHeight=Math.max(18,(end-start)/60000); const height=Math.min(1080-top,rawHeight); const width=100/lanes; const p=projectById(e.project_id);
    return `<button class="calendar-entry" data-action="edit-entry" data-id="${e.id}" style="top:${top}px;height:${height}px;left:calc(${lane*width}% + 2px);width:calc(${width}% - 4px);background:${esc(p?.color||'#59627d')}"><b>${esc(p?.name||'Без проекта')}</b><span>${esc(e.jira_issue_key||e.activity_name||e.description||'')}</span></button>`;
  }).join('')}</div>`;
}
function layoutEntries(entries) {
  const sorted=[...entries].sort((a,b)=>new Date(a.started_at)-new Date(b.started_at)); const active=[]; const placed=[]; let maxLane=1;
  for(const e of sorted){const start=new Date(e.started_at).getTime(); for(let i=active.length-1;i>=0;i--)if(active[i].end<=start)active.splice(i,1); const used=new Set(active.map(a=>a.lane)); let lane=0; while(used.has(lane))lane++; const end=new Date(e.ended_at||Date.now()).getTime(); active.push({lane,end}); maxLane=Math.max(maxLane,active.length,lane+1); placed.push({e,lane});}
  return placed.map(x=>({...x,lanes:maxLane}));
}

async function renderTimers() {
  const running = await call(window.tempo.timers.running());
  content.innerHTML = `
    <div class="card"><div class="card-head"><div><h2>Запустить таймер</h2><p>Работает без сети; завершённая запись попадёт в очередь Kimai</p></div><span class="badge">параллельные разрешены</span></div>
      <form id="timer-form" class="form-grid"><label>Проект<select name="projectId" required>${optionProjects()}</select></label><label>Активность<input name="activityName" placeholder="Разработка"></label><label>Jira<input name="jiraIssueKey" placeholder="ABC-123"></label><label>Теги<input name="tags" placeholder="backend, urgent"></label><label class="wide">Описание<input name="description" placeholder="Задача и результат"></label><label>Начало<input type="datetime-local" name="startedAt" value="${localDateTime(new Date())}"></label><button class="primary">Запустить</button></form>
    </div>
    <div class="card section-gap"><div class="card-head"><div><h2>Активные</h2><p>${running.length} запущено</p></div></div>${renderRunning(running)}</div>
    <div class="card section-gap"><div class="card-head"><div><h2>Недавние записи</h2><p>Последние семь дней</p></div><button data-action="add-manual-entry" class="ghost small-btn">Добавить вручную</button></div><div id="recent-entries">Загрузка…</div></div>`;
  document.getElementById('timer-form').addEventListener('submit', async (e)=>{e.preventDefault();const d=formData(e.target);await call(window.tempo.timers.start({...d,startedAt:new Date(d.startedAt).toISOString()}),'Таймер запущен');await refreshBootstrap();renderTimers();});
  const rows = await call(window.tempo.entries.list({from:addDays(new Date(),-7).toISOString(),to:addDays(new Date(),1).toISOString()}));
  document.getElementById('recent-entries').innerHTML = renderEntriesTable(rows);
}
function renderEntriesTable(rows) {
  if(!rows.length)return '<div class="empty">Записей пока нет.</div>';
  return `<table><thead><tr><th>Дата</th><th>Проект / задача</th><th>Время</th><th>Сумма</th><th>Sync</th><th></th></tr></thead><tbody>${rows.slice().reverse().map(e=>`<tr><td>${fmtDate(e.started_at,{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</td><td><b>${esc(e.project_name||'Без проекта')}</b><div class="tiny muted">${esc(e.jira_issue_key||e.description||e.activity_name)}</div></td><td>${fmtHours(e.duration_seconds/3600)}</td><td>${fmtMoney(e.duration_seconds/3600*resolveRateClient(e),projectById(e.project_id)?.currency||'RUB')}</td><td>${statusBadge(e.sync_state)}</td><td><div class="actions"><button class="small-btn" data-action="edit-entry" data-id="${e.id}">Изм.</button><button class="small-btn danger" data-action="delete-entry" data-id="${e.id}">×</button></div></td></tr>`).join('')}</tbody></table>`;
}

async function renderProjects() {
  const editClient=state.editing.client||{}; const editProject=state.editing.project||{}; const editRate=state.editing.rate||{}; const editSchedule=state.editing.schedule||{};
  content.innerHTML = `
    <div class="grid cols-2">
      <div class="card"><div class="card-head"><div><h2>Контрагент</h2><p>Валюта и ставка налога по умолчанию</p></div></div><form id="client-form" class="form-grid"><input type="hidden" name="id" value="${esc(editClient.id||'')}"><label class="wide">Название<input name="name" required value="${esc(editClient.name||'')}"></label><label>Валюта<select name="currency"><option ${editClient.currency==='RUB'?'selected':''}>RUB</option><option ${editClient.currency==='USD'?'selected':''}>USD</option><option ${editClient.currency==='EUR'?'selected':''}>EUR</option></select></label><label>Налог, %<input name="taxRate" type="number" step="0.01" value="${editClient.tax_rate??6}"></label><label>Активен<select name="active"><option value="true">Да</option><option value="false" ${editClient.active===0?'selected':''}>Нет</option></select></label><button class="primary">${editClient.id?'Сохранить':'Добавить'}</button></form><div class="section-gap">${renderClientsTable()}</div></div>
      <div class="card"><div class="card-head"><div><h2>Проект</h2><p>Связи с Kimai/Jira и способ расчёта</p></div></div><form id="project-form" class="form-grid"><input type="hidden" name="id" value="${esc(editProject.id||'')}"><label>Название<input name="name" required value="${esc(editProject.name||'')}"></label><label>Контрагент<select name="clientId">${optionClients(editProject.client_id)}</select></label><label>Цвет<input name="color" type="color" value="${esc(editProject.color||'#6d5dfc')}"></label><label>Валюта<select name="currency"><option ${editProject.currency==='RUB'?'selected':''}>RUB</option><option ${editProject.currency==='USD'?'selected':''}>USD</option><option ${editProject.currency==='EUR'?'selected':''}>EUR</option></select></label><label>Модель<select name="billingMode"><option value="hourly" ${editProject.billing_mode==='hourly'?'selected':''}>Почасовая</option><option value="fixed" ${editProject.billing_mode==='fixed'?'selected':''}>Фиксированная</option></select></label><label>Сумма проекта<input name="fixedAmount" type="number" step="0.01" value="${editProject.fixed_amount||0}"></label><label>Kimai project ID<input name="kimaiProjectId" type="number" value="${editProject.kimai_project_id||''}"></label><label>Kimai activity ID<input name="kimaiActivityId" type="number" value="${editProject.kimai_activity_id||''}"></label><label>Jira key<input name="jiraProjectKey" value="${esc(editProject.jira_project_key||'')}"></label><label>Старт<input name="startDate" type="date" value="${esc(editProject.start_date||'')}"></label><label>Финиш<input name="endDate" type="date" value="${esc(editProject.end_date||'')}"></label><label>Активен<select name="active"><option value="true">Да</option><option value="false" ${editProject.active===0?'selected':''}>Нет</option></select></label><label class="wide">Заметки<input name="notes" value="${esc(editProject.notes||'')}"></label><button class="primary">${editProject.id?'Сохранить':'Добавить'}</button></form></div>
    </div>
    <div class="card section-gap"><div class="card-head"><div><h2>Проекты</h2><p>Кликните «Изменить», чтобы настроить связи</p></div></div>${renderProjectsTable()}</div>
    <div class="grid cols-2 section-gap">
      <div class="card"><div class="card-head"><div><h2>Правило ставки</h2><p>Приоритет: Jira → активность → тег → проект → глобальная</p></div></div><form id="rate-form" class="form-grid"><input type="hidden" name="id" value="${esc(editRate.id||'')}"><label>Проект<select name="projectId">${optionProjects(editRate.project_id)}</select></label><label>Тип<select name="matchType"><option value="global">Глобальная</option><option value="project" ${editRate.match_type==='project'?'selected':''}>Проект</option><option value="activity" ${editRate.match_type==='activity'?'selected':''}>Активность</option><option value="jira" ${editRate.match_type==='jira'?'selected':''}>Jira prefix</option><option value="tag" ${editRate.match_type==='tag'?'selected':''}>Тег</option></select></label><label>Значение<input name="matchValue" value="${esc(editRate.match_value||'')}" placeholder="ABC / backend"></label><label>Ставка/час<input name="hourlyRate" type="number" required step="0.01" value="${editRate.hourly_rate||''}"></label><label>Приоритет<input name="priority" type="number" value="${editRate.priority||0}"></label><label>С<input name="validFrom" type="date" value="${esc(editRate.valid_from||'')}"></label><label>До<input name="validTo" type="date" value="${esc(editRate.valid_to||'')}"></label><button class="primary">Сохранить</button></form>${renderRatesTable()}</div>
      <div class="card"><div class="card-head"><div><h2>График выплат</h2><p>Раз в N дней, ежемесячно, этапами или произвольно</p></div></div><form id="schedule-form" class="form-grid"><label>Проект<select name="projectId" required>${optionProjects(editSchedule.project_id)}</select></label><label>Тип<select name="type" id="schedule-type"><option value="interval">Каждые N дней</option><option value="monthly" ${editSchedule.type==='monthly'?'selected':''}>Ежемесячно</option><option value="milestone" ${editSchedule.type==='milestone'?'selected':''}>Этапы</option><option value="custom" ${editSchedule.type==='custom'?'selected':''}>Произвольно</option></select></label><div id="schedule-fields" class="full"></div><button class="primary">Сохранить график</button></form><div class="section-gap">${renderSchedulesTable()}</div></div>
    </div>`;
  bindProjectForms(editSchedule);
}
function renderClientsTable(){const rows=state.data.clients;if(!rows.length)return '<div class="empty">Контрагентов пока нет.</div>';return `<table><thead><tr><th>Контрагент</th><th>Налог</th><th></th></tr></thead><tbody>${rows.map(c=>`<tr><td><b>${esc(c.name)}</b><div class="tiny muted">${esc(c.currency)} · ${c.active?'активен':'архив'}</div></td><td>${Number(c.tax_rate).toFixed(2).replace('.',',')}%</td><td><button class="small-btn" data-action="edit-client" data-id="${c.id}">Изменить</button></td></tr>`).join('')}</tbody></table>`;}
function renderProjectsTable(){if(!state.data.projects.length)return '<div class="empty">Проектов пока нет.</div>';return `<table><thead><tr><th>Проект</th><th>Контрагент</th><th>Модель</th><th>Kimai</th><th>Jira</th><th></th></tr></thead><tbody>${state.data.projects.map(p=>`<tr><td><b><span class="color-dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</b><div class="tiny muted">${p.active?'активен':'архив'}</div></td><td>${esc(p.client_name||'—')}</td><td>${p.billing_mode==='fixed'?`Фикс ${fmtMoney(p.fixed_amount,p.currency)}`:'Почасовая'}</td><td>${p.kimai_project_id||'—'} / ${p.kimai_activity_id||'—'}</td><td>${esc(p.jira_project_key||'—')}</td><td><button class="small-btn" data-action="edit-project" data-id="${p.id}">Изменить</button></td></tr>`).join('')}</tbody></table>`;}
function renderRatesTable(){const rows=state.data.rateRules;if(!rows.length)return '<div class="empty section-gap">Добавьте хотя бы глобальную ставку.</div>';return `<table class="section-gap"><thead><tr><th>Правило</th><th>Ставка</th><th>Приор.</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.match_type)}: ${esc(r.match_value||'все')}<div class="tiny muted">${esc(projectById(r.project_id)?.name||'глобально')}</div></td><td>${fmtMoney(r.hourly_rate,projectById(r.project_id)?.currency||'RUB')}</td><td>${r.priority}</td><td><div class="actions"><button class="small-btn" data-action="edit-rate" data-id="${r.id}">Изм.</button><button class="small-btn danger" data-action="delete-rate" data-id="${r.id}">×</button></div></td></tr>`).join('')}</tbody></table>`;}
function renderSchedulesTable(){const rows=state.data.schedules;if(!rows.length)return '<div class="empty">Графики не настроены.</div>';return `<table><tbody>${rows.map(s=>`<tr><td><b>${esc(s.project_name)}</b></td><td>${esc(s.type)}</td><td><button class="small-btn" data-action="edit-schedule" data-id="${s.id}">Изменить</button></td></tr>`).join('')}</tbody></table>`;}
function bindProjectForms(editSchedule){
  document.getElementById('client-form').addEventListener('submit',async e=>{e.preventDefault();const d=formData(e.target);await call(window.tempo.clients.save({...d,taxRate:Number(d.taxRate),active:d.active==='true'}),'Контрагент сохранён');state.editing.client=null;await refreshBootstrap();renderProjects();});
  document.getElementById('project-form').addEventListener('submit',async e=>{e.preventDefault();const d=formData(e.target);await call(window.tempo.projects.save({...d,active:d.active==='true',fixedAmount:Number(d.fixedAmount||0),kimaiProjectId:d.kimaiProjectId?Number(d.kimaiProjectId):null,kimaiActivityId:d.kimaiActivityId?Number(d.kimaiActivityId):null}),'Проект сохранён');state.editing.project=null;await refreshBootstrap();renderProjects();});
  document.getElementById('rate-form').addEventListener('submit',async e=>{e.preventDefault();const d=formData(e.target);await call(window.tempo.rates.save({...d,hourlyRate:Number(d.hourlyRate),priority:Number(d.priority||0)}),'Ставка сохранена');state.editing.rate=null;await refreshBootstrap();renderProjects();});
  const type=document.getElementById('schedule-type'); const fields=document.getElementById('schedule-fields');
  const paint=()=>{let cfg={};try{cfg=JSON.parse(editSchedule.config_json||'{}')}catch{};if(type.value==='interval')fields.innerHTML=`<div class="form-grid"><label>Опорная дата<input name="anchorDate" type="date" value="${cfg.anchorDate||localDate(new Date())}"></label><label>Каждые, дней<input name="everyDays" type="number" min="1" value="${cfg.everyDays||14}"></label><label>Сумма<input name="amount" type="number" step="0.01" value="${cfg.amount||0}"></label><label>Название<input name="label" value="${esc(cfg.label||'')}"></label></div>`;else if(type.value==='monthly')fields.innerHTML=`<div class="form-grid"><label>День месяца<input name="dayOfMonth" type="number" min="1" max="31" value="${cfg.dayOfMonth||1}"></label><label>Сумма<input name="amount" type="number" step="0.01" value="${cfg.amount||0}"></label><label class="wide">Название<input name="label" value="${esc(cfg.label||'')}"></label></div>`;else fields.innerHTML=`<label>Строки: дата | сумма или процент | название<textarea name="items" placeholder="2026-09-01 | 30% | Предоплата\n2026-10-15 | 50000 | Этап 2">${(cfg.items||[]).map(i=>`${i.date} | ${i.percent!=null?i.percent+'%':i.amount||0} | ${i.label||''}`).join('\n')}</textarea></label>`;};type.addEventListener('change',paint);paint();
  document.getElementById('schedule-form').addEventListener('submit',async e=>{e.preventDefault();const d=formData(e.target);await call(window.tempo.schedules.save({projectId:d.projectId,type:d.type,config:serializeConfig(e.target,d.type),enabled:true}),'График сохранён');state.editing.schedule=null;await refreshBootstrap();renderProjects();});
}

async function renderMoney() {
  const range={from:'2000-01-01T00:00:00.000Z',to:addDays(new Date(),1).toISOString()}; state.dashboard=await call(window.tempo.dashboard(range));
  state.paymentScheduleItems=await call(window.tempo.schedules.materialize({from:localDate(addDays(new Date(),-180)),to:localDate(addDays(new Date(),365))}));
  const payments=state.data.payments, adjustments=state.data.adjustments, editPayment=state.editing.payment||{};
  const paymentScheduleOptions=(projectId,selectedId='')=>{
    const currentScheduleFallback=selectedId&&!state.paymentScheduleItems.some(i=>i.id===selectedId)?`<option value="${selectedId}" selected>${esc(editPayment.project_name||'Проект')} · ${editPayment.schedule_due_date?fmtDate(editPayment.schedule_due_date,{day:'2-digit',month:'2-digit',year:'numeric'})+' · ':''}${esc(editPayment.schedule_label||'Исторический пункт графика')}</option>`:'';
    const rows=state.paymentScheduleItems.filter(i=>i.project_id===projectId&&(i.status!=='paid'||i.id===selectedId));
    return `<option value="">Автоматически: ближайшая ожидаемая выплата</option>${currentScheduleFallback}${rows.map(i=>`<option value="${i.id}" ${i.id===selectedId?'selected':''}>${fmtDate(i.due_date,{day:'2-digit',month:'2-digit',year:'numeric'})} · ${esc(i.label)} · ${fmtMoney(i.amount,projectById(i.project_id)?.currency||'RUB')}</option>`).join('')}`;
  };
  const scheduleOptions=paymentScheduleOptions(editPayment.project_id||'',editPayment.schedule_item_id||'');
  content.innerHTML=`
    <div class="grid cols-3">${metric('Всего начислено',fmtMoney(state.dashboard.totals.earned),fmtHours(state.dashboard.totals.hours))}${metric('Всего получено',fmtMoney(state.dashboard.totals.paid),`Налог ${fmtMoney(state.dashboard.totals.tax)}`,'positive')}${metric('Общий долг',fmtMoney(Math.max(0,state.dashboard.totals.debt)),`${fmtHours(state.dashboard.totals.unpaidHours)} не закрыто`,'negative')}</div>
    <div class="grid cols-2 section-gap">
      <div class="card"><div class="card-head"><div><h2>${editPayment.id?'Изменить выплату':'Добавить выплату'}</h2><p>По умолчанию закрывает старые начисления частично или полностью</p></div></div><form id="payment-form" class="form-grid"><input type="hidden" name="id" value="${esc(editPayment.id||'')}"><label>Проект<select name="projectId" required>${optionProjects(editPayment.project_id)}</select></label><label>Дата<input name="receivedAt" type="date" value="${esc(editPayment.received_at||localDate(new Date()))}" required></label><label>Сумма<input name="amount" type="number" step="0.01" required value="${editPayment.amount??''}"></label><label>Налог, %<input name="taxRate" type="number" step="0.01" value="${editPayment.tax_rate??state.data.settings['app.taxRate']??6}"></label><label>Ссылка / номер<input name="reference" value="${esc(editPayment.reference||'')}"></label><label class="wide">Пункт графика<select name="scheduleItemId">${scheduleOptions}</select></label><label>Период с<input name="periodStart" type="date" value="${esc(editPayment.period_start||'')}"></label><label>Период до<input name="periodEnd" type="date" value="${esc(editPayment.period_end||'')}"></label><label>Автораспределение<select name="autoAllocate"><option value="true" ${editPayment.allocation_mode!=='advance'?'selected':''}>Да, старые первыми</option><option value="false" ${editPayment.allocation_mode==='advance'?'selected':''}>Нет, как аванс</option></select></label><label class="wide">Комментарий<input name="notes" value="${esc(editPayment.notes||'')}"></label><button class="primary">${editPayment.id?'Сохранить изменения':'Сохранить выплату'}</button></form></div>
      <div class="card"><div class="card-head"><div><h2>Корректировка долга</h2><p>Для старого долга, списания, бонуса или ручного часового остатка</p></div></div><form id="adjustment-form" class="form-grid"><label>Проект<select name="projectId" required>${optionProjects()}</select></label><label>Тип<select name="kind"><option value="money">Деньги</option><option value="hours">Часы</option></select></label><label>Значение<input name="amount" type="number" step="0.01" required></label><label>Дата<input name="effectiveAt" type="date" value="${localDate(new Date())}"></label><label class="wide">Причина<input name="reason" required placeholder="Перенос долга из старой системы"></label><button class="primary">Добавить</button></form></div>
    </div>
    <div class="card section-gap"><div class="card-head"><div><h2>Состояние расчётов</h2><p>Деньги и часы считаются отдельно</p></div></div><div class="grid cols-2">${state.dashboard.projects.map(debtCard).join('')||'<div class="empty">Нет проектов.</div>'}</div></div>
    <div class="grid cols-2 section-gap"><div class="card"><div class="card-head"><div><h2>Выплаты</h2><p>Налог рассчитывается с фактически полученной суммы</p></div></div>${renderPayments(payments)}</div><div class="card"><div class="card-head"><div><h2>Корректировки</h2><p>Все ручные изменения остаются в журнале</p></div></div>${renderAdjustments(adjustments)}</div></div>`;
  const paymentForm=document.getElementById('payment-form');
  paymentForm.elements.projectId.addEventListener('change',()=>{const project=projectById(paymentForm.elements.projectId.value);const client=clientById(project?.client_id);paymentForm.elements.taxRate.value=client?.tax_rate??state.data.settings['app.taxRate']??6;paymentForm.elements.scheduleItemId.innerHTML=paymentScheduleOptions(project?.id||'');});
  paymentForm.addEventListener('submit',async e=>{e.preventDefault();const d=formData(e.target);await call(window.tempo.payments.save({...d,id:d.id||undefined,scheduleItemId:d.scheduleItemId||null,amount:Number(d.amount),taxRate:Number(d.taxRate),autoAllocate:d.autoAllocate==='true'}),editPayment.id?'Выплата изменена':'Выплата добавлена');state.editing.payment=null;await refreshBootstrap();renderMoney();});
  document.getElementById('adjustment-form').addEventListener('submit',async e=>{e.preventDefault();const d=formData(e.target);await call(window.tempo.adjustments.save({...d,amount:Number(d.amount)}),'Корректировка добавлена');await refreshBootstrap();renderMoney();});
}
function debtCard(f){const debt=f.moneyDebt;return `<div class="card debt-card"><div class="debt-top"><div><b><span class="color-dot" style="background:${esc(f.project.color)}"></span>${esc(f.project.name)}</b><div class="tiny muted">${esc(f.project.client_name||'')}</div></div><span class="badge ${debt>0?'bad':'good'}">${debt>0?'долг':debt<0?'переплата':'закрыто'}</span></div><div class="debt-numbers"><div><small>Начислено</small><b>${fmtMoney(f.earned,f.project.currency)}</b></div><div><small>Выплачено</small><b>${fmtMoney(f.paid,f.project.currency)}</b></div><div><small>Остаток</small><b class="${debt>0?'negative':'positive'}">${fmtMoney(Math.abs(debt),f.project.currency)}</b></div><div><small>Часы</small><b>${fmtHours(f.unpaidHours)}</b></div></div></div>`;}
function renderPayments(rows){if(!rows.length)return '<div class="empty">Выплат пока нет.</div>';return `<table><thead><tr><th>Дата</th><th>Проект / график</th><th>Сумма</th><th>Налог</th><th></th></tr></thead><tbody>${rows.map(p=>`<tr><td>${fmtDate(p.received_at,{day:'2-digit',month:'2-digit',year:'numeric'})}</td><td>${esc(p.project_name||projectById(p.project_id)?.name||'')}<div class="tiny muted">${p.schedule_label?`${esc(p.schedule_label)} · ${fmtDate(p.schedule_due_date,{day:'2-digit',month:'2-digit'})}`:'вне графика'}</div></td><td><b>${fmtMoney(p.amount,p.currency)}</b><div class="tiny muted">${esc(p.reference||'')}</div></td><td>${fmtMoney(p.tax_amount,p.currency)}</td><td><div class="actions"><button class="small-btn" data-action="edit-payment" data-id="${p.id}">Изм.</button><button class="small-btn danger" data-action="delete-payment" data-id="${p.id}">×</button></div></td></tr>`).join('')}</tbody></table>`;}
function renderAdjustments(rows){if(!rows.length)return '<div class="empty">Корректировок нет.</div>';return `<table><thead><tr><th>Дата</th><th>Проект</th><th>Тип</th><th>Значение</th></tr></thead><tbody>${rows.map(a=>`<tr><td>${fmtDate(a.effective_at,{day:'2-digit',month:'2-digit',year:'numeric'})}</td><td>${esc(a.project_name||projectById(a.project_id)?.name||'')}</td><td>${a.kind==='money'?'Деньги':'Часы'}</td><td class="${a.amount<0?'positive':'negative'}">${a.kind==='money'?fmtMoney(a.amount,projectById(a.project_id)?.currency||'RUB'):fmtHours(a.amount)}<div class="tiny muted">${esc(a.reason)}</div></td></tr>`).join('')}</tbody></table>`;}

async function renderReceipts() {
  const receipts=state.data.receipts;
  content.innerHTML=`<div class="grid cols-2"><div class="card"><div class="card-head"><div><h2>Загрузить чек по ссылке</h2><p>Ссылка /print автоматически запрашивается как /json</p></div></div><form id="receipt-url-form" class="form-grid"><label class="wide">Ссылка ФНС<input name="url" required placeholder="https://lknpd.nalog.ru/api/v1/receipt/.../print"></label><label>Проект<select name="projectId">${optionProjects()}</select></label><label>Выплата<select name="paymentId"><option value="">Не связывать</option>${state.data.payments.map(p=>`<option value="${p.id}">${esc(p.project_name||projectById(p.project_id)?.name)} · ${fmtMoney(p.amount,p.currency)}</option>`).join('')}</select></label><button class="primary">Загрузить</button></form></div><div class="card"><div class="card-head"><div><h2>Импорт файла</h2><p>JSON/CSV из выгрузки или собственного архива</p></div></div><button data-action="import-receipts" class="primary">Выбрать JSON или CSV</button><p class="muted tiny">Импорт идемпотентный: повторный файл не создаст дубликаты.</p></div></div><div class="card section-gap"><div class="card-head"><div><h2>Чеки</h2><p>Налоговый документ не удваивает выплату; он подтверждает её</p></div><span class="badge">${receipts.length}</span></div>${renderReceiptsTable(receipts)}</div>`;
  document.getElementById('receipt-url-form').addEventListener('submit',async e=>{e.preventDefault();const d=formData(e.target);await call(window.tempo.receipts.fetch(d),'Чек загружен');await refreshBootstrap();renderReceipts();});
}
function renderReceiptsTable(rows){if(!rows.length)return '<div class="empty">Чеков пока нет.</div>';return `<table><thead><tr><th>Дата</th><th>Номер / покупатель</th><th>Проект</th><th>Сумма</th><th>Статус</th><th></th></tr></thead><tbody>${rows.map(r=>`<tr><td>${fmtDate(r.issued_at,{day:'2-digit',month:'2-digit',year:'numeric'})}</td><td><b>${esc(r.receipt_number||'без номера')}</b><div class="tiny muted">${esc(r.buyer||r.description||'')}</div></td><td>${esc(r.project_name||'не связан')}</td><td>${fmtMoney(r.amount)}</td><td><span class="badge ${r.status==='active'?'good':'bad'}">${esc(r.status)}</span></td><td><div class="actions">${r.receipt_url?`<button class="small-btn" data-action="open-url" data-url="${esc(r.receipt_url)}">Открыть</button>`:''}<button class="small-btn" data-action="link-receipt" data-id="${r.id}">Связать</button></div></td></tr>`).join('')}</tbody></table>`;}

async function renderIntegrations() {
  const s=state.data.settings;
  content.innerHTML=`
    <div class="integration"><div class="integration-icon">K</div><div><h3>Kimai 2</h3><p>Bearer API token, импорт истории и очередь оффлайн-записей</p></div><span class="badge">${state.data.outbox.pending||0} в очереди</span></div>
    <div class="card section-gap"><form id="kimai-form" class="form-grid"><label class="wide">Base URL<input name="baseUrl" value="${esc(s['kimai.baseUrl']||'')}" placeholder="https://kimai.example.com"></label><label class="wide">API token<input name="token" type="password" placeholder="Оставьте пустым, чтобы не менять"></label><button class="primary">Сохранить</button><button type="button" data-action="test-kimai">Проверить</button><label>Импорт с<input id="kimai-begin" type="date" value="${localDate(addDays(new Date(),-30))}"></label><label>по<input id="kimai-end" type="date" value="${localDate(new Date())}"></label><button type="button" data-action="pull-kimai">Импортировать</button><button type="button" data-action="push-kimai">Отправить очередь</button><button type="button" data-action="catalog-kimai">Каталоги ID</button></form><div id="kimai-catalog-results" class="section-gap"></div></div>
    <div class="integration section-gap"><div class="integration-icon">J</div><div><h3>Jira</h3><p>Cloud API token или Data Center PAT; задачи кэшируются локально</p></div><span class="badge">${state.data.projects.filter(p=>p.jira_project_key).length} связей</span></div>
    <div class="card section-gap"><form id="jira-form" class="form-grid"><label>Режим<select name="mode"><option value="cloud" ${s['jira.mode']!=='dc'?'selected':''}>Cloud</option><option value="dc" ${s['jira.mode']==='dc'?'selected':''}>Data Center</option></select></label><label class="wide">Base URL<input name="baseUrl" value="${esc(s['jira.baseUrl']||'')}" placeholder="https://team.atlassian.net"></label><label>Email (Cloud)<input name="email" value="${esc(s['jira.email']||'')}"></label><label class="wide">API token / PAT<input name="token" type="password" placeholder="Оставьте пустым, чтобы не менять"></label><label class="wide">JQL<input name="jql" value="${esc(s['jira.jql']||'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC')}"></label><button class="primary">Сохранить</button><button type="button" data-action="test-jira">Проверить</button><button type="button" data-action="sync-jira">Обновить задачи</button></form></div>
    <div class="card section-gap"><div class="card-head"><div><h2>Кэш Jira</h2><p>Поиск работает без сети после синхронизации</p></div></div><div class="toolbar-group"><input id="jira-search" placeholder="ABC-123 или текст"><button data-action="search-jira">Найти</button></div><div id="jira-results" class="section-gap"></div></div>`;
  document.getElementById('kimai-form').addEventListener('submit',async e=>{e.preventDefault();const d=formData(e.target);await call(window.tempo.settings.set('kimai.baseUrl',d.baseUrl));if(d.token)await call(window.tempo.settings.setSecret('kimai.token',d.token));await refreshBootstrap();toast('Kimai сохранён','ok');});
  document.getElementById('jira-form').addEventListener('submit',async e=>{e.preventDefault();const d=formData(e.target);for(const [k,v] of [['jira.mode',d.mode],['jira.baseUrl',d.baseUrl],['jira.email',d.email],['jira.jql',d.jql]])await call(window.tempo.settings.set(k,v));if(d.token)await call(window.tempo.settings.setSecret('jira.token',d.token));await refreshBootstrap();toast('Jira сохранена','ok');});
}

async function renderSettings() {
  const s=state.data.settings;
  content.innerHTML=`<div class="grid cols-2"><div class="card"><div class="card-head"><div><h2>Расчёты</h2><p>Базовые значения для новых данных</p></div></div><form id="settings-form" class="form-grid"><label>Валюта<select name="currency"><option ${s['app.currency']==='RUB'?'selected':''}>RUB</option><option ${s['app.currency']==='USD'?'selected':''}>USD</option><option ${s['app.currency']==='EUR'?'selected':''}>EUR</option></select></label><label>Налог НПД, %<input name="taxRate" type="number" step="0.01" value="${s['app.taxRate']||6}"></label><label>Цель часов/нед.<input name="weekHoursTarget" type="number" step="0.5" value="${s['app.weekHoursTarget']||40}"></label><label>Прогноз, дней<input name="forecastDays" type="number" min="7" value="${s['app.forecastDays']||30}"></label><label>Автосинк, минут<input name="autoSyncMinutes" type="number" min="1" value="${s['app.autoSyncMinutes']||5}"></label><button class="primary">Сохранить</button></form></div><div class="card"><div class="card-head"><div><h2>Данные</h2><p>SQLite хранится в каталоге приложения; токены шифруются ОС</p></div></div><div class="grid"><button data-action="backup" class="primary">Создать резервную копию SQLite</button><button data-action="export" class="ghost">Экспортировать JSON</button><div class="muted tiny">Экспорт не содержит токены Kimai/Jira. Резервная копия SQLite содержит их только в зашифрованном виде.</div></div></div></div><div class="card section-gap"><div class="card-head"><div><h2>Принципы расчёта</h2><p>Чтобы цифры не вводили в заблуждение</p></div></div><table><tbody><tr><td><b>Начислено</b></td><td>Завершённые billable-записи × наиболее приоритетная ставка + денежные корректировки.</td></tr><tr><td><b>Выплачено</b></td><td>Фактические поступления. График выплат в эту сумму не входит.</td></tr><tr><td><b>Налог</b></td><td>${s['app.taxRate']||6}% с выплат; чек НПД подтверждает выплату и не прибавляет доход второй раз.</td></tr><tr><td><b>Долг в часах</b></td><td>Отработанные часы минус часы, закрытые распределением выплат, плюс ручные корректировки.</td></tr><tr><td><b>Прогноз</b></td><td>Средняя недавняя дневная выработка, ограниченный тренд и статистический коридор.</td></tr></tbody></table></div>`;
  document.getElementById('settings-form').addEventListener('submit',async e=>{e.preventDefault();const d=formData(e.target);for(const [k,v] of [['app.currency',d.currency],['app.taxRate',Number(d.taxRate)],['app.weekHoursTarget',Number(d.weekHoursTarget)],['app.forecastDays',Number(d.forecastDays)],['app.autoSyncMinutes',Number(d.autoSyncMinutes)]])await call(window.tempo.settings.set(k,v));await refreshBootstrap();toast('Настройки сохранены','ok');});
}

function openEntryEditor(entry = null) {
  const existing = entry || {};
  const host=document.createElement('dialog');
  host.innerHTML=`<form method="dialog" id="entry-edit-form" class="dialog-form"><div class="dialog-head"><div><h2>${existing.id?'Изменить запись':'Новая запись'}</h2><p>Ручная запись также синхронизируется с Kimai</p></div><button value="cancel" class="icon-btn">×</button></div><label>Проект<select name="projectId" required>${optionProjects(existing.project_id)}</select></label><div class="two"><label>Начало<input type="datetime-local" name="startedAt" required value="${existing.started_at?localDateTime(existing.started_at):localDateTime(new Date())}"></label><label>Конец<input type="datetime-local" name="endedAt" required value="${existing.ended_at?localDateTime(existing.ended_at):localDateTime(new Date(Date.now()+3600000))}"></label></div><div class="two"><label>Активность<input name="activityName" value="${esc(existing.activity_name||'')}"></label><label>Jira<input name="jiraIssueKey" value="${esc(existing.jira_issue_key||'')}"></label></div><label>Описание<input name="description" value="${esc(existing.description||'')}"></label><label>Теги<input name="tags" value="${esc((JSON.parse(existing.tags_json||'[]')).join(', '))}"></label><div class="dialog-actions"><button value="cancel" class="ghost">Отмена</button><button value="default" class="primary">Сохранить</button></div></form>`;
  document.body.appendChild(host);host.showModal();
  host.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const d=formData(e.target);await call(window.tempo.entries.save({id:existing.id||undefined,...d,startedAt:new Date(d.startedAt).toISOString(),endedAt:new Date(d.endedAt).toISOString(),billable:true,source:existing.source||'manual',kimaiId:existing.kimai_id||null,kimaiProjectId:existing.kimai_project_id||projectById(d.projectId)?.kimai_project_id||null,kimaiActivityId:existing.kimai_activity_id||projectById(d.projectId)?.kimai_activity_id||null}),'Запись сохранена');host.close();host.remove();await refreshBootstrap();render();});
  host.addEventListener('close',()=>host.remove(),{once:true});
}

async function syncAll() {
  const indicator=document.getElementById('sync-indicator');indicator.className='sync-pill running';indicator.querySelector('span').textContent='Синхронизация…';
  try { await call(window.tempo.kimai.push()); indicator.className='sync-pill ok';indicator.querySelector('span').textContent='Синхронизировано';await refreshBootstrap();if(state.view==='dashboard')renderDashboard(); }
  catch { indicator.className='sync-pill error';indicator.querySelector('span').textContent='Ошибка синхронизации'; }
}

document.getElementById('nav').addEventListener('click',(e)=>{const b=e.target.closest('button[data-view]');if(b)navigate(b.dataset.view);});
document.getElementById('quick-timer').addEventListener('click',()=>dialog.showModal());
document.getElementById('sync-now').addEventListener('click',syncAll);
quickForm.addEventListener('submit',async e=>{e.preventDefault();const submitter=e.submitter;if(submitter?.value==='cancel'){dialog.close();return;}const d=formData(e.target);await call(window.tempo.timers.start(d),'Таймер запущен');dialog.close();e.target.reset();populateQuickTimer();await refreshBootstrap();render();});

content.addEventListener('click',async(e)=>{
  const b=e.target.closest('[data-action]');if(!b)return;const a=b.dataset.action,id=b.dataset.id;
  if(a==='open-timer')dialog.showModal();
  else if(a==='stop-timer'){await call(window.tempo.timers.stop(id),'Таймер остановлен');await refreshBootstrap();render();}
  else if(a==='week-prev'){state.weekStart=addDays(state.weekStart,-7);renderWeek();}
  else if(a==='week-next'){state.weekStart=addDays(state.weekStart,7);renderWeek();}
  else if(a==='week-today'){state.weekStart=monday(new Date());renderWeek();}
  else if(a==='add-manual-entry')openEntryEditor();
  else if(a==='edit-entry'){const entry=state.entries.find(x=>x.id===id)||await call(window.tempo.entries.list({from:addDays(new Date(),-3650).toISOString(),to:addDays(new Date(),3650).toISOString()})).then(rows=>rows.find(x=>x.id===id));openEntryEditor(entry);}
  else if(a==='delete-entry'){if(confirm('Удалить локальную запись? Запись в Kimai не удаляется и может снова появиться при импорте.')){await call(window.tempo.entries.delete(id),'Запись удалена');await refreshBootstrap();render();}}
  else if(a==='edit-client'){state.editing.client=state.data.clients.find(x=>x.id===id);renderProjects();}
  else if(a==='edit-project'){state.editing.project=state.data.projects.find(x=>x.id===id);renderProjects();}
  else if(a==='edit-rate'){state.editing.rate=state.data.rateRules.find(x=>x.id===id);renderProjects();}
  else if(a==='delete-rate'){await call(window.tempo.rates.delete(id),'Ставка удалена');await refreshBootstrap();renderProjects();}
  else if(a==='edit-schedule'){state.editing.schedule=state.data.schedules.find(x=>x.id===id);renderProjects();}
  else if(a==='edit-payment'){state.editing.payment=state.data.payments.find(x=>x.id===id);renderMoney();}
  else if(a==='delete-payment'){if(confirm('Удалить выплату и её распределения?')){await call(window.tempo.payments.delete(id),'Выплата удалена');await refreshBootstrap();renderMoney();}}
  else if(a==='import-receipts'){const rows=await call(window.tempo.receipts.importFile());toast(`Импортировано: ${rows.length}`,'ok');await refreshBootstrap();renderReceipts();}
  else if(a==='open-url')window.tempo.shell.open(b.dataset.url);
  else if(a==='link-receipt'){const paymentId=prompt('ID выплаты для связи (скопируйте из экспорта или выберите номер ниже):\n'+state.data.payments.map(p=>`${p.id} — ${p.project_name||projectById(p.project_id)?.name} — ${fmtMoney(p.amount,p.currency)}`).join('\n'));if(paymentId){const payment=state.data.payments.find(p=>p.id===paymentId.trim());if(!payment)throw new Error('Выплата с таким ID не найдена');await call(window.tempo.receipts.link({receiptId:id,paymentId:payment.id,projectId:payment.project_id}),'Чек связан');await refreshBootstrap();renderReceipts();}}
  else if(a==='test-kimai'){const r=await call(window.tempo.kimai.test());toast(`Kimai доступен${r.version?.version?' · '+r.version.version:''}`,'ok');}
  else if(a==='pull-kimai'){const begin=document.getElementById('kimai-begin').value,end=document.getElementById('kimai-end').value;const r=await call(window.tempo.kimai.pull({begin,end}));toast(`Импортировано ${r.imported} записей`,'ok');await refreshBootstrap();}
  else if(a==='push-kimai'){const r=await call(window.tempo.kimai.push());toast(`Отправлено ${r.processed}, ошибок ${r.failed}`,'ok');await refreshBootstrap();}
  else if(a==='catalog-kimai'){const c=await call(window.tempo.kimai.catalogs());document.getElementById('kimai-catalog-results').innerHTML=`<div class="grid cols-2"><div><h3>Проекты</h3><table><tbody>${c.projects.map(p=>`<tr><td><b>${p.id}</b></td><td>${esc(p.name||p.customer?.name||'')}</td></tr>`).join('')}</tbody></table></div><div><h3>Активности</h3><table><tbody>${c.activities.map(x=>`<tr><td><b>${x.id}</b></td><td>${esc(x.name||'')}</td></tr>`).join('')}</tbody></table></div></div>`;}
  else if(a==='test-jira'){const r=await call(window.tempo.jira.test());toast(`Jira: ${r.account}`,'ok');}
  else if(a==='sync-jira'){const jql=document.querySelector('#jira-form [name=jql]').value;const r=await call(window.tempo.jira.sync(jql));toast(`Загружено ${r.imported} задач`,'ok');}
  else if(a==='search-jira'){const q=document.getElementById('jira-search').value;const rows=await call(window.tempo.jira.search(q));document.getElementById('jira-results').innerHTML=rows.length?`<table><tbody>${rows.map(i=>`<tr><td><b>${esc(i.key)}</b></td><td>${esc(i.summary)}<div class="tiny muted">${esc(i.status)} · ${esc(i.assignee)}</div></td><td><button class="small-btn" data-action="open-url" data-url="${esc(i.url)}">Открыть</button></td></tr>`).join('')}</tbody></table>`:'<div class="empty">Ничего не найдено.</div>';}
  else if(a==='backup'){const p=await call(window.tempo.data.backup());if(p)toast(`Копия сохранена: ${p}`,'ok');}
  else if(a==='export'){const p=await call(window.tempo.data.export());if(p)toast(`Экспорт сохранён: ${p}`,'ok');}
});

window.tempo.onSyncStatus((payload)=>{const i=document.getElementById('sync-indicator');i.className=`sync-pill ${payload.state}`;i.querySelector('span').textContent=payload.state==='running'?'Синхронизация…':payload.state==='ok'?'Синхронизировано':payload.state==='warning'?'Есть ошибки':'Ошибка';});

setInterval(()=>{document.querySelectorAll('.live-clock').forEach((node)=>{const sec=Math.max(0,Math.floor((Date.now()-new Date(node.dataset.start).getTime())/1000));const h=String(Math.floor(sec/3600)).padStart(2,'0'),m=String(Math.floor(sec%3600/60)).padStart(2,'0'),s=String(sec%60).padStart(2,'0');node.textContent=`${h}:${m}:${s}`;});},1000);

(async()=>{try{await refreshBootstrap();await navigate('dashboard');}catch(error){content.innerHTML=`<div class="card"><h2>Не удалось открыть TempoWeave</h2><p class="negative">${esc(error.message||error)}</p></div>`;}})();
