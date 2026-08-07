'use strict';

const crypto = require('node:crypto');

function uuid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function parseTags(input) {
  if (Array.isArray(input)) return [...new Set(input.map(String).map((x) => x.trim()).filter(Boolean))];
  if (!input) return [];
  return [...new Set(String(input).split(/[,;\n]/).map((x) => x.trim()).filter(Boolean))];
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

function fingerprintTimeEntry(entry) {
  const normalized = {
    projectId: entry.projectId || null,
    kimaiProjectId: entry.kimaiProjectId || null,
    activityName: String(entry.activityName || '').trim().toLowerCase(),
    kimaiActivityId: entry.kimaiActivityId || null,
    startedAt: new Date(entry.startedAt).toISOString(),
    endedAt: entry.endedAt ? new Date(entry.endedAt).toISOString() : null,
    description: String(entry.description || '').trim().replace(/\s+/g, ' '),
    jiraIssueKey: String(entry.jiraIssueKey || '').trim().toUpperCase(),
    tags: parseTags(entry.tags).sort()
  };
  return crypto.createHash('sha256').update(stableJson(normalized)).digest('hex');
}

function durationSeconds(startedAt, endedAt) {
  if (!startedAt || !endedAt) return 0;
  return Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000));
}

function toKimaiLocal(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function startOfWeek(dateLike, weekStartsMonday = true) {
  const d = new Date(dateLike);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diff = weekStartsMonday ? (day === 0 ? -6 : 1 - day) : -day;
  d.setDate(d.getDate() + diff);
  return d;
}

function addDays(dateLike, days) {
  const d = new Date(dateLike);
  d.setDate(d.getDate() + days);
  return d;
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function generateScheduleDates(schedule, fromDate, toDate, projectAmount = 0) {
  if (!schedule || !schedule.enabled) return [];
  const from = new Date(fromDate);
  const to = new Date(toDate);
  from.setHours(0, 0, 0, 0);
  to.setHours(23, 59, 59, 999);
  const config = typeof schedule.config === 'string' ? JSON.parse(schedule.config || '{}') : (schedule.config || {});
  const rows = [];

  const push = (date, label, amount, sourceKey) => {
    const d = new Date(date);
    if (d >= from && d <= to) {
      rows.push({
        dueDate: d.toISOString().slice(0, 10),
        label: label || 'Выплата',
        amount: roundMoney(amount || 0),
        sourceKey
      });
    }
  };

  if (schedule.type === 'interval') {
    const everyDays = Math.max(1, Number(config.everyDays || 14));
    let d = new Date(config.anchorDate || from);
    d.setHours(0, 0, 0, 0);
    while (d < from) d = addDays(d, everyDays);
    let guard = 0;
    while (d <= to && guard < 1000) {
      push(d, config.label || `Каждые ${everyDays} дней`, config.amount || 0, `interval:${d.toISOString().slice(0, 10)}`);
      d = addDays(d, everyDays);
      guard += 1;
    }
  } else if (schedule.type === 'monthly') {
    const day = clamp(Number(config.dayOfMonth || 1), 1, 31);
    let cursor = new Date(from.getFullYear(), from.getMonth(), 1);
    let guard = 0;
    while (cursor <= to && guard < 240) {
      const actualDay = Math.min(day, daysInMonth(cursor.getFullYear(), cursor.getMonth()));
      push(new Date(cursor.getFullYear(), cursor.getMonth(), actualDay), config.label || `Ежемесячно, ${day}-го`, config.amount || 0, `monthly:${cursor.getFullYear()}-${cursor.getMonth() + 1}`);
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      guard += 1;
    }
  } else if (schedule.type === 'milestone') {
    for (const [index, item] of (config.items || []).entries()) {
      const amount = item.amount != null ? Number(item.amount) : Number(projectAmount) * Number(item.percent || 0) / 100;
      push(item.date, item.label || `Этап ${index + 1}`, amount, `milestone:${index}:${item.date}`);
    }
  } else if (schedule.type === 'custom') {
    for (const [index, item] of (config.items || []).entries()) {
      push(item.date, item.label || `Выплата ${index + 1}`, Number(item.amount || 0), `custom:${index}:${item.date}`);
    }
  }

  return rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

function forecast(values, horizonWorkingDays) {
  const clean = values.filter((v) => Number.isFinite(v) && v >= 0).slice(-60);
  if (!clean.length) return { expected: 0, low: 0, high: 0, daily: 0, trend: 0, confidence: 'low' };
  const recent = clean.slice(-20);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  let slope = 0;
  if (recent.length > 1) {
    const n = recent.length;
    const xMean = (n - 1) / 2;
    const numerator = recent.reduce((sum, y, x) => sum + (x - xMean) * (y - mean), 0);
    const denominator = recent.reduce((sum, _, x) => sum + (x - xMean) ** 2, 0) || 1;
    slope = clamp(numerator / denominator, -mean * 0.15, mean * 0.15);
  }
  const projectedDaily = Math.max(0, mean + slope * Math.min(10, horizonWorkingDays / 2));
  const variance = recent.reduce((sum, v) => sum + (v - mean) ** 2, 0) / Math.max(1, recent.length - 1);
  const sigma = Math.sqrt(variance);
  const expected = projectedDaily * horizonWorkingDays;
  const spread = sigma * Math.sqrt(Math.max(1, horizonWorkingDays));
  return {
    expected: roundMoney(expected),
    low: roundMoney(Math.max(0, expected - 1.28 * spread)),
    high: roundMoney(expected + 1.28 * spread),
    daily: roundMoney(projectedDaily),
    trend: roundMoney(slope),
    confidence: recent.length >= 15 ? 'high' : recent.length >= 7 ? 'medium' : 'low'
  };
}

function workingDaysBetween(fromDate, toDate) {
  let count = 0;
  let d = new Date(fromDate);
  const to = new Date(toDate);
  d.setHours(0, 0, 0, 0);
  to.setHours(0, 0, 0, 0);
  while (d <= to) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) count += 1;
    d = addDays(d, 1);
  }
  return count;
}

function csvParse(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

module.exports = {
  uuid,
  nowIso,
  clamp,
  roundMoney,
  parseTags,
  stableJson,
  fingerprintTimeEntry,
  durationSeconds,
  toKimaiLocal,
  startOfWeek,
  addDays,
  generateScheduleDates,
  forecast,
  workingDaysBetween,
  csvParse
};
