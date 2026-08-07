'use strict';

const crypto = require('node:crypto');
const { csvParse } = require('./domain');

function pick(obj, paths, fallback = null) {
  for (const path of paths) {
    const value = path.split('.').reduce((acc, key) => acc?.[key], obj);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function normalizeDate(value) {
  if (!value) return new Date().toISOString();
  if (typeof value === 'number') return new Date(value > 1e12 ? value : value * 1000).toISOString();
  const text = String(value).trim();
  const ru = text.match(/^(\d{2})[.\/-](\d{2})[.\/-](\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (ru) return new Date(`${ru[3]}-${ru[2]}-${ru[1]}T${ru[4] || '12'}:${ru[5] || '00'}:${ru[6] || '00'}`).toISOString();
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) throw new Error(`Unrecognized receipt date: ${value}`);
  return d.toISOString();
}

function normalizeAmount(value) {
  if (typeof value === 'number') return value;
  const cleaned = String(value || '').replace(/\s/g, '').replace(',', '.').replace(/[^0-9.-]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new Error(`Unrecognized receipt amount: ${value}`);
  return n;
}

function normalizeReceipt(raw, sourceUrl = '') {
  const amount = normalizeAmount(pick(raw, ['totalAmount', 'amount', 'total', 'operation.amount', 'income.amount', 'sum']));
  const issuedAt = normalizeDate(pick(raw, ['operationTime', 'createdAt', 'receiptTime', 'date', 'income.receiptTime', 'operation.date']));
  const receiptNumber = String(pick(raw, ['id', 'receiptId', 'receiptUuid', 'uuid', 'operation.id', 'documentNumber'], '') || '');
  const buyer = String(pick(raw, ['partner.displayName', 'partner.name', 'buyer.name', 'client.name', 'customer', 'buyer'], '') || '');
  const services = pick(raw, ['services', 'items', 'products', 'income.services'], []);
  const description = Array.isArray(services)
    ? services.map((s) => s.name || s.description || s.title).filter(Boolean).join('; ')
    : String(pick(raw, ['description', 'serviceName', 'name'], '') || '');
  const statusRaw = String(pick(raw, ['status', 'operation.status', 'cancelled'], 'active'));
  const status = /cancel|annul|true/i.test(statusRaw) ? 'cancelled' : 'active';
  const fingerprint = crypto.createHash('sha256').update(`${receiptNumber}|${issuedAt}|${amount}|${sourceUrl}`).digest('hex');
  return { receiptUrl: sourceUrl, receiptNumber, issuedAt, amount, buyer, description, status, source: 'npd', raw, fingerprint };
}

function receiptJsonUrl(url) {
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || (hostname !== 'nalog.ru' && !hostname.endsWith('.nalog.ru'))) {
    throw new Error('Only HTTPS receipt URLs on nalog.ru are supported');
  }
  parsed.username = '';
  parsed.password = '';
  parsed.pathname = parsed.pathname.replace(/\/(print|html|pdf)\/?$/i, '/json');
  if (!/\/json\/?$/i.test(parsed.pathname)) parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}/json`;
  return parsed.toString();
}

async function fetchReceipt(url) {
  const jsonUrl = receiptJsonUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(jsonUrl, { headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error(`NPD receipt HTTP ${response.status}`);
    return normalizeReceipt(await response.json(), url);
  } finally { clearTimeout(timeout); }
}

function importText(text, filename = '') {
  const trimmed = String(text).trim();
  let rows;
  if (filename.toLowerCase().endsWith('.csv') || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) rows = csvParse(trimmed);
  else {
    const json = JSON.parse(trimmed);
    rows = Array.isArray(json) ? json : (json.receipts || json.items || [json]);
  }
  return rows.map((row) => normalizeReceipt(row));
}

module.exports = { normalizeReceipt, receiptJsonUrl, fetchReceipt, importText };
