const path = require('path');
const fs = require('fs');
const express = require('express');
const { Pool } = require('pg');
const { createClient } = require('redis');
const bcrypt = require('bcrypt');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', err => console.error('redis', err.message));

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const template = fs.readFileSync(path.join(__dirname, 'views', 'about.html'), 'utf8');

app.get('/api/health', async (req, res) => {
  try {
    const notes = await pool.query('SELECT body FROM notes ORDER BY id');
    const hits = await redis.incr('hits');
    const hash = await bcrypt.hash('parola', 4);
    res.json({ notes: notes.rows.map(r => r.body), hits, bcrypt: await bcrypt.compare('parola', hash), node: process.version });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/about', (req, res) => res.type('html').send(template));

(async () => {
  await redis.connect();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`defter dinliyor: ${port}`));
})();
