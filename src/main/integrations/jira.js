'use strict';

class JiraClient {
  constructor({ baseUrl, mode = 'cloud', email = '', token }) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.mode = mode;
    this.email = email;
    this.token = token;
    if (!this.baseUrl || !this.token) throw new Error('Jira URL and token are required');
    if (mode === 'cloud' && !email) throw new Error('Email is required for Jira Cloud API token');
  }

  authHeader() {
    if (this.mode === 'cloud') return `Basic ${Buffer.from(`${this.email}:${this.token}`, 'utf8').toString('base64')}`;
    return `Bearer ${this.token}`;
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
          Authorization: this.authHeader(),
          ...(options.headers || {})
        }
      });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (!response.ok) throw new Error(`Jira ${response.status}: ${body?.errorMessages?.join('; ') || body?.message || text}`);
      return body;
    } finally { clearTimeout(timeout); }
  }

  apiVersion() { return this.mode === 'cloud' ? '3' : '2'; }

  async test() {
    const me = await this.request(`/rest/api/${this.apiVersion()}/myself`);
    return { ok: true, account: me.displayName || me.name || me.emailAddress || 'Jira user' };
  }

  async search(jql = 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC', maxResults = 100) {
    const version = this.apiVersion();
    let result;
    if (this.mode === 'cloud') {
      try {
        result = await this.request(`/rest/api/${version}/search/jql`, {
          method: 'POST',
          body: JSON.stringify({ jql, maxResults, fields: ['summary', 'status', 'assignee', 'project', 'updated'] })
        });
      } catch {
        result = await this.request(`/rest/api/${version}/search`, {
          method: 'POST',
          body: JSON.stringify({ jql, maxResults, fields: ['summary', 'status', 'assignee', 'project', 'updated'] })
        });
      }
    } else {
      result = await this.request(`/rest/api/${version}/search`, {
        method: 'POST',
        body: JSON.stringify({ jql, maxResults, fields: ['summary', 'status', 'assignee', 'project', 'updated'] })
      });
    }
    return (result.issues || []).map((issue) => ({
      key: issue.key,
      projectKey: issue.fields?.project?.key || issue.key.split('-')[0],
      summary: issue.fields?.summary || '',
      status: issue.fields?.status?.name || '',
      assignee: issue.fields?.assignee?.displayName || '',
      url: `${this.baseUrl}/browse/${issue.key}`,
      raw: issue
    }));
  }
}

module.exports = { JiraClient };
