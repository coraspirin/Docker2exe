const os = require('os');
const path = require('path');
const fse = require('fs-extra');

/**
 * Build süresince kullanılan geçici çalışma dizini. `cleanup()` idempotenttir;
 * çağıran taraf her durumda (`finally`) çağırmalıdır.
 */
async function createTempWorkspace(prefix = 'docker2exe-') {
  const dir = await fse.mkdtemp(path.join(os.tmpdir(), prefix));
  let cleaned = false;

  return {
    dir,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      // Windows'ta git pack dosyaları salt-okunur işaretlenebilir; fs-extra remove bunu tekrar deneyerek siler.
      await fse.remove(dir);
    }
  };
}

module.exports = { createTempWorkspace };
