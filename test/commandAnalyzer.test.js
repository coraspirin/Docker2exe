const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeCommand } = require('../src/detector/commandAnalyzer');

const entryOf = (cmd, ctx) => {
  const r = analyzeCommand(cmd, ctx);
  return r.kind === 'entry' ? r.file : r.kind;
};

test('düz node komutları', () => {
  assert.equal(entryOf('node server.js'), 'server.js');
  assert.equal(entryOf('node ./src/index.js --port 3000'), './src/index.js');
  assert.equal(entryOf('node --max-old-space-size 4096 -r dotenv/config app.js'), 'app.js');
  assert.equal(entryOf('node --enable-source-maps --env-file=.env dist/main.js'), 'dist/main.js');
  assert.equal(entryOf(['node', 'server.js']), 'server.js');
  assert.equal(entryOf(['/usr/local/bin/node', 'server.js']), 'server.js');
});

test('env önekleri ve sarmalayıcılar atlanır', () => {
  assert.equal(entryOf('NODE_ENV=production node index.js'), 'index.js');
  assert.equal(entryOf('cross-env NODE_ENV=production PORT=80 node index.js'), 'index.js');
  assert.equal(entryOf('dotenv -e .env.prod -- node app.js'), 'app.js');
  assert.equal(entryOf(['dumb-init', 'node', 'app.js']), 'app.js');
});

test('zincirlenmiş komutlarda son sunucu komutu esas alınır', () => {
  assert.equal(entryOf('npm run migrate && node dist/server.js'), 'dist/server.js');
  assert.equal(entryOf('node scripts/check.js; node server.js'), 'server.js');
});

test('watcher\'lar', () => {
  assert.equal(entryOf('nodemon app.js'), 'app.js');
  assert.equal(entryOf('pm2-runtime start server.js'), 'server.js');
  assert.equal(entryOf('forever start --minUptime=1000 lib/app.js'), 'lib/app.js');
  assert.equal(entryOf('pm2-runtime ecosystem.config.js'), 'unsupported');
});

test('npm/yarn script\'leri özyinelemeli çözülür', () => {
  const scripts = { start: 'npm run serve', serve: 'node srv.js', prod: 'yarn serve' };
  assert.equal(entryOf(['npm', 'start'], { scripts }), 'srv.js');
  assert.equal(entryOf('yarn prod', { scripts }), 'srv.js');
  assert.equal(entryOf('npm run nope', { scripts }), 'unsupported');
});

test('döngüsel script\'ler sonsuz döngüye girmez', () => {
  assert.equal(entryOf('npm run a', { scripts: { a: 'npm run b', b: 'npm run a' } }), 'unsupported');
});

test('sh -c sarmalayıcı', () => {
  assert.equal(entryOf(['sh', '-c', 'npx prisma migrate deploy && node server.js']), 'server.js');
});

test('SSR framework komutları', () => {
  assert.deepEqual(analyzeCommand('next start -p 3000').framework, 'next');
  assert.deepEqual(analyzeCommand('nuxt start').framework, 'nuxt');
  assert.deepEqual(analyzeCommand('node .output/server/index.mjs').kind, 'ssr');
  assert.equal(analyzeCommand('next dev').kind, 'unknown');
});

test('TypeScript ve diğer runtime\'lar desteklenmez', () => {
  assert.equal(entryOf('ts-node src/index.ts'), 'unsupported');
  assert.equal(entryOf('tsx watch src/index.ts'), 'unsupported');
  assert.equal(entryOf('node src/index.ts'), 'unsupported');
  assert.equal(entryOf('bun run server.js'), 'unsupported');
  assert.equal(entryOf('node -e "require(\'./a\')"'), 'unsupported');
});

test('tanınmayan komut', () => {
  assert.equal(entryOf('./start.sh'), 'unknown');
});
