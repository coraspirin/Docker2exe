const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PKG_BIN = require.resolve('@yao-pkg/pkg/lib-es5/bin.js');

// @yao-pkg/pkg-fetch'in (v3.6) hazır Windows x64 base binary yayınladığı major'lar; diğerleri kaynaktan derleme gerektirir
const PKG_NODE_TARGETS = [22, 24, 26];

/**
 * @yao-pkg/pkg'yi ayrı süreçte çalıştırır (çıktısı spinner'ı bozmasın, hataları loglansın).
 * @param {{ entry: string, configFile: string, output: string, nodeMajor: number, logFile?: string, cwd: string }} opts
 */
function compileWithPkg({ entry, configFile, output, nodeMajor, logFile, cwd }) {
  if (!PKG_NODE_TARGETS.includes(nodeMajor)) {
    return Promise.reject(new Error(`pkg Node ${nodeMajor} hedefini desteklemiyor (desteklenen: ${PKG_NODE_TARGETS.join(', ')}); --node-target ile belirtin`));
  }
  // --no-bytecode: V8 bytecode'a derlenen script'lerde dinamik import() çalışmaz (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING);
  // kaynak kodu gizleme dahili kullanımda öncelik olmadığı için uyumluluk tercih edildi.
  const args = [
    PKG_BIN, entry, '--config', configFile, '--target', `node${nodeMajor}-win-x64`, '--output', output,
    '--compress', 'Brotli', '--no-bytecode', '--public-packages', '*', '--public'
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, env: process.env });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (logFile) fs.appendFileSync(logFile, `\n$ pkg ${args.slice(1).join(' ')}\n${out}\n[çıkış kodu ${code}]\n`);
      const warnings = out.split(/\r?\n/).filter(l => /Warning/i.test(l)).map(l => l.trim());
      if (code === 0 && fs.existsSync(output)) return resolve({ warnings, output: out });
      const tail = out.trim().split(/\r?\n/).slice(-20).join('\n    ');
      reject(new Error(`pkg derlemesi başarısız (${path.basename(output)}, çıkış kodu ${code}):\n    ${tail}`));
    });
  });
}

module.exports = { compileWithPkg, PKG_NODE_TARGETS };
