const path = require('path');
const simpleGit = require('simple-git');

/**
 * GitHub reposunu `--depth 1` ile temp workspace'e klonlar.
 * Proxy: git, HTTP_PROXY/HTTPS_PROXY ortam değişkenlerini kendisi okur; ek ayar gerekmez.
 * Token URL'e enjekte edilir ama hiçbir log/hata mesajında görünmez.
 * @returns {Promise<{ projectDir: string, origin: string }>}
 */
async function resolveGithubSource(repoUrl, workspace, { branch, token } = {}) {
  const parsed = parseGithubUrl(repoUrl);
  const cloneUrl = buildCloneUrl(parsed, token);
  const projectDir = path.join(workspace.dir, 'source');

  const cloneArgs = ['--depth', '1', '--single-branch'];
  if (branch) cloneArgs.push('--branch', branch);

  try {
    await simpleGit({
      // Credential helper boşaltılır: Git Credential Manager URL'deki token'ı Windows Kimlik
      // Yöneticisi'ne kaydetmesin ve etkileşimli giriş penceresi açmasın. simple-git bu ayarı
      // varsayılan olarak engellediği için açıkça izin veriliyor (helper eklemiyoruz, kaldırıyoruz).
      config: ['credential.helper='],
      unsafe: { allowUnsafeCredentialHelper: true }
    })
      .env(cloneEnv())
      .clone(cloneUrl, projectDir, cloneArgs);
  } catch (err) {
    const detail = redact(err.message, token);
    const hint = token
      ? 'Token\'ın repo için "Contents: read" yetkisi olduğunu ve branch adını kontrol edin.'
      : 'Repo private ise --token ile bir GitHub PAT verin.';
    throw new Error(`GitHub reposu klonlanamadı (${parsed.display}${branch ? `, branch: ${branch}` : ''}).\n${detail}\n${hint}`);
  }

  return { projectDir, origin: parsed.display };
}

/**
 * Clone için ortam: HTTP_PROXY/HTTPS_PROXY/NO_PROXY korunur. IDE'lerin enjekte ettiği GIT_* değişkenleri
 * (GIT_ASKPASS, GIT_EDITOR ...) ve editör/pager ayarları çıkarılır; bunlar etkileşimli prompt açabilir ve
 * simple-git tarafından güvensiz kabul edilir.
 */
function cloneEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(GIT_|SSH_ASKPASS$|EDITOR$|VISUAL$|PAGER$)/i.test(key)) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  return env;
}

/** `https://github.com/user/repo(.git)(/tree/...)` biçimlerini kabul eder. */
function parseGithubUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Geçersiz GitHub URL'i: ${input}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Sadece https GitHub URL'leri destekleniyor: ${input}`);
  }
  if (url.username || url.password) {
    throw new Error('URL içinde kimlik bilgisi vermeyin; bunun yerine --token kullanın');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`GitHub URL'i "https://<host>/<kullanıcı>/<repo>" biçiminde olmalı: ${input}`);
  }
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, '');
  return { host: url.host, owner, repo, display: `https://${url.host}/${owner}/${repo}` };
}

function buildCloneUrl({ host, owner, repo }, token) {
  const auth = token ? `x-access-token:${encodeURIComponent(token)}@` : '';
  return `https://${auth}${host}/${owner}/${repo}.git`;
}

function redact(text, token) {
  if (!text) return '';
  let out = text.replace(/(https?:\/\/)[^@\s/]+@/g, '$1****@');
  if (token) {
    out = out.split(token).join('****').split(encodeURIComponent(token)).join('****');
  }
  return out;
}

module.exports = { resolveGithubSource, parseGithubUrl, buildCloneUrl, redact };
