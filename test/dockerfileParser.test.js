const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDockerfileContent, splitShellWords } = require('../src/parser/dockerfileParser');

test('exec form CMD, WORKDIR, EXPOSE, ENV', () => {
  const df = parseDockerfileContent(`
# yorum
FROM node:20-alpine
WORKDIR /app
ENV PORT=3000 NODE_ENV=production
EXPOSE 3000/tcp 9229
CMD ["node", "server.js"]
`);
  assert.equal(df.final.baseImage, 'node:20-alpine');
  assert.equal(df.final.workdir, '/app');
  assert.deepEqual(df.final.expose, [3000, 9229]);
  assert.deepEqual(df.final.env, { PORT: '3000', NODE_ENV: 'production' });
  assert.deepEqual(df.final.cmd, { form: 'exec', args: ['node', 'server.js'] });
});

test('shell form ve satır devamı', () => {
  const df = parseDockerfileContent('FROM node:18\nCMD npm run build && \\\n    node dist/index.js\n');
  assert.equal(df.final.cmd.form, 'shell');
  assert.equal(df.final.cmd.raw, 'npm run build &&  node dist/index.js');
});

test('multi-stage: son stage esas alınır, ARG ile base image', () => {
  const df = parseDockerfileContent(`
ARG NODE_VERSION=22
FROM node:\${NODE_VERSION}-alpine AS build
WORKDIR /src
EXPOSE 5173
CMD ["npm", "run", "dev"]
FROM node:\${NODE_VERSION}-slim
WORKDIR /srv
WORKDIR app
CMD ["node", "/srv/app/dist/main.js"]
`);
  assert.deepEqual(df.stages.map(s => s.baseImage), ['node:22-alpine', 'node:22-slim']);
  assert.equal(df.stages[0].name, 'build');
  assert.equal(df.final.workdir, '/srv/app');
  assert.deepEqual(df.final.expose, []);
  assert.deepEqual(df.final.cmd.args, ['node', '/srv/app/dist/main.js']);
});

test('önceki stage\'den türeyen stage ayarları devralır', () => {
  const df = parseDockerfileContent('FROM node:20 AS base\nWORKDIR /app\nEXPOSE 8080\nFROM base AS dev\nFROM dev\nCMD ["node","a.js"]\n');
  assert.equal(df.final.baseImage, 'dev');
  assert.equal(df.final.rootImage, 'node:20');
  assert.equal(df.final.workdir, '/app');
  assert.deepEqual(df.final.expose, [8080]);
});

test('ENTRYPOINT tanımlanınca önceki CMD sıfırlanır', () => {
  const df = parseDockerfileContent('FROM node:20\nCMD ["node","a.js"]\nENTRYPOINT ["node"]\n');
  assert.equal(df.final.cmd, null);
  assert.deepEqual(df.final.entrypoint.args, ['node']);
});

test('splitShellWords tırnakları işler', () => {
  assert.deepEqual(splitShellWords(`node -r 'dotenv/config' "my app.js" a\\ b`), ['node', '-r', 'dotenv/config', 'my app.js', 'a b']);
});
