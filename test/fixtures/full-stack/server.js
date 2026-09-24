require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT||3000)
