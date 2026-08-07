'use strict';

const { KimaiClient } = require('./integrations/kimai');
const { JiraClient } = require('./integrations/jira');

class SyncEngine {
  constructor({ store, getSecret }) {
    this.store = store;
    this.getSecret = getSecret;
    this.running = false;
  }

  kimaiClient() {
    return new KimaiClient({ baseUrl: this.store.getSetting('kimai.baseUrl', ''), token: this.getSecret('kimai.token') });
  }

  jiraClient() {
    return new JiraClient({
      baseUrl: this.store.getSetting('jira.baseUrl', ''),
      mode: this.store.getSetting('jira.mode', 'cloud'),
      email: this.store.getSetting('jira.email', ''),
      token: this.getSecret('jira.token')
    });
  }

  async processOutbox() {
    if (this.running) return { skipped: true };
    this.running = true;
    const summary = { processed: 0, failed: 0 };
    try {
      for (const item of this.store.dueOutbox()) {
        try {
          if (item.kind === 'kimai.push') await this.pushEntry(item.entity_id);
          this.store.completeOutbox(item.id);
          summary.processed += 1;
        } catch (error) {
          this.store.failOutbox(item.id, error.message || error, item.attempts + 1);
          this.store.run("UPDATE time_entries SET sync_state='failed',updated_at=? WHERE id=?", [new Date().toISOString(), item.entity_id]);
          this.store.logSync('kimai', 'push', 'error', String(error.message || error), { entityId: item.entity_id });
          summary.failed += 1;
        }
      }
      return summary;
    } finally { this.running = false; }
  }

  async pushEntry(entryId) {
    const entry = this.store.getTimeEntry(entryId);
    if (!entry || !entry.ended_at) return;
    if (entry.kimai_id && entry.sync_state === 'synced') return;
    const project = this.store.getProject(entry.project_id);
    const client = this.kimaiClient();
    const remote = entry.kimai_id ? await client.updateTimesheet(entry, project) : await client.ensureTimesheet(entry, project);
    const kimaiId = remote?.id || entry.kimai_id;
    this.store.run("UPDATE time_entries SET kimai_id=?,sync_state='synced',updated_at=? WHERE id=?", [kimaiId, new Date().toISOString(), entryId]);
    this.store.logSync('kimai', entry.kimai_id ? 'update' : 'push', 'ok', `${entry.kimai_id ? 'Updated' : 'Uploaded'} ${entryId}`, { kimaiId });
  }

  async pullKimai(begin, end) {
    const client = this.kimaiClient();
    const rows = await client.timesheets(begin, end);
    const projects = this.store.listProjects();
    let imported = 0;
    for (const row of rows) {
      const remoteProjectId = typeof row.project === 'object' ? row.project.id : row.project;
      const localProject = projects.find((p) => Number(p.kimai_project_id) === Number(remoteProjectId));
      const normalized = client.normalizeRemote(row, localProject?.id || null);
      if (!normalized.endedAt) continue;
      this.store.upsertRemoteTimeEntry(normalized);
      imported += 1;
    }
    this.store.logSync('kimai', 'pull', 'ok', `Imported ${imported} timesheets`, { begin, end });
    return { imported, total: rows.length };
  }

  async syncJira(jql) {
    const client = this.jiraClient();
    const issues = await client.search(jql || this.store.getSetting('jira.jql', 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC'));
    this.store.saveJiraIssues(issues);
    this.store.logSync('jira', 'pull', 'ok', `Cached ${issues.length} issues`, { jql });
    return { imported: issues.length };
  }
}

module.exports = { SyncEngine };
