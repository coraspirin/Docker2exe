const express = require('express');
const { createClient } = require('redis');
const redis = createClient({ url: process.env.REDIS_URL });
const app = express();
app.get('/api/msg', async (req, res) => res.json({ msg: 'API yanıtı', visits: await redis.incr('visits') }));
redis.connect().then(() => app.listen(process.env.PORT || 4100));
