const fs = require('fs');
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', fs.readFileSync('src/index.html', 'utf8').replace('{{BUILD}}', new Date().toISOString()));
