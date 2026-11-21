const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ChatStore } = require('../src/chatstore');
const { tempWorkspace } = require('./helpers');

const chat = (id, root, updated) => ({ id, root, updated, title: `chat ${id}`, messages: [] });

test('save, list by workspace, load and remove', async () => {
  const s = new ChatStore(tempWorkspace());
  await s.save(chat('a', '/p1', 1000)); await s.save(chat('b', '/p1', Date.now())); await s.save(chat('c', '/p2', Date.now()));
  const l = await s.list('/p1');
  assert.deepStrictEqual(l.map((c) => c.id), ['b']);   // 'a' is older than 90 days and was pruned
  assert.strictEqual((await s.load('c')).title, 'chat c');
  await s.remove('c');
  assert.deepStrictEqual(await s.list('/p2'), []);
});
test('keeps at most maxChats, deleting the oldest files', async () => {
  const dir = tempWorkspace(); const s = new ChatStore(dir, { maxChats: 3 });
  const now = Date.now();
  for (let i = 0; i < 5; i++) await s.save(chat(`c${i}`, '/p', now - (5 - i) * 1000));
  assert.deepStrictEqual((await s.list('/p')).map((c) => c.id), ['c4', 'c3', 'c2']);
  assert.ok(!fs.existsSync(path.join(dir, 'c0.json')) && !fs.existsSync(path.join(dir, 'c1.json')));
});
test('rebuilds the index from chat files (upgrade from older versions)', async () => {
  const dir = tempWorkspace();
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify(chat('1', '/p', Date.now())));
  assert.deepStrictEqual((await new ChatStore(dir).list('/p')).map((c) => c.id), ['1']);
});
test('concurrent saves do not lose index entries', async () => {
  const s = new ChatStore(tempWorkspace());
  await Promise.all(Array.from({ length: 10 }, (_, i) => s.save(chat(`x${i}`, '/p', Date.now()))));
  assert.strictEqual((await s.list('/p')).length, 10);
});
