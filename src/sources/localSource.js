const path = require('path');
const fse = require('fs-extra');

// Kopyalanmayan dizinler: bağımlılıklar build aşamasında temiz kurulur, VCS verisi gereksiz.
const EXCLUDED_DIRS = new Set(['node_modules', '.git']);

/**
 * Yerel proje klasörünü temp workspace'e kopyalar; orijinal klasöre dokunulmaz.
 * @returns {Promise<{ projectDir: string, origin: string }>}
 */
async function resolveLocalSource(sourcePath, workspace) {
  const absolute = path.resolve(sourcePath);
  const stat = await fse.stat(absolute).catch(() => null);
  if (!stat) throw new Error(`Kaynak klasör bulunamadı: ${absolute}`);
  if (!stat.isDirectory()) throw new Error(`Kaynak bir klasör değil: ${absolute}`);

  const workspaceDir = path.resolve(workspace.dir);
  if (workspaceDir.startsWith(absolute + path.sep)) {
    throw new Error(`Temp workspace kaynak klasörün içinde olamaz: ${workspaceDir}`);
  }

  const projectDir = path.join(workspace.dir, 'source');
  await fse.copy(absolute, projectDir, {
    filter: src => !EXCLUDED_DIRS.has(path.basename(src)) || src === absolute
  });

  return { projectDir, origin: absolute };
}

module.exports = { resolveLocalSource };
