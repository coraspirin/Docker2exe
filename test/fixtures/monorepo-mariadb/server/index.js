const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME
});
const app = express();
app.use(express.static(path.join(__dirname, '../client/dist')));
app.get('/api/items', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT name, qty FROM items ORDER BY id');
    res.json({ items: rows, db: `${process.env.DB_HOST}:${process.env.DB_PORT}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.listen(process.env.PORT || 4000);
