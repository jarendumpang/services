'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const manifest = require('./model-files.json');
(async () => {
  const dir = path.join(__dirname, 'models');
  await fs.mkdir(dir, {recursive: true});
  for (const [name, sha256] of Object.entries(manifest.files)) {
    const target = path.join(dir, name);
    let bytes;
    try { bytes = await fs.readFile(target); } catch {}
    const digest = b => crypto.createHash('sha256').update(b).digest('hex');
    if (!bytes || digest(bytes) !== sha256) {
      const response = await fetch(`${manifest.base}/${name}`, {signal: AbortSignal.timeout(60000)});
      if (!response.ok) throw new Error(`Model download failed: ${name} (${response.status})`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (digest(bytes) !== sha256) throw new Error(`Model checksum mismatch: ${name}`);
      await fs.writeFile(target, bytes);
    }
    console.log(`Verified ${name}`);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
