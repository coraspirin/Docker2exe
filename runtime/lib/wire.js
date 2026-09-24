/**
 * DB sağlık kontrolleri için minimal wire-protocol yardımcıları (harici istemci binary'si gerektirmeden):
 * - MongoDB: OP_MSG + minimal BSON
 * - Redis: RESP inline komut
 * - MySQL/MariaDB: sunucu handshake paketi
 */
const net = require('net');
const crypto = require('crypto');

// --- BSON (sadece ihtiyaç duyulan tipler) ---

function encodeBson(doc) {
  const parts = [];
  for (const [key, value] of Object.entries(doc)) {
    if (value === undefined) continue;
    parts.push(encodeElement(key, value));
  }
  const body = Buffer.concat(parts);
  const out = Buffer.alloc(4 + body.length + 1);
  out.writeInt32LE(out.length, 0);
  body.copy(out, 4);
  return out;
}

function encodeElement(key, value) {
  const name = Buffer.concat([Buffer.from(key, 'utf8'), Buffer.from([0])]);
  let type;
  let payload;
  if (value === null) {
    type = 0x0a;
    payload = Buffer.alloc(0);
  } else if (typeof value === 'boolean') {
    type = 0x08;
    payload = Buffer.from([value ? 1 : 0]);
  } else if (typeof value === 'number' && Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31) {
    type = 0x10;
    payload = Buffer.alloc(4);
    payload.writeInt32LE(value, 0);
  } else if (typeof value === 'number') {
    type = 0x01;
    payload = Buffer.alloc(8);
    payload.writeDoubleLE(value, 0);
  } else if (Buffer.isBuffer(value)) {
    type = 0x05;
    payload = Buffer.alloc(5 + value.length);
    payload.writeInt32LE(value.length, 0);
    payload[4] = 0x00;
    value.copy(payload, 5);
  } else if (typeof value === 'string') {
    type = 0x02;
    const str = Buffer.from(value, 'utf8');
    payload = Buffer.alloc(4 + str.length + 1);
    payload.writeInt32LE(str.length + 1, 0);
    str.copy(payload, 4);
  } else if (Array.isArray(value)) {
    type = 0x04;
    payload = encodeBson(Object.fromEntries(value.map((v, i) => [String(i), v])));
  } else if (typeof value === 'object') {
    type = 0x03;
    payload = encodeBson(value);
  } else {
    throw new Error(`BSON: desteklenmeyen tip (${typeof value})`);
  }
  return Buffer.concat([Buffer.from([type]), name, payload]);
}

function decodeBson(buf, offset = 0, isArray = false) {
  const size = buf.readInt32LE(offset);
  const end = offset + size - 1;
  let pos = offset + 4;
  const out = isArray ? [] : {};
  while (pos < end) {
    const type = buf[pos++];
    const nameEnd = buf.indexOf(0, pos);
    const key = buf.toString('utf8', pos, nameEnd);
    pos = nameEnd + 1;
    let value;
    switch (type) {
      case 0x01: value = buf.readDoubleLE(pos); pos += 8; break;
      case 0x02: {
        const len = buf.readInt32LE(pos);
        value = buf.toString('utf8', pos + 4, pos + 4 + len - 1);
        pos += 4 + len;
        break;
      }
      case 0x03: case 0x04: {
        value = decodeBson(buf, pos, type === 0x04);
        pos += buf.readInt32LE(pos);
        break;
      }
      case 0x05: { const len = buf.readInt32LE(pos); value = Buffer.from(buf.subarray(pos + 5, pos + 5 + len)); pos += 4 + 1 + len; break; }
      case 0x07: value = buf.toString('hex', pos, pos + 12); pos += 12; break;
      case 0x08: value = buf[pos] === 1; pos += 1; break;
      case 0x09: value = new Date(Number(buf.readBigInt64LE(pos))); pos += 8; break;
      case 0x0a: value = null; break;
      case 0x10: value = buf.readInt32LE(pos); pos += 4; break;
      case 0x11: value = null; pos += 8; break;
      case 0x12: value = Number(buf.readBigInt64LE(pos)); pos += 8; break;
      case 0x13: value = null; pos += 16; break;
      default: throw new Error(`BSON: bilinmeyen tip 0x${type.toString(16)}`);
    }
    if (isArray) out.push(value);
    else out[key] = value;
  }
  return out;
}

// --- TCP yardımcıları ---

/**
 * Bağlanır, `payload` gönderir (varsa), `isComplete(buffer)` true olana kadar okur.
 */
function exchange(port, payload, isComplete, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('zaman aşımı'));
    }, timeoutMs);
    const done = (err, value) => {
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    socket.on('connect', () => { if (payload) socket.write(payload); });
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (isComplete(data)) done(null, data);
    });
    socket.on('error', err => done(err));
    socket.on('close', () => done(new Error('bağlantı kapandı')));
  });
}

let requestId = 1;

function opMsg(command) {
  const doc = encodeBson(command);
  const header = Buffer.alloc(16);
  const body = Buffer.concat([Buffer.alloc(4), Buffer.from([0]), doc]); // flagBits=0, section kind 0
  header.writeInt32LE(16 + body.length, 0);
  header.writeInt32LE(requestId++, 4);
  header.writeInt32LE(0, 8);
  header.writeInt32LE(2013, 12);
  return Buffer.concat([header, body]);
}

/** MongoDB OP_MSG komutu gönderir (tek seferlik bağlantı), yanıt dokümanını döner. */
async function mongoCommand(port, command, timeoutMs) {
  const res = await exchange(port, opMsg(command), b => b.length >= 4 && b.length >= b.readInt32LE(0), timeoutMs);
  // header(16) + flagBits(4) + kind(1) + bson
  return decodeBson(res, 21);
}

/** Aynı bağlantı üzerinde sıralı komutlar (SCRAM kimlik doğrulaması bağlantıya bağlıdır). */
class MongoConnection {
  static open(port, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error('zaman aşımı')));
      socket.once('connect', () => resolve(new MongoConnection(socket)));
      socket.once('error', reject);
    });
  }

  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.pending && this.buffer.length >= 4 && this.buffer.length >= this.buffer.readInt32LE(0)) {
        const size = this.buffer.readInt32LE(0);
        const msg = this.buffer.subarray(0, size);
        this.buffer = this.buffer.subarray(size);
        const { resolve } = this.pending;
        this.pending = null;
        resolve(decodeBson(msg, 21));
      }
    });
    const fail = err => {
      if (!this.pending) return;
      const { reject } = this.pending;
      this.pending = null;
      reject(err);
    };
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('bağlantı kapandı')));
  }

  command(cmd) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.socket.write(opMsg(cmd));
    });
  }

  /** SCRAM-SHA-256 (RFC 7677). Şifre ASCII varsayılır (SASLprep uygulanmaz). */
  async authenticate(user, password, db = 'admin') {
    const nonce = crypto.randomBytes(24).toString('base64');
    const escapedUser = user.replace(/=/g, '=3D').replace(/,/g, '=2C');
    const clientFirstBare = `n=${escapedUser},r=${nonce}`;
    const start = await this.command({
      saslStart: 1,
      mechanism: 'SCRAM-SHA-256',
      payload: Buffer.from(`n,,${clientFirstBare}`),
      autoAuthorize: 1,
      options: { skipEmptyExchange: true },
      $db: db
    });
    if (start.ok !== 1) throw new Error(`saslStart: ${start.errmsg}`);
    const serverFirst = start.payload.toString('utf8');
    const attrs = Object.fromEntries(serverFirst.split(',').map(p => [p[0], p.slice(2)]));
    if (!attrs.r || !attrs.r.startsWith(nonce)) throw new Error('SCRAM: geçersiz sunucu nonce');

    const salted = crypto.pbkdf2Sync(password, Buffer.from(attrs.s, 'base64'), Number(attrs.i), 32, 'sha256');
    const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
    const storedKey = crypto.createHash('sha256').update(clientKey).digest();
    const withoutProof = `c=biws,r=${attrs.r}`;
    const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`;
    const signature = crypto.createHmac('sha256', storedKey).update(authMessage).digest();
    const proof = Buffer.from(clientKey.map((b, i) => b ^ signature[i]));

    let res = await this.command({
      saslContinue: 1,
      conversationId: start.conversationId,
      payload: Buffer.from(`${withoutProof},p=${proof.toString('base64')}`),
      $db: db
    });
    if (res.ok !== 1) throw new Error(`kimlik doğrulama başarısız: ${res.errmsg}`);
    if (!res.done) {
      res = await this.command({ saslContinue: 1, conversationId: start.conversationId, payload: Buffer.alloc(0), $db: db });
      if (res.ok !== 1 || !res.done) throw new Error(`kimlik doğrulama tamamlanamadı: ${res.errmsg || ''}`);
    }
  }

  close() {
    this.socket.destroy();
  }
}

/** Redis'e inline komut gönderir, ilk yanıt satırını döner (`+PONG`, `-NOAUTH ...`). */
async function redisCommand(port, line, timeoutMs) {
  const res = await exchange(port, Buffer.from(`${line}\r\n`), b => b.includes('\r\n'), timeoutMs);
  return res.toString('utf8').split('\r\n')[0];
}

/** MySQL/MariaDB sunucusunun ilk handshake paketini okur. Döner: { protocol, serverVersion } veya hata paketi mesajı. */
async function mysqlHandshake(port, timeoutMs) {
  const res = await exchange(port, null, b => b.length >= 4 && b.length >= 4 + b.readUIntLE(0, 3), timeoutMs);
  const payload = res.subarray(4);
  if (payload[0] === 0xff) {
    return { error: payload.toString('utf8', 3) };
  }
  const nul = payload.indexOf(0, 1);
  return { protocol: payload[0], serverVersion: payload.toString('utf8', 1, nul) };
}

module.exports = { encodeBson, decodeBson, mongoCommand, MongoConnection, redisCommand, mysqlHandshake, exchange };
