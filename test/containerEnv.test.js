const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContainerEnv } = require('../src/builder/containerEnv');
const { makeProject, removeProject } = require('./helpers');

test('container yolları: volume → veri klasörü, imaj yolu → paket, karşılıksız → kaldırılır', () => {
  const out = makeProject({ 'app/client/dist/index.html': '', 'app/server/tessdata/tur.traineddata': '' });
  try {
    const container = {
      workdir: '/app/server',
      env: { NODE_ENV: 'production', PATH: '/usr/bin', CLIENT_DIR: '/app/client/dist', DATA_DIR: '/data/db', TESSDATA_DIR: '/app/server/tessdata', CACHE: '/var/cache/x', PORT: '4000' },
      volumes: ['/data']
    };
    const svc = { resolvedEnvironment: { PORT: '4000', UPLOAD_DIR: '/data/uploads' }, volumes: ['defterim-data:/data', './config:/app/config:ro'] };
    const r = buildContainerEnv(container, svc, 'app/server', out);
    assert.equal(r.env.NODE_ENV, 'production');
    assert.equal(r.env.PATH, undefined);
    assert.equal(r.env.PORT, '4000');
    assert.equal(r.env.DATA_DIR, '${D2E_DATA_DIR}/volumes/defterim-data/db');
    assert.equal(r.env.UPLOAD_DIR, '${D2E_DATA_DIR}/volumes/defterim-data/uploads');
    assert.equal(r.env.CLIENT_DIR, '${D2E_INSTALL_DIR}/app/client/dist');
    assert.equal(r.env.TESSDATA_DIR, '${D2E_INSTALL_DIR}/app/server/tessdata');
    assert.equal('CACHE' in r.env, false);
    assert.ok(r.warnings.some(w => w.startsWith('CACHE=')));
    assert.ok(r.warnings.some(w => w.includes('Bind mount')));
  } finally {
    removeProject(out);
  }
});

test('container yolları: tek klasörlü uygulama (WORKDIR /usr/src/app ↔ app)', () => {
  const out = makeProject({ 'app/public/x.txt': '' });
  try {
    const r = buildContainerEnv({ workdir: '/usr/src/app', env: { STATIC: '/usr/src/app/public' }, volumes: [] }, { resolvedEnvironment: {}, volumes: [] }, 'app', out);
    assert.equal(r.env.STATIC, '${D2E_INSTALL_DIR}/app/public');
  } finally {
    removeProject(out);
  }
});
