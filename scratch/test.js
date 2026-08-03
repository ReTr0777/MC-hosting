const fs = require('fs');
const cp = require('child_process');
const dir = '/app/apps/daemon/data/0e28de71-ef1c-4469-972a-2139a7300a95/mods';
const files = fs.readdirSync(dir);
for (const f of files) {
  if (f.endsWith('.jar')) {
    try {
      cp.execSync('unzip -tq "' + dir + '/' + f + '"', { stdio: 'ignore' });
    } catch (e) {
      console.log('CORRUPT: ' + f);
    }
  }
}
console.log('DONE');
