'use strict';

// you do not need to run this manually
// render-sql.js will do it for you
// but if you have an extensive new log to index, or many logs,
// you may wish to run this yourself

let fs = require('fs');
let path = require('path');
let { execFileSync } = require('child_process');

let sqlite = require('better-sqlite3');

let { root, historicalRoot, rooms, sanitizeRoomName, applyModifications } = require('../utils.js');


if (require.main === module) {
  (async () => {
    let dbDir = path.join(__dirname, '..', 'sql');
    fs.mkdirSync(dbDir, { recursive: true });
    for (let { room, historical } of rooms) {
      console.log(`Making DB for ${room}`);
      let jsonDir = path.join(historical ? historicalRoot : root, room);
      let sanitized = sanitizeRoomName(room);
      let dbFile = path.join(dbDir, sanitized + '.sqlite3');
      await makeDb(jsonDir, dbFile);
      execFileSync(path.join(__dirname, 'split-db.sh'), [dbFile, path.join(__dirname, '..', 'logs', 'docs', '_indexes', sanitized)]);
    }
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}

async function makeDb(jsonDir, outFile) {
  if (fs.existsSync(outFile)) {
    console.log('db exists; rm it if you want to recreate it');
    return;
  }
  let files = fs.readdirSync(jsonDir).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    return;
  }

  const db = await sqlite(outFile);

  await db.prepare(`
    create virtual table search using fts5(
      sender, ts UNINDEXED, idx UNINDEXED, content,
      prefix=3
    );
  `).run();

  let finalName = null;
  let finalLines = null;
  for (let file of files) {
    finalName = file;
    console.log('reading ' + file);
    let parts = [];
    let lines = JSON.parse(fs.readFileSync(path.join(jsonDir, file), 'utf8'));
    finalLines = lines;
    lines = applyModifications(lines);
    for (let [idx, line] of lines.entries()) {
      let { senderName, ts, content } = line;
      parts.push({ senderName, ts, idx, content });
    }
    if (parts.length === 0) {
      continue;
    }
    let statement = `insert into search values ${parts.map((v, i) => `($sender${i}, $ts${i}, $idx${i}, $content${i})`).join(', ')}`;
    let vals = Object.fromEntries(
      parts.flatMap(({ senderName, ts, idx, content}, i) => [
        [`sender${i}`, senderName],
        [`ts${i}`, ts],
        [`idx${i}`, idx],
        [`content${i}`, content.body],
      ])
    );
    db.prepare(statement).run(vals);
  }

  // console.log('creating indexes...');

  // await db.run('create index "index on ts" on messages (ts)');
  // await db.run('create index "index on sender" on messages (sender)');
  // await db.run('create index "index on ts and sender" on messages (ts, sender)');

  console.log('creating fts...');
  db.prepare(`insert into search(search) values ('optimize')`).run();

  console.log('optimizing...');
  db.prepare(`pragma page_size = 2048`).run();
  db.prepare(`vacuum`).run();
  db.prepare(`analyze`).run();

  db.close();

  console.log('noting last entry...');
  let lastAddedContents = { file: finalName };
  if (finalLines.length === 0) {
    lastAddedContents.ids = [];
  } else if (finalLines[0].id != null) {
    lastAddedContents.ids = finalLines.map(l => l.id);
  } else {
    // if we don't have a unique ID, fall back to timestamp
    lastAddedContents.ts = finalLines[finalLines.length - 1].ts;
  }
  let lastAddedName = outFile.replace(/\.sqlite3$/, '-last-added.json');
  fs.writeFileSync(lastAddedName, JSON.stringify(lastAddedContents), 'utf8');
}

module.exports = { makeDb };
