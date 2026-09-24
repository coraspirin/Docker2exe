const test = require('node:test');
const assert = require('node:assert/strict');
const { interpolateString, interpolateTree, InterpolationError } = require('../src/parser/interpolate');

const vars = { A: 'a', EMPTY: '', PORT: '5432' };

test('${VAR} ve $VAR', () => {
  assert.equal(interpolateString('x-${A}-$A-y', vars), 'x-a-a-y');
});

test(':- ve - default operatörleri boş/tanımsız ayrımını yapar', () => {
  assert.equal(interpolateString('${EMPTY:-d}', vars), 'd');
  assert.equal(interpolateString('${EMPTY-d}', vars), '');
  assert.equal(interpolateString('${NOPE-d}', vars), 'd');
  assert.equal(interpolateString('${NOPE:-d}', vars), 'd');
  assert.equal(interpolateString('${A:-d}', vars), 'a');
});

test('iç içe default', () => {
  assert.equal(interpolateString('${NOPE:-${PORT}}', vars), '5432');
  assert.equal(interpolateString('${NOPE:-host:${PORT:-1}}', vars), 'host:5432');
});

test(':? ve ? zorunlu değişken hatası', () => {
  assert.throws(() => interpolateString('${EMPTY:?gerekli}', vars), InterpolationError);
  assert.equal(interpolateString('${EMPTY?gerekli}', vars), '');
  assert.throws(() => interpolateString('${NOPE?gerekli}', vars), /NOPE — gerekli/);
});

test(':+ ve + alternatif değer', () => {
  assert.equal(interpolateString('${A:+yes}', vars), 'yes');
  assert.equal(interpolateString('${EMPTY:+yes}', vars), '');
  assert.equal(interpolateString('${EMPTY+yes}', vars), 'yes');
});

test('$$ kaçışı ve tek başına $', () => {
  assert.equal(interpolateString('p$$w${A}', vars), 'p$wa');
  assert.equal(interpolateString('5$ fiyat', vars), '5$ fiyat');
});

test('tanımsız değişken boş string olur ve missing listesine eklenir', () => {
  const missing = [];
  assert.equal(interpolateString('u:${SECRET}@h', vars, { missing, location: 'x.y' }), 'u:@h');
  assert.deepEqual(missing, [{ name: 'SECRET', location: 'x.y' }]);
});

test('kapanmamış ifade hata verir', () => {
  assert.throws(() => interpolateString('${A', vars), /Kapanmamış/);
});

test('interpolateTree sadece değerleri değiştirir, konum bilgisini taşır', () => {
  const missing = [];
  const out = interpolateTree({ '${A}': ['${A}', 1, null, { k: '${X}' }] }, vars, { missing });
  assert.deepEqual(out, { '${A}': ['a', 1, null, { k: '' }] });
  assert.deepEqual(missing, [{ name: 'X', location: '${A}.3.k' }]);
});
