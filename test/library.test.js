// Biblioteca com dois PCs na mesma pasta (Google Drive) e a pasta de trabalho local do modo streaming
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

// A Library usa só o shell.trashItem do Electron
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') return { shell: { trashItem: async (p) => fs.rmSync(p, { recursive: true, force: true }) } };
  return origLoad.call(this, req, ...rest);
};
const { Library } = require('../src/main/library');
Module._load = origLoad;

function setup(rootName = 'lib') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meetrec-lib-'));
  const root = path.join(tmp, rootName);
  const libs = [];
  const make = (id, name) => {
    const st = new EventEmitter();
    const d = { storageDir: root, machineId: id, machineName: name };
    st.get = (k) => (k ? d[k] : d);
    const lib = new Library(st, { workRoot: path.join(tmp, `work-${id}`) });
    libs.push(lib);
    return lib;
  };
  const done = () => { libs.forEach((l) => l.close()); fs.rmSync(tmp, { recursive: true, force: true }); };
  return { tmp, root, make, done };
}

const readMeta = (root, id) => JSON.parse(fs.readFileSync(path.join(root, id, 'meta.json'), 'utf8'));

test('dois PCs: dono da gravação, edição cruzada e liberação', () => {
  const { root, make, done } = setup();
  try {
    const A = make('A', 'DESKTOP'), B = make('B', 'NOTEBOOK');
    const m = A.create({});
    A.isLive = (id) => id === m.id;
    B.refresh();
    assert.equal(B.ownerOf(m.id).name, 'DESKTOP');
    assert.equal(A.ownerOf(m.id), null);
    B.recoverInterrupted();
    assert.equal(B.get(m.id).status, 'recording', 'B não interrompe a gravação do A');

    B.update(m.id, { title: 'Renomeada no note' });
    assert.equal(B.get(m.id).busyBy.id, 'A', 'editar no B não muda o dono');
    A.update(m.id, (x) => { x.markers = [...(x.markers || []), { t: 5 }]; return x; });
    assert.equal(readMeta(root, m.id).title, 'Renomeada no note', 'A parte da versão do disco');

    A.update(m.id, { status: 'recorded' });
    B.refresh();
    assert.equal(B.ownerOf(m.id), null);

    B.update(m.id, { status: 'processing' });
    const meta = readMeta(root, m.id);
    meta.busyAt = new Date(Date.now() - 11 * 60e3).toISOString();
    fs.writeFileSync(path.join(root, m.id, 'meta.json'), JSON.stringify(meta));
    A.refresh();
    assert.equal(A.ownerOf(m.id).stale, true);
    A.release(m.id);
    assert.equal(A.get(m.id).status, 'error');
    assert.match(A.get(m.id).error, /NOTEBOOK/);
  } finally { done(); }
});

test('dois PCs: arquivos que chegam depois, conflitos do Drive, pastas e presença', async () => {
  const { root, make, done } = setup();
  try {
    const A = make('A', 'DESKTOP'), B = make('B', 'NOTEBOOK');
    const m = A.create({ status: 'ready' });
    B.refresh();
    const ev = [];
    B.on('changed', (x) => ev.push(x));
    fs.writeFileSync(path.join(root, m.id, 'summary.md'), '# resumo');
    B.refresh();
    assert.ok(ev.length, 'nota quando só o summary.md chega');

    const cur = readMeta(root, m.id);
    fs.writeFileSync(path.join(root, m.id, 'meta (1).json'), JSON.stringify({ ...cur, updatedAt: '2000-01-01', markers: [{ t: 99, label: 'do outro' }] }));
    fs.mkdirSync(path.join(root, `${m.id} (1)`));
    fs.writeFileSync(path.join(root, `${m.id} (1)`, 'meta.json'), '{}');
    B.refresh();
    assert.deepEqual(B.get(m.id).markers.map((x) => x.t), [99]);
    assert.equal(fs.existsSync(path.join(root, m.id, 'meta (1).json')), false);
    assert.equal(B.list().length, 1, 'pasta "(1)" do Drive é ignorada');

    A.createFolder('Profit');
    A.updateFolder('Profit', { description: 'cliente' });
    B.refresh();
    assert.equal(B.getFolder('Profit').description, 'cliente');

    A.setPresence(m.id);
    assert.deepEqual(B.openElsewhere(m.id), [{ name: 'DESKTOP' }]);
    A.setPresence(null);
    assert.deepEqual(B.openElsewhere(m.id), []);

    await A.remove(m.id);
    B.refresh();
    assert.equal(B.get(m.id), null);
  } finally { done(); }
});

test('streaming: grava na pasta local e só publica o resultado no Drive', async () => {
  const { tmp, root, make, done } = setup(path.join('Google Drive', 'MeetRec - Reuniões'));
  try {
    const A = make('A', 'DESKTOP');
    assert.equal(A.isCloud(), true);
    const m = A.create({});
    const work = A.workDir(m.id);
    assert.ok(work.startsWith(path.join(tmp, 'work-A')), 'pasta de trabalho fora do Drive');
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(A.workFile(m.id, 'mix.webm'), 'x'.repeat(5000));
    fs.writeFileSync(A.workFile(m.id, 'mix.16k.wav'), 'temp');
    assert.equal(fs.existsSync(A.file(m.id, 'mix.webm')), false, 'nada vai ao Drive durante a gravação');

    // App fechou no meio da gravação: ao abrir, o áudio local vai para a biblioteca
    const ids = A.recoverInterrupted();
    assert.deepEqual(ids, [m.id]);
    assert.equal(fs.readFileSync(A.file(m.id, 'mix.webm'), 'utf8').length, 5000);
    assert.equal(fs.existsSync(A.file(m.id, 'mix.16k.wav')), false, 'temporários não vão ao Drive');
    assert.equal(fs.existsSync(work), false);

    // Outro PC processando: baixa do Drive para a pasta local, com progresso
    const B = make('B', 'NOTEBOOK');
    const prog = [];
    const local = await B.toLocal(m.id, 'mix.webm', (p) => prog.push(p));
    assert.ok(local.startsWith(path.join(tmp, 'work-B')));
    assert.equal(fs.statSync(local).size, 5000);
    assert.equal(prog.at(-1), 1);
    assert.equal(await B.toLocal(m.id, 'mix.webm'), local, 'não baixa de novo');
    fs.writeFileSync(local, 'y'.repeat(4000));
    B.publish(m.id, 'mix.webm');
    assert.equal(fs.statSync(B.file(m.id, 'mix.webm')).size, 4000);
    B.clearWork(m.id);
    assert.equal(fs.existsSync(B.workDir(m.id)), false);
  } finally { done(); }
});

test('pasta local (sem nuvem): tudo continua na pasta da reunião', async () => {
  const { root, make, done } = setup();
  try {
    const A = make('A', 'DESKTOP');
    const m = A.create({ status: 'recorded' });
    assert.equal(A.isCloud(), false);
    assert.equal(A.workDir(m.id), path.join(root, m.id));
    fs.writeFileSync(A.file(m.id, 'mix.webm'), 'abc');
    assert.equal(await A.toLocal(m.id, 'mix.webm'), A.file(m.id, 'mix.webm'));
    A.clearWork(m.id);
    assert.ok(fs.existsSync(A.file(m.id, 'mix.webm')), 'clearWork não apaga nada fora da nuvem');
  } finally { done(); }
});
