const fs = require('fs');
const os = require('os');
const path = require('path');

/** Verilen dosyaları içeren geçici bir proje klasörü oluşturur. */
function makeProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2e-test-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

function removeProject(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { makeProject, removeProject };
