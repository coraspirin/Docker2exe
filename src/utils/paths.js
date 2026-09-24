const os = require('os');
const path = require('path');

/** Aracın kullanıcı dizini (~/.docker2exe). Testler için DOCKER2EXE_HOME ile değiştirilebilir. */
function toolHome() {
  return process.env.DOCKER2EXE_HOME || path.join(os.homedir(), '.docker2exe');
}

function cacheDir() {
  return path.join(toolHome(), 'cache');
}

/** @yao-pkg/pkg'nin indirdiği Node base binary'leri. */
function pkgCacheDir() {
  return path.join(toolHome(), 'pkg-cache');
}

const PROJECT_ROOT = path.join(__dirname, '..', '..');

module.exports = { toolHome, cacheDir, pkgCacheDir, PROJECT_ROOT };
