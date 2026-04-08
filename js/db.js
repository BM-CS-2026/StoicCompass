/* ===== Inner Calm — PouchDB storage + Cloudant sync ===== */

const localDB = new PouchDB('stoiccompass');

let _remoteDB = null;
let _syncHandler = null;
let _syncStatusCb = null;

// ── Document helpers ──
function docId(type, key) { return `${type}:${key}`; }

// ── Generic CRUD ──

async function dbPut(type, key, data) {
  const _id = docId(type, key);
  const doc = { _id, type, ...data };
  try {
    const existing = await localDB.get(_id);
    doc._rev = existing._rev;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  return localDB.put(doc);
}

async function dbGet(type, key) {
  try {
    const doc = await localDB.get(docId(type, key));
    const { _id, _rev, type: _, ...rest } = doc;
    return rest;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function dbGetAll(type) {
  const result = await localDB.allDocs({
    include_docs: true,
    startkey: `${type}:`,
    endkey: `${type}:\ufff0`
  });
  return result.rows.map(r => {
    const { _id, _rev, ...rest } = r.doc;
    return rest;
  });
}

async function dbDelete(type, key) {
  try {
    const doc = await localDB.get(docId(type, key));
    return localDB.remove(doc);
  } catch (e) {
    if (e.status === 404) return;
    throw e;
  }
}

// ── State persistence ──
// Each collection stores individual docs: log:{id}, thoughtrecord:{id}, etc.
// Settings stored as setting:{key}

async function loadFullState() {
  const logs = await dbGetAll('log');
  const thoughtRecords = await dbGetAll('thoughtrecord');
  const assessments = await dbGetAll('assessment');
  const morningEntries = await dbGetAll('morning');
  const eveningEntries = await dbGetAll('evening');
  const dailyCheckDocs = await dbGetAll('dailycheck');
  const settingsDoc = await dbGet('setting', 'main');

  // Convert dailycheck docs back to object keyed by date
  const dailyChecks = {};
  dailyCheckDocs.forEach(d => { if (d.date) dailyChecks[d.date] = d.checks || {}; });

  // Sort by date descending
  const byDateDesc = (a, b) => (b.date || '').localeCompare(a.date || '');
  logs.sort(byDateDesc);
  thoughtRecords.sort(byDateDesc);
  assessments.sort(byDateDesc);
  morningEntries.sort(byDateDesc);
  eveningEntries.sort(byDateDesc);

  return {
    startDate: settingsDoc?.startDate || new Date().toISOString().split('T')[0],
    userName: settingsDoc?.userName || 'Boaz Manash',
    logs,
    thoughtRecords,
    assessments,
    morningEntries,
    eveningEntries,
    dailyChecks,
    streak: 0,
  };
}

async function saveSetting(key, value) {
  return dbPut('setting', 'main', { ...(await dbGet('setting', 'main') || {}), [key]: value });
}

async function saveLog(log) {
  return dbPut('log', String(log.id), log);
}

async function deleteLogDoc(id) {
  return dbDelete('log', String(id));
}

async function saveThoughtRecord(tr) {
  return dbPut('thoughtrecord', String(tr.id), tr);
}

async function saveAssessmentDoc(a) {
  return dbPut('assessment', String(a.id), a);
}

async function saveMorningEntry(m) {
  const id = m.id || Date.now();
  return dbPut('morning', String(id), { ...m, id });
}

async function saveEveningEntry(e) {
  const id = e.id || Date.now();
  return dbPut('evening', String(id), { ...e, id });
}

async function saveDailyCheck(date, checks) {
  return dbPut('dailycheck', date, { date, checks });
}

// ── Migration from localStorage ──

async function migrateFromLocalStorage() {
  const raw = localStorage.getItem('stoiccompass_state');
  if (!raw) return false;

  try {
    const old = JSON.parse(raw);
    console.log('[Migration] Migrating from localStorage...');

    // Save settings
    if (old.startDate) {
      await dbPut('setting', 'main', { startDate: old.startDate });
    }

    // Save logs
    if (old.logs) {
      for (const log of old.logs) {
        await dbPut('log', String(log.id), log);
      }
    }

    // Save thought records
    if (old.thoughtRecords) {
      for (const tr of old.thoughtRecords) {
        await dbPut('thoughtrecord', String(tr.id), tr);
      }
    }

    // Save assessments
    if (old.assessments) {
      for (const a of old.assessments) {
        const id = a.id || Date.now() + Math.random();
        await dbPut('assessment', String(id), { ...a, id });
      }
    }

    // Save morning entries
    if (old.morningEntries) {
      for (const m of old.morningEntries) {
        const id = m.id || Date.now() + Math.random();
        await dbPut('morning', String(id), { ...m, id });
      }
    }

    // Save evening entries
    if (old.eveningEntries) {
      for (const e of old.eveningEntries) {
        const id = e.id || Date.now() + Math.random();
        await dbPut('evening', String(id), { ...e, id });
      }
    }

    // Save daily checks
    if (old.dailyChecks) {
      for (const [date, checks] of Object.entries(old.dailyChecks)) {
        await dbPut('dailycheck', date, { date, checks });
      }
    }

    // Remove old localStorage
    localStorage.removeItem('stoiccompass_state');
    console.log('[Migration] Done. localStorage cleared.');
    return true;
  } catch (e) {
    console.error('[Migration] Error:', e);
    return false;
  }
}

// ── Sync ──

function getSyncUrl() {
  return (localStorage.getItem('stoiccompass_sync_url') || '').replace(/\s+/g, '');
}

function setSyncUrl(url) {
  if (url) localStorage.setItem('stoiccompass_sync_url', url);
  else localStorage.removeItem('stoiccompass_sync_url');
}

function makeRemoteDB(remoteUrl) {
  const cleanUrl = (remoteUrl || '').replace(/\s+/g, '');
  try {
    const parsed = new URL(cleanUrl);
    if (parsed.username) {
      const user = decodeURIComponent(parsed.username);
      const pass = decodeURIComponent(parsed.password);
      parsed.username = '';
      parsed.password = '';
      const baseUrl = parsed.toString();
      return new PouchDB(baseUrl, {
        skip_setup: true,
        fetch: function(url, opts) {
          opts = opts || {};
          opts.headers = new Headers(opts.headers || {});
          opts.headers.set('Authorization', 'Basic ' + btoa(user + ':' + pass));
          opts.credentials = 'omit';
          return fetch(url, opts);
        }
      });
    }
  } catch (e) { console.error('[Sync] URL parse error:', e); }
  return new PouchDB(cleanUrl, { skip_setup: true });
}

function startSync(onChange) {
  const url = getSyncUrl();
  if (!url) return null;

  stopSync();
  _syncStatusCb = onChange;
  _remoteDB = makeRemoteDB(url);

  _syncHandler = localDB.sync(_remoteDB, { live: true, retry: true })
    .on('change', (info) => {
      console.log('[Sync]', info.direction, info.change.docs.length, 'docs');
      if (_syncStatusCb) _syncStatusCb('change', info);
    })
    .on('paused', () => { if (_syncStatusCb) _syncStatusCb('paused'); })
    .on('active', () => { if (_syncStatusCb) _syncStatusCb('active'); })
    .on('error', (err) => {
      console.error('[Sync] error', err);
      if (_syncStatusCb) _syncStatusCb('error', err);
    });

  return _syncHandler;
}

function stopSync() {
  if (_syncHandler) { _syncHandler.cancel(); _syncHandler = null; }
  _remoteDB = null;
}

async function testSync(url) {
  const remote = makeRemoteDB(url);
  const info = await remote.info();
  return info;
}

// ── Daily Backup ──

function scheduleDailyBackup() {
  const url = getSyncUrl();
  if (!url) return;
  const BACKUP_KEY = 'stoic_last_backup';
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const lastPush = parseInt(localStorage.getItem(BACKUP_KEY) || '0');
  if (Date.now() - lastPush > ONE_DAY) {
    setTimeout(async () => {
      try {
        const remote = makeRemoteDB(url);
        await localDB.replicate.to(remote);
        localStorage.setItem(BACKUP_KEY, String(Date.now()));
        console.log('[Backup] Daily push complete');
      } catch (e) { console.warn('[Backup] Push failed:', e.message); }
    }, 15000);
  }
}

// ── Export / Import ──

async function exportAllData() {
  const allDocs = await localDB.allDocs({ include_docs: true });
  const docs = allDocs.rows
    .filter(r => !r.id.startsWith('_'))
    .map(r => {
      const { _rev, ...doc } = r.doc;
      return doc;
    });
  return { version: 1, exported: new Date().toISOString(), docs };
}

async function importAllData(data) {
  if (!data?.docs) throw new Error('Invalid backup file');
  let imported = 0;
  for (const doc of data.docs) {
    try {
      const { _rev, ...cleanDoc } = doc;
      try {
        const existing = await localDB.get(doc._id);
        cleanDoc._rev = existing._rev;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      await localDB.put(cleanDoc);
      imported++;
    } catch (e) {
      console.warn('[Import] Skipped:', doc._id, e.message);
    }
  }
  return imported;
}

// ── Push / Pull (one-time) ──

async function pushOnce(remoteUrl) {
  const remote = makeRemoteDB(remoteUrl);
  return new Promise((resolve, reject) => {
    localDB.replicate.to(remote, { batch_size: 25 })
      .on('complete', info => resolve(info))
      .on('error', err => reject(err));
  });
}

async function pullOnce(remoteUrl) {
  const remote = makeRemoteDB(remoteUrl);
  return new Promise((resolve, reject) => {
    localDB.replicate.from(remote, { batch_size: 25 })
      .on('complete', info => resolve(info))
      .on('error', err => reject(err));
  });
}

async function checkRemote(remoteUrl) {
  const remote = makeRemoteDB(remoteUrl);
  const info = await remote.info();
  return info;
}

async function getLocalDbInfo() {
  return localDB.info();
}

async function destroyLocalDb() {
  return localDB.destroy();
}
