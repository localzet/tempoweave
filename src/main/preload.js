'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('tempo', {
  bootstrap: () => invoke('app:bootstrap'),
  dashboard: (range) => invoke('dashboard:get', range),
  settings: {
    set: (key, value) => invoke('settings:set', { key, value }),
    setSecret: (key, value) => invoke('secrets:set', { key, value }),
    deleteSecret: (key) => invoke('secrets:delete', { key })
  },
  clients: { save: (data) => invoke('clients:save', data) },
  projects: { save: (data) => invoke('projects:save', data) },
  rates: {
    save: (data) => invoke('rates:save', data),
    delete: (id) => invoke('rates:delete', { id })
  },
  timers: {
    start: (data) => invoke('timers:start', data),
    stop: (id) => invoke('timers:stop', { id }),
    running: () => invoke('timers:running')
  },
  entries: {
    list: (range) => invoke('entries:list', range),
    save: (data) => invoke('entries:save', data),
    delete: (id) => invoke('entries:delete', { id })
  },
  payments: {
    list: (projectId) => invoke('payments:list', { projectId }),
    save: (data) => invoke('payments:save', data),
    delete: (id) => invoke('payments:delete', { id })
  },
  adjustments: {
    list: (projectId) => invoke('adjustments:list', { projectId }),
    save: (data) => invoke('adjustments:save', data)
  },
  schedules: {
    list: () => invoke('schedules:list'),
    save: (data) => invoke('schedules:save', data),
    materialize: (range) => invoke('schedules:materialize', range),
    mark: (data) => invoke('schedules:mark', data)
  },
  receipts: {
    list: () => invoke('receipts:list'),
    fetch: (data) => invoke('receipts:fetch', data),
    importFile: () => invoke('receipts:import-file'),
    link: (data) => invoke('receipts:link', data)
  },
  jira: {
    test: () => invoke('jira:test'),
    sync: (jql) => invoke('jira:sync', { jql }),
    search: (query) => invoke('jira:search', { query })
  },
  kimai: {
    test: () => invoke('kimai:test'),
    catalogs: () => invoke('kimai:catalogs'),
    pull: (range) => invoke('kimai:pull', range),
    push: () => invoke('kimai:push')
  },
  data: {
    backup: () => invoke('data:backup'),
    export: () => invoke('data:export')
  },
  shell: { open: (url) => invoke('shell:open', { url }) },
  onSyncStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('sync:status', listener);
    return () => ipcRenderer.removeListener('sync:status', listener);
  }
});
