/** DB servislerini depends_on'a göre sıralar (sadece DB'ler arası bağımlılıklar). */
function orderServices(services) {
  const names = new Set(services.map(s => s.name));
  const done = new Set();
  const out = [];
  const visit = (s, stack) => {
    if (done.has(s.name)) return;
    if (stack.has(s.name)) throw new Error(`DB servisleri arasında döngüsel depends_on: ${[...stack, s.name].join(' → ')}`);
    stack.add(s.name);
    for (const dep of s.dependsOn || []) {
      if (names.has(dep)) visit(services.find(x => x.name === dep), stack);
    }
    stack.delete(s.name);
    done.add(s.name);
    out.push(s);
  };
  services.forEach(s => visit(s, new Set()));
  return out;
}

function logNameFor(svc, services) {
  const sameType = services.filter(s => s.type === svc.type).length;
  return sameType > 1 ? `${svc.type}-${svc.name}.log` : `${svc.type}.log`;
}

module.exports = { orderServices, logNameFor };
