'use strict';

const { fingerprintTimeEntry, parseTags, toKimaiLocal } = require('../domain');

function formatKimaiFilterDate(value, endOfDay = false) {
  if (!value) return '';
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw}T${endOfDay ? '23:59:59' : '00:00:00'}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid Kimai date filter: ${raw}`);
  return toKimaiLocal(parsed.toISOString());
}

function kimaiErrorMessage(body, text, statusText) {
  const details = [];
  for (const value of [body?.message, body?.detail, body?.error, body?.title]) {
    if (typeof value === 'string' && value.trim()) details.push(value.trim());
  }
  if (Array.isArray(body?.violations)) {
    for (const violation of body.violations) {
      const field = violation?.propertyPath || violation?.property || violation?.field;
      const message = violation?.message || violation?.detail;
      if (message) details.push(field ? `${field}: ${message}` : String(message));
    }
  }
  if (body?.errors && typeof body.errors === 'object') {
    for (const [field, messages] of Object.entries(body.errors)) {
      for (const message of Array.isArray(messages) ? messages : [messages]) {
        if (message) details.push(`${field}: ${message}`);
      }
    }
  }
  if (!details.length && typeof text === 'string' && text.trim()) details.push(text.trim());
  if (!details.length && statusText) details.push(statusText);
  return [...new Set(details)].join('; ');
}

class KimaiClient {
  constructor({ baseUrl, token }) {
    this.baseUrl = String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/api$/i, '');
    this.token = token;
    if (!this.baseUrl || !this.token) throw new Error('Kimai URL and API token are required');
  }

  async request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout || 30000);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...(options.headers || {})
        }
      });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (!response.ok) {
        const method = String(options.method || 'GET').toUpperCase();
        const message = kimaiErrorMessage(body, text, response.statusText) || `HTTP ${response.status}`;
        throw new Error(`Kimai ${response.status} ${method} ${path}: ${message}`);
      }
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }

  async test() {
    try {
      const version = await this.request('/api/version');
      return { ok: true, version };
    } catch {
      const rows = await this.request('/api/timesheets?size=1&page=1');
      return { ok: true, version: null, sampleCount: Array.isArray(rows) ? rows.length : 0 };
    }
  }

  async paginate(path, maxPages = 100) {
    const separator = path.includes('?') ? '&' : '?';
    const output = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const rows = await this.request(`${path}${separator}page=${page}&size=500`);
      if (!Array.isArray(rows)) break;
      output.push(...rows);
      if (rows.length < 500) break;
    }
    return output;
  }

  async catalogs() {
    const [customers, projects, activities] = await Promise.all([
      this.paginate('/api/customers?visible=3'),
      this.paginate('/api/projects?visible=3'),
      this.paginate('/api/activities?visible=3')
    ]);
    return { customers, projects, activities };
  }

  async timesheets(begin, end) {
    const params = new URLSearchParams();
    if (begin) params.set('begin', formatKimaiFilterDate(begin, false));
    if (end) params.set('end', formatKimaiFilterDate(end, true));
    params.set('orderBy', 'begin');
    params.set('order', 'ASC');
    return this.paginate(`/api/timesheets?${params.toString()}`);
  }

  normalizeRemote(row, localProjectId = null) {
    const project = typeof row.project === 'object' ? row.project : null;
    const activity = typeof row.activity === 'object' ? row.activity : null;
    const remoteTags = parseTags(row.tags || []);
    const marker = remoteTags.find((t) => t.startsWith('tempoweave:'));
    const tags = remoteTags.filter((t) => !t.startsWith('tempoweave:'));
    const entry = {
      id: marker ? marker.slice('tempoweave:'.length) : undefined,
      projectId: localProjectId,
      kimaiId: row.id,
      kimaiProjectId: project?.id || row.project || null,
      kimaiActivityId: activity?.id || row.activity || null,
      activityName: activity?.name || row.activity?.name || '',
      startedAt: row.begin,
      endedAt: row.end || null,
      durationSeconds: Number(row.duration || 0),
      description: row.description || '',
      jiraIssueKey: this.extractIssueKey(row.description || '', tags),
      tags,
      billable: row.billable !== false,
      source: 'kimai',
      syncState: 'synced'
    };
    entry.fingerprint = entry.endedAt ? fingerprintTimeEntry(entry) : null;
    return entry;
  }

  extractIssueKey(description, tags) {
    const tagged = tags.find((t) => /^[A-Z][A-Z0-9]+-\d+$/i.test(t));
    if (tagged) return tagged.toUpperCase();
    const match = String(description).match(/\b([A-Z][A-Z0-9]+-\d+)\b/i);
    return match ? match[1].toUpperCase() : '';
  }

  async findTimesheetByMarker(entryId, startedAt) {
    const marker = `tempoweave:${entryId}`;
    const center = new Date(startedAt);
    const from = new Date(center); from.setDate(from.getDate() - 1);
    const to = new Date(center); to.setDate(to.getDate() + 1);
    const rows = await this.timesheets(from.toISOString(), to.toISOString());
    return rows.find((row) => parseTags(row.tags || []).includes(marker)) || null;
  }

  async ensureTimesheet(entry, project) {
    const existing = await this.findTimesheetByMarker(entry.id, entry.started_at);
    if (existing) return existing;
    return this.createTimesheet(entry, project);
  }

  timesheetPayload(entry, project) {
    const tags = parseTags(JSON.parse(entry.tags_json || '[]')).filter((tag) => !tag.startsWith('tempoweave:'));
    const marker = `tempoweave:${entry.id}`;
    tags.push(marker);
    if (entry.jira_issue_key && !tags.includes(entry.jira_issue_key)) tags.push(entry.jira_issue_key);
    const payload = {
      begin: toKimaiLocal(entry.started_at),
      end: toKimaiLocal(entry.ended_at),
      project: Number(entry.kimai_project_id || project?.kimai_project_id),
      activity: Number(entry.kimai_activity_id || project?.kimai_activity_id),
      description: entry.description || '',
      tags: [...new Set(tags)].join(','),
      billable: Boolean(entry.billable),
      exported: false
    };
    if (!payload.project || !payload.activity) throw new Error('Kimai project/activity mapping is missing');
    return payload;
  }

  async createTimesheet(entry, project) {
    return this.request('/api/timesheets', { method: 'POST', body: JSON.stringify(this.timesheetPayload(entry, project)) });
  }

  async updateTimesheet(entry, project) {
    if (!entry.kimai_id) throw new Error('Kimai timesheet ID is missing');
    return this.request(`/api/timesheets/${entry.kimai_id}`, { method: 'PATCH', body: JSON.stringify(this.timesheetPayload(entry, project)) });
  }
}

module.exports = { KimaiClient, formatKimaiFilterDate, kimaiErrorMessage };
