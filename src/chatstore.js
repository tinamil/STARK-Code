// Saved chats: one JSON file per chat plus a small index, so listing history doesn't read every chat.
// Old chats are pruned: at most MAX_CHATS are kept, and none older than MAX_AGE_DAYS.
const fsp = require('fs/promises');
const path = require('path');

const MAX_CHATS = 100;
const MAX_AGE_DAYS = 90;

class ChatStore {
  constructor(dir, { maxChats = MAX_CHATS, maxAgeDays = MAX_AGE_DAYS } = {}) {
    this.dir = dir; this.maxChats = maxChats; this.maxAgeMs = maxAgeDays * 86400000;
    this.indexPath = path.join(dir, 'index.json');
    this.queue = Promise.resolve();   // serialize index updates
  }

  file(id) { return path.join(this.dir, `${String(id).replace(/[^\w.-]/g, '_')}.json`); }

  async readIndex() {
    try { return JSON.parse(await fsp.readFile(this.indexPath, 'utf8')); } catch { /* missing or corrupt */ }
    // Rebuild from the chat files (first run after upgrading, or a damaged index).
    const index = {};
    let names = [];
    try { names = await fsp.readdir(this.dir); } catch { return index; }
    for (const name of names) {
      if (!name.endsWith('.json') || name === 'index.json') continue;
      try {
        const d = JSON.parse(await fsp.readFile(path.join(this.dir, name), 'utf8'));
        if (d && d.id) index[d.id] = { id: d.id, title: d.title, updated: d.updated || 0, root: d.root };
      } catch { /* skip unreadable */ }
    }
    return index;
  }

  async writeIndex(index) {
    await fsp.mkdir(this.dir, { recursive: true });
    const tmp = this.indexPath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(index));
    await fsp.rename(tmp, this.indexPath);
  }

  /** Runs index read-modify-write operations one at a time. */
  update(fn) {
    const run = this.queue.then(async () => { const index = await this.readIndex(); const r = await fn(index); await this.writeIndex(index); return r; });
    this.queue = run.catch(() => {});
    return run;
  }

  async save(chat) {
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(this.file(chat.id), JSON.stringify(chat));
    return this.update(async (index) => {
      index[chat.id] = { id: chat.id, title: chat.title, updated: chat.updated, root: chat.root };
      await this.prune(index, chat.id);
    });
  }

  async prune(index, keepId) {
    const now = Date.now();
    const all = Object.values(index).sort((a, b) => b.updated - a.updated);
    const remove = all.filter((c, i) => c.id !== keepId && (i >= this.maxChats || now - c.updated > this.maxAgeMs));
    for (const c of remove) {
      delete index[c.id];
      await fsp.unlink(this.file(c.id)).catch(() => {});
    }
  }

  async list(root, limit = 100) {
    const index = await this.queue.then(() => this.readIndex());
    return Object.values(index).filter((c) => c.root === root).sort((a, b) => b.updated - a.updated).slice(0, limit);
  }

  async load(id) { return JSON.parse(await fsp.readFile(this.file(id), 'utf8')); }

  async remove(id) {
    await fsp.unlink(this.file(id)).catch(() => {});
    return this.update(async (index) => { delete index[id]; });
  }
}

module.exports = { ChatStore, MAX_CHATS, MAX_AGE_DAYS };
