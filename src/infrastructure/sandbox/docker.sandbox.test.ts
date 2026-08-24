import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExportScript, parseExportOutput } from './docker.sandbox.js';

/**
 * Estos tests NO necesitan Docker: verifican las dos funciones puras de la
 * extraccion, que es donde vive el riesgo real.
 *
 * El riesgo no es "leer archivos" sino los nombres: espacios, comillas,
 * acentos, saltos de linea. Por eso ruta y contenido viajan en base64, y por
 * eso el parseo se puede probar sin container, sin bash y sin filesystem.
 */

/** Arma una linea igual a la que emite el script dentro del container. */
function linea(path: string, bytes: number, state: string, content?: Buffer | string) {
  const p64 = Buffer.from(path, 'utf8').toString('base64');
  const body =
    content === undefined
      ? ''
      : ' ' + (Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')).toString('base64');
  return `${p64} ${bytes} ${state}${body}`;
}

test('una ruta con espacios y comillas sobrevive al viaje', () => {
  const path = 'sub dir/archivo con "comillas" y \'simples\'.txt';
  const contenido = 'const x = "hola $USER";\n';

  const result = parseExportOutput(linea(path, 24, 'ok', contenido));

  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]!.path, path);
  assert.equal(result.files[0]!.content, contenido);
});

test('los acentos y el unicode no se corrompen', () => {
  const result = parseExportOutput(linea('ñandú-áéí.md', 10, 'ok', '# Café ☕\n'));

  assert.equal(result.files[0]!.path, 'ñandú-áéí.md');
  assert.equal(result.files[0]!.content, '# Café ☕\n');
});

test('un salto de linea en el nombre no parte la linea', () => {
  // Es el caso que rompe cualquier parseo por delimitador, y la razon de ser
  // del base64: en el transporte, el nombre es una sola palabra sin saltos.
  const path = 'archivo\ncon\nsaltos.txt';
  const result = parseExportOutput(linea(path, 3, 'ok', 'hi\n'));

  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]!.path, path);
});

test('un archivo binario se omite en vez de corromperse', () => {
  const binario = Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]);
  const result = parseExportOutput(linea('logo.png', 5, 'ok', binario));

  // Guardarlo como texto lo destruiria en silencio: el byte nulo y todo lo
  // que no sea UTF-8 valido se irian sin que nadie se entere.
  assert.equal(result.files.length, 0);
  assert.deepEqual(result.skipped, [{ path: 'logo.png', bytes: 5, reason: 'binary' }]);
});

test('lo omitido dice por que, y no desaparece', () => {
  const result = parseExportOutput(
    [
      linea('chico.txt', 4, 'ok', 'hola'),
      linea('enorme.bin', 900_000, 'too_large'),
      linea('tarde.txt', 12, 'budget'),
    ].join('\n'),
  );

  assert.deepEqual(
    result.files.map((f) => f.path),
    ['chico.txt'],
  );
  assert.deepEqual(result.skipped, [
    { path: 'enorme.bin', bytes: 900_000, reason: 'too_large' },
    { path: 'tarde.txt', bytes: 12, reason: 'budget' },
  ]);
  assert.equal(result.truncated, true, 'un PR incompleto tiene que decir que le falta');
});

test('un workspace vacio no es un error', () => {
  const result = parseExportOutput('');

  assert.deepEqual(result.files, []);
  assert.equal(result.truncated, false, 'nada omitido: el agente no escribio nada');
});

test('las lineas basura se ignoran en vez de tumbar la extraccion', () => {
  const result = parseExportOutput(
    ['', '   ', 'ruido-sin-estado', linea('ok.txt', 2, 'ok', 'ok')].join('\n'),
  );

  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]!.path, 'ok.txt');
});

test('el total cuenta solo lo que efectivamente viajo', () => {
  const result = parseExportOutput(
    [linea('a.txt', 10, 'ok', 'aaaaaaaaaa'), linea('b.bin', 999, 'too_large')].join('\n'),
  );

  assert.equal(result.totalBytes, 10);
});

test('los archivos vuelven ordenados por ruta', () => {
  const result = parseExportOutput(
    [linea('z.txt', 1, 'ok', 'z'), linea('a.txt', 1, 'ok', 'a')].join('\n'),
  );

  // El orden de `find` no es estable; el del artefacto si, para que dos
  // corridas de la misma tarea sean comparables.
  assert.deepEqual(
    result.files.map((f) => f.path),
    ['a.txt', 'z.txt'],
  );
});

// ─── El script ──────────────────────────────────────────────────────────────

test('poda por nombre de directorio, no por ruta', () => {
  const script = buildExportScript();

  // `-path './node_modules/*'` solo alcanzaria al de la raiz. Los anidados
  // (pkg/node_modules/) son justamente donde vive el peso.
  assert.match(script, /-name 'node_modules' -prune -o/);
  assert.doesNotMatch(script, /-path/);
});

test('los patrones de exclusion no pueden inyectar shell', () => {
  const script = buildExportScript({ exclude: ["evil' -o -exec rm -rf / ;"] });

  // Todo lo que no sea [A-Za-z0-9._-] se cae: la comilla nunca llega a
  // cerrarse, asi que el resto no puede convertirse en comandos.
  assert.doesNotMatch(script, /rm -rf/);
  const nombres = [...script.matchAll(/-name '([^']*)'/g)].map((m) => m[1]!);
  assert.deepEqual(nombres, ['evil-o-execrm-rf']);
  // Lo que queda puede parecerse a un predicado de find (`-exec`), pero es el
  // ARGUMENTO de -name: sin comilla ni espacio no hay forma de salir del
  // token.
  for (const nombre of nombres) {
    assert.match(nombre, /^[A-Za-z0-9._-]+$/, `"${nombre}" puede romper la comilla`);
  }
});

test('los techos viajan al shell, no se filtran despues', () => {
  const script = buildExportScript({ maxFileBytes: 1234, maxTotalBytes: 5678 });

  // Filtrar del lado de Node llegaria tarde: los megas ya habrian viajado por
  // el pipe y reventado el maxBuffer de execFile.
  assert.match(script, /-gt 1234/);
  assert.match(script, /-gt 5678/);
});
