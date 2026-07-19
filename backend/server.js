'use strict';
// 토지이용 AR — 건물/그룹 공유 저장소.
// 의존성 없는 Node HTTP 서버. 건물·그룹을 원자적 JSON 파일 하나에 저장해
// 모든 기기가 같은 목록을 보게 한다. ID는 서버가 발급(기기 간 충돌 방지),
// rev/ETag로 저렴한 폴링을 지원. 접근 제어 없음(공개) — 검증·상한으로만 보호.
//
//   PORT       리스닝 포트(기본 8080)
//   DATA_FILE  저장 파일 경로(기본 /data/store.json)
//   WRITE_KEY  설정 시 쓰기 요청에 X-Arcam-Key 헤더를 요구(기본 미설정=공개)

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_FILE = process.env.DATA_FILE || '/data/store.json';
const TMP_FILE = DATA_FILE + '.tmp';
const WRITE_KEY = process.env.WRITE_KEY || '';   // 비어 있으면 쓰기 공개

// 상한: 무한 증식/거대 페이로드 방지
const MAX_POINTS = 10000;
const MAX_GROUPS = 500;
const MAX_NAME = 80;
const MAX_BODY = 8 << 20;   // 8 MB — 수천 개 건물 이관(import)도 통과하도록 넉넉히
const PALETTE_OK = /^#[0-9a-fA-F]{6}$/;

// 사진 저장 경로·상한. 사진은 건물/그룹(store.json)과 완전히 분리해 저장한다.
const DATA_DIR = path.dirname(DATA_FILE);
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const PHOTO_INDEX = path.join(DATA_DIR, 'photos.json');
const MAX_PHOTOS = 5000;
const MAX_PHOTO_BYTES = 10 << 20;      // 원본 1장 최대 10MB
const MAX_THUMB_BYTES = 1 << 20;       // 썸네일 1장 최대 1MB
const MAX_PHOTO_UPLOAD = MAX_PHOTO_BYTES + MAX_THUMB_BYTES + (64 << 10);
const MAX_ZIP = 500;                   // 한 번에 압축할 사진 수 상한
const MAX_ZIP_BYTES = 3 * 1024 * 1024 * 1024;   // ~3GB — zip 32비트 오프셋 오버플로 방지

// ── 저장소(메모리 + 파일) ──
let store = { points: [], groups: [], seqPoint: 0, seqGroup: 0, rev: 1 };

function loadSync() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const j = JSON.parse(raw);
    store.points = Array.isArray(j.points) ? j.points : [];
    store.groups = Array.isArray(j.groups) ? j.groups : [];
    store.rev = Number.isFinite(j.rev) ? j.rev : 1;
    // seq는 기존 최대 id 이상으로 복구(누락/손상 대비)
    store.seqPoint = Math.max(j.seqPoint | 0, store.points.reduce((m, p) => Math.max(m, p.id | 0), 0));
    store.seqGroup = Math.max(j.seqGroup | 0, store.groups.reduce((m, g) => Math.max(m, g.id | 0), 0));
    console.log(`[store] loaded ${store.points.length} points, ${store.groups.length} groups (rev ${store.rev})`);
  } catch (e) {
    if (e.code === 'ENOENT') console.log('[store] no data file, starting empty');
    else console.error('[store] load failed, starting empty:', e.message);
  }
}

// 쓰기 직렬화 + 원자적·내구성 저장. 메모리 수정은 동기(단일 스레드)라 요청이 겹쳐도
// read-modify-write 중간에 await가 없어 유실이 없다. 저장은 tmp에 쓰고 fsync 후 rename해
// (a) 동시 리더가 반쪽 파일을 읽지 않고 (b) 전원 차단에도 확정된 쓰기가 남게 한다.
const BACKUP_DIR = path.join(path.dirname(DATA_FILE), 'backups');
const BACKUP_EVERY = 5 * 60 * 1000;   // 최대 5분에 1개
const BACKUP_KEEP = 40;               // 최근 40개 유지(공개 API의 오삭제/전체삭제 복구용)
let lastBackup = 0;

async function durableWrite(snapshot) {
  const fh = await fsp.open(TMP_FILE, 'w');
  try { await fh.writeFile(snapshot); await fh.sync(); } finally { await fh.close(); }
  await fsp.rename(TMP_FILE, DATA_FILE);
}
async function rotateBackup(snapshot) {
  const now = Date.now();
  if (now - lastBackup < BACKUP_EVERY) return;
  lastBackup = now;
  try {
    await fsp.mkdir(BACKUP_DIR, { recursive: true });
    await fsp.writeFile(path.join(BACKUP_DIR, 'store-' + now + '.json'), snapshot);
    const files = (await fsp.readdir(BACKUP_DIR)).filter((f) => f.indexOf('store-') === 0 && f.endsWith('.json')).sort();
    for (let i = 0; i < files.length - BACKUP_KEEP; i++) await fsp.unlink(path.join(BACKUP_DIR, files[i])).catch(() => {});
  } catch (e) { console.error('[store] backup failed:', e.message); }
}

let writeChain = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify(store);
  // 직렬화는 유지하되(writeChain), 실패는 호출자에게 그대로 전달해 성공(200) 오인을 막는다.
  const p = writeChain.then(() => durableWrite(snapshot)).then(() => rotateBackup(snapshot));
  writeChain = p.catch(() => {});   // 다음 쓰기를 위해 체인 자체는 살려 둔다
  return p;
}

// ── 사진 저장소(메타 색인 + 개별 JPEG 파일) ──
// 원본/썸네일 JPEG은 파일로(/data/photos/<id>.jpg, <id>.t.jpg), 메타데이터 색인만
// photos.json에 둔다. 이렇게 하면 건물 저장(잦은 원자적 재기록)이 대용량 이미지로
// 느려지거나 위험해지지 않는다. id는 서버가 발급(단조 증가, 재사용 없음).
let photos = { list: [], seq: 0, rev: 1 };   // list: [{ id, ts, w, h, bytes }]

function loadPhotosSync() {
  try {
    const j = JSON.parse(fs.readFileSync(PHOTO_INDEX, 'utf8'));
    photos.list = Array.isArray(j.list) ? j.list.filter((p) => p && Number.isFinite(p.id)) : [];
    photos.rev = Number.isFinite(j.rev) ? j.rev : 1;
    photos.seq = Math.max(j.seq | 0, photos.list.reduce((m, p) => Math.max(m, p.id | 0), 0));
    console.log(`[photos] loaded ${photos.list.length} photos (rev ${photos.rev})`);
  } catch (e) {
    if (e.code === 'ENOENT') console.log('[photos] no index, starting empty');
    else console.error('[photos] load failed, starting empty:', e.message);
  }
}

// 임의 파일을 원자적·내구성 있게 저장(tmp에 쓰고 fsync 후 rename). 사진 색인·JPEG 공용.
async function writeFileDurable(target, data) {
  const tmp = target + '.tmp';
  const fh = await fsp.open(tmp, 'w');
  try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
  await fsp.rename(tmp, target);
}

let photoChain = Promise.resolve();   // 색인 쓰기 직렬화(건물 store와 독립)
function persistPhotos() {
  const snap = JSON.stringify({ list: photos.list, seq: photos.seq, rev: photos.rev });
  const p = photoChain.then(() => writeFileDurable(PHOTO_INDEX, snap));
  photoChain = p.catch(() => {});
  return p;
}
function photoBump() { photos.rev++; }
function photoFile(id, thumb) { return path.join(PHOTO_DIR, id + (thumb ? '.t.jpg' : '.jpg')); }

function isJpeg(buf) { return buf && buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF; }
function validTs(v) {
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return (Number.isFinite(n) && n > 946684800000 && n < 4102444800000) ? n : Date.now();
}
function clampDim(v) { const n = parseInt(v, 10); return (Number.isFinite(n) && n > 0 && n < 20000) ? n : 0; }

// CRC32 + store-only ZIP(무압축) — 다중 사진 다운로드용. 외부 의존 없이 스트리밍한다.
// (JPEG은 이미 압축돼 있어 store 방식이면 CPU도 아끼고 구현도 단순하다.)
const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  return t;
})();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF]; return (c ^ -1) >>> 0; }
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function zipName(e) {
  const d = new Date(e.ts);
  return 'arcam-' + d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) +
    '-' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + '-' + e.id + '.jpg';
}
async function streamZip(res, entries) {
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename="arcam-photos.zip"',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  const write = (buf) => new Promise((ok, no) => { res.write(buf, (err) => err ? no(err) : ok()); });
  const central = [];
  let offset = 0;
  try {
    for (const e of entries) {
      let data;
      try { data = await fsp.readFile(photoFile(e.id, false)); } catch (_) { continue; }   // 색인엔 있으나 파일이 없으면 건너뜀
      const name = Buffer.from(zipName(e), 'utf8');
      const crc = crc32(data);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8);
      lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);                                    // 수정시각/날짜(0)
      lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
      await write(lh); await write(name); await write(data);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
      ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
      ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
      ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
      central.push({ ch, name });
      offset += 30 + name.length + data.length;
    }
    const cdStart = offset; let cdSize = 0;
    for (const c of central) { await write(c.ch); await write(c.name); cdSize += c.ch.length + c.name.length; }
    const eo = Buffer.alloc(22);
    eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(0, 4); eo.writeUInt16LE(0, 6);
    eo.writeUInt16LE(central.length, 8); eo.writeUInt16LE(central.length, 10);
    eo.writeUInt32LE(cdSize, 12); eo.writeUInt32LE(cdStart, 16); eo.writeUInt16LE(0, 20);
    await write(eo);
    res.end();
  } catch (e) {
    // 헤더가 이미 나갔으므로 정상 오류 응답이 불가 — 연결만 끊어 클라이언트가 불완전 zip을 감지하게 한다.
    try { res.destroy(); } catch (_) {}
  }
}

// ── 검증 헬퍼 ──
function cleanName(v, fallback) {
  if (typeof v !== 'string') return fallback;
  const s = v.trim().slice(0, MAX_NAME);
  return s || fallback;
}
function validLat(v) { return typeof v === 'number' && isFinite(v) && v >= -90 && v <= 90; }
function validLon(v) { return typeof v === 'number' && isFinite(v) && v >= -180 && v <= 180; }
function cleanColor(v, fallback) { return (typeof v === 'string' && PALETTE_OK.test(v)) ? v : fallback; }
function groupExists(id) { return id != null && store.groups.some((g) => g.id === id); }
function normGroupId(v) {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return groupExists(n) ? n : null;   // 없는 그룹 참조는 '그룹 없음'으로
}

// ── HTTP 유틸 ──
function send(res, code, obj, extraHeaders) {
  const body = obj == null ? '' : JSON.stringify(obj);
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  }, extraHeaders || {});
  res.writeHead(code, headers);
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    const fail = (msg, status) => { const e = new Error(msg); e.status = status; return e; };
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(fail('payload too large', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(fail('invalid json', 400)); }
    });
    req.on('error', reject);
  });
}
// 이진 응답(JPEG/ZIP). Content-Length를 명시해 프록시가 안전하게 스트리밍하도록 한다.
function sendBuf(res, code, buf, type, extraHeaders) {
  const headers = Object.assign({
    'Content-Type': type,
    'Content-Length': buf.length,
    'Access-Control-Allow-Origin': '*',
  }, extraHeaders || {});
  res.writeHead(code, headers);
  res.end(buf);
}
// 원시 바이트 본문(사진 업로드). cap 초과 시 즉시 413로 끊는다.
function readRaw(req, cap) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { const e = new Error('payload too large'); e.status = 413; reject(e); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function stateBody() { return { points: store.points, groups: store.groups, rev: store.rev }; }
function bump() { store.rev++; }

// ── 라우팅 ──
const server = http.createServer(async (req, res) => {
  const method = req.method;
  let u, pathname;
  try { u = new URL(req.url, 'http://x'); pathname = decodeURIComponent(u.pathname); }
  catch (e) { return send(res, 400, { error: 'bad url' }); }
  const parts = pathname.split('/').filter(Boolean);   // ['points','5']

  // CORS 예비요청
  if (method === 'OPTIONS') {
    return send(res, 204, null, {
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,If-None-Match,X-Arcam-Key,X-Thumb-Len',
      'Access-Control-Max-Age': '86400',
    });
  }

  // 헬스체크
  if (method === 'GET' && (pathname === '/health' || pathname === '/')) {
    return send(res, 200, { ok: true, points: store.points.length, groups: store.groups.length, rev: store.rev });
  }

  // 전체 상태(폴링). ETag로 변경 없으면 304.
  if (method === 'GET' && pathname === '/state') {
    const etag = '"' + store.rev + '"';
    if (req.headers['if-none-match'] === etag) return send(res, 304, null, { ETag: etag });
    return send(res, 200, stateBody(), { ETag: etag });
  }

  // 사진 목록(폴링). ETag로 변경 없으면 304. 최신순 정렬.
  if (method === 'GET' && pathname === '/photos') {
    const etag = '"p' + photos.rev + '"';
    if (req.headers['if-none-match'] === etag) return send(res, 304, null, { ETag: etag });
    const list = photos.list.slice().sort((a, b) => (b.ts - a.ts) || (b.id - a.id));
    return send(res, 200, { photos: list, rev: photos.rev }, { ETag: etag });
  }

  // 사진/썸네일 원본(JPEG) 서빙. id는 숫자만 허용 → 경로 조작 불가.
  if (method === 'GET' && parts[0] === 'photos' && parts.length >= 2 && /^\d+$/.test(parts[1])) {
    const id = parseInt(parts[1], 10);
    const thumb = parts[2] === 'thumb';
    if (parts.length > 2 && !thumb) return send(res, 404, { error: 'no route' });
    const meta = photos.list.find((p) => p.id === id);
    if (!meta) return send(res, 404, { error: 'not found' });
    const etag = '"' + (thumb ? 't' : 'f') + id + '"';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
    let buf;
    try { buf = await fsp.readFile(photoFile(id, thumb)); }
    catch (e) { return send(res, 404, { error: 'file gone' }); }
    // id 주소 = 내용 불변 → 오래 캐시. dl=1이면 다운로드(첨부)로 강제.
    const headers = { 'Cache-Control': 'private, max-age=31536000, immutable', 'ETag': etag };
    if (u.searchParams.get('dl')) headers['Content-Disposition'] = 'attachment; filename="' + zipName(meta) + '"';
    return sendBuf(res, 200, buf, 'image/jpeg', headers);
  }

  // 사진 zip 다운로드는 POST지만 변형이 아니므로 WRITE_KEY 게이트에서 제외한다.
  const isWrite = (method === 'POST' || method === 'PUT' || method === 'DELETE') &&
    !(method === 'POST' && pathname === '/photos/zip');
  if (isWrite && WRITE_KEY && req.headers['x-arcam-key'] !== WRITE_KEY) {
    return send(res, 403, { error: 'forbidden' });
  }

  try {
    // ── 건물 ──
    if (parts[0] === 'points') {
      // 전체 삭제
      if (method === 'POST' && parts[1] === 'clear') {
        store.points = []; bump(); await persist();
        return send(res, 200, { ok: true, rev: store.rev });
      }
      // 생성
      if (method === 'POST' && parts.length === 1) {
        const b = await readJson(req);
        if (!validLat(b.lat) || !validLon(b.lon)) return send(res, 400, { error: 'lat/lon required' });
        if (store.points.length >= MAX_POINTS) return send(res, 413, { error: 'too many points' });
        const id = ++store.seqPoint;
        const point = {
          id,
          name: cleanName(b.name, '건물 ' + id),
          lat: b.lat, lon: b.lon,
          groupId: normGroupId(b.groupId),
          color: cleanColor(b.color, '#a60739'),
        };
        store.points.push(point); bump(); await persist();
        return send(res, 200, { point, rev: store.rev });
      }
      // 수정 / 삭제 — 본문 읽기(await) 뒤에 인덱스를 구해, 조회~기록 사이에 await가 없게 한다.
      // (동시 DELETE/clear가 배열을 재색인해도 낡은 인덱스로 엉뚱한 슬롯을 덮지 않도록.)
      if (parts.length === 2) {
        const id = parseInt(parts[1], 10);
        if (method === 'PUT') {
          const b = await readJson(req);
          const idx = store.points.findIndex((p) => p.id === id);
          if (idx < 0) return send(res, 404, { error: 'not found' });
          const p = store.points[idx];
          const next = Object.assign({}, p);
          if (b.name !== undefined) next.name = cleanName(b.name, p.name);
          if (b.color !== undefined) next.color = cleanColor(b.color, p.color);
          if (b.groupId !== undefined) next.groupId = normGroupId(b.groupId);
          if (b.lat !== undefined) { if (!validLat(b.lat)) return send(res, 400, { error: 'bad lat' }); next.lat = b.lat; }
          if (b.lon !== undefined) { if (!validLon(b.lon)) return send(res, 400, { error: 'bad lon' }); next.lon = b.lon; }
          store.points[idx] = next; bump(); await persist();
          return send(res, 200, { point: next, rev: store.rev });
        }
        if (method === 'DELETE') {
          const idx = store.points.findIndex((p) => p.id === id);
          if (idx < 0) return send(res, 404, { error: 'not found' });
          store.points.splice(idx, 1); bump(); await persist();
          return send(res, 200, { ok: true, rev: store.rev });
        }
      }
    }

    // ── 그룹 ──
    if (parts[0] === 'groups') {
      if (method === 'POST' && parts.length === 1) {
        const b = await readJson(req);
        if (store.groups.length >= MAX_GROUPS) return send(res, 413, { error: 'too many groups' });
        const id = ++store.seqGroup;
        const group = { id, name: cleanName(b.name, '그룹 ' + id), color: cleanColor(b.color, '#a60739') };
        store.groups.push(group); bump(); await persist();
        return send(res, 200, { group, rev: store.rev });
      }
      if (parts.length === 2) {
        const id = parseInt(parts[1], 10);
        if (method === 'PUT') {
          const b = await readJson(req);
          const idx = store.groups.findIndex((g) => g.id === id);
          if (idx < 0) return send(res, 404, { error: 'not found' });
          const g = store.groups[idx];
          const next = Object.assign({}, g);
          if (b.name !== undefined) next.name = cleanName(b.name, g.name);
          if (b.color !== undefined) next.color = cleanColor(b.color, g.color);
          store.groups[idx] = next; bump(); await persist();
          return send(res, 200, { group: next, rev: store.rev });
        }
        if (method === 'DELETE') {
          const idx = store.groups.findIndex((g) => g.id === id);
          if (idx < 0) return send(res, 404, { error: 'not found' });
          store.groups.splice(idx, 1);
          // 삭제된 그룹의 건물은 '그룹 없음'으로 이동
          store.points = store.points.map((p) => p.groupId === id ? Object.assign({}, p, { groupId: null }) : p);
          bump(); await persist();
          return send(res, 200, { ok: true, rev: store.rev });
        }
      }
    }

    // ── 사진 ──
    if (parts[0] === 'photos') {
      // 다중 다운로드용 ZIP (POST지만 변형 아님 — 위 isWrite 게이트에서 제외됨)
      if (method === 'POST' && parts[1] === 'zip') {
        const b = await readJson(req);
        let sel;
        if (b && b.all) sel = photos.list.slice();
        else if (b && Array.isArray(b.ids)) {
          const set = new Set(b.ids.map((x) => parseInt(x, 10)));
          sel = photos.list.filter((p) => set.has(p.id));
        } else return send(res, 400, { error: 'ids or all required' });
        if (!sel.length) return send(res, 400, { error: 'no photos' });
        if (sel.length > MAX_ZIP) return send(res, 413, { error: 'too many (' + MAX_ZIP + ' max)' });
        // 총 용량 상한: zip 오프셋이 32비트라 4GB를 넘으면 스트림 중 오버플로로 깨진다. 미리 거절.
        const totalBytes = sel.reduce((s, p) => s + (p.bytes || 0), 0);
        if (totalBytes > MAX_ZIP_BYTES) return send(res, 413, { error: 'zip too large' });
        sel.sort((a, b2) => (b2.ts - a.ts) || (b2.id - a.id));
        return streamZip(res, sel);   // 자체적으로 헤더/본문을 쓰고 오류를 삼킨다(위 catch로 안 감)
      }
      // 업로드: 본문 = [썸네일 바이트][원본 바이트], 경계는 X-Thumb-Len 헤더.
      if (method === 'POST' && parts.length === 1) {
        const thumbLen = parseInt(req.headers['x-thumb-len'], 10);
        if (!Number.isFinite(thumbLen) || thumbLen <= 0 || thumbLen > MAX_THUMB_BYTES) return send(res, 400, { error: 'bad X-Thumb-Len' });
        const body = await readRaw(req, MAX_PHOTO_UPLOAD);
        if (thumbLen >= body.length) return send(res, 400, { error: 'thumb len exceeds body' });
        const thumb = body.subarray(0, thumbLen);
        const full = body.subarray(thumbLen);
        if (full.length > MAX_PHOTO_BYTES) return send(res, 413, { error: 'photo too large' });
        if (!isJpeg(thumb) || !isJpeg(full)) return send(res, 415, { error: 'jpeg required' });
        // 멱등: 같은 uid(클라 촬영 고유키)가 이미 있으면 재업로드로 보고 기존 항목을 그대로 반환한다.
        // (업로드 성공 응답을 클라가 못 받고 재부팅해 다시 올려도 사진이 중복되지 않게 — 리뷰 지적.)
        const uid = (u.searchParams.get('uid') || '').slice(0, 64);
        if (uid) { const dup = photos.list.find((p) => p.uid === uid); if (dup) return send(res, 200, { photo: dup, rev: photos.rev }); }
        if (photos.list.length >= MAX_PHOTOS) return send(res, 413, { error: 'too many photos' });
        // 파일을 먼저 쓰고(실패 시 색인에 안 넣음 → 색인은 항상 파일을 가리킴), 그다음 색인 반영.
        const id = ++photos.seq;
        await writeFileDurable(photoFile(id, false), full);
        try { await writeFileDurable(photoFile(id, true), thumb); }
        catch (e) { fsp.unlink(photoFile(id, false)).catch(() => {}); throw e; }   // 반쪽 파일 정리
        const entry = {
          id, ts: validTs(u.searchParams.get('ts')),
          w: clampDim(u.searchParams.get('w')), h: clampDim(u.searchParams.get('h')),
          bytes: full.length,
        };
        if (uid) entry.uid = uid;
        photos.list.push(entry); photoBump(); await persistPhotos();
        return send(res, 200, { photo: entry, rev: photos.rev });
      }
      // 삭제: 색인에서 먼저 제거(내구성 반영) 후 파일은 best-effort 삭제.
      if (method === 'DELETE' && parts.length === 2 && /^\d+$/.test(parts[1])) {
        const id = parseInt(parts[1], 10);
        const idx = photos.list.findIndex((p) => p.id === id);
        if (idx < 0) return send(res, 404, { error: 'not found' });
        photos.list.splice(idx, 1); photoBump(); await persistPhotos();
        fsp.unlink(photoFile(id, false)).catch(() => {});
        fsp.unlink(photoFile(id, true)).catch(() => {});
        return send(res, 200, { ok: true, rev: photos.rev });
      }
    }

    // ── 최초 마이그레이션: 서버가 비었을 때만 로컬 데이터 1회 업로드 ──
    if (method === 'POST' && pathname === '/import') {
      // 본문을 먼저 읽고(await), 그 다음 '비었나' 확인 → 채우기를 await 없이 한 번에 처리한다.
      // (확인을 await 앞에 두면 동시 요청 둘이 모두 통과해 중복 이관될 수 있음.)
      const b = await readJson(req);
      if (store.points.length || store.groups.length) {
        return send(res, 200, Object.assign({ imported: false }, stateBody()));
      }
      const inGroups = Array.isArray(b.groups) ? b.groups.slice(0, MAX_GROUPS) : [];
      const inPoints = Array.isArray(b.points) ? b.points.slice(0, MAX_POINTS) : [];
      const gmap = {};   // 예전 그룹 id → 새 서버 id
      inGroups.forEach((g) => {
        const id = ++store.seqGroup;
        if (g && g.id != null) gmap[g.id] = id;
        store.groups.push({ id, name: cleanName(g && g.name, '그룹 ' + id), color: cleanColor(g && g.color, '#a60739') });
      });
      inPoints.forEach((p) => {
        if (!p || !validLat(p.lat) || !validLon(p.lon)) return;
        const id = ++store.seqPoint;
        const oldG = p.groupId;
        const newG = (oldG != null && gmap[oldG] != null) ? gmap[oldG] : null;
        store.points.push({ id, name: cleanName(p.name, '건물 ' + id), lat: p.lat, lon: p.lon, groupId: newG, color: cleanColor(p.color, '#a60739') });
      });
      bump(); await persist();
      return send(res, 200, Object.assign({ imported: true }, stateBody()));
    }

    return send(res, 404, { error: 'no route' });
  } catch (e) {
    // 4xx는 명시적으로 태그된 것만(본문 오류). 디스크 쓰기 실패 등은 500으로.
    // (경로에 '.json'이 들어가 메시지 기반 분류가 오탐하던 문제 방지 — persist 실패를 400으로 오인.)
    const code = (e && e.status) || 500;
    return send(res, code, { error: (e && e.message) || 'error' });
  }
});

// 데이터 디렉터리 보장 후 기동
try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); } catch (e) {}
try { fs.mkdirSync(PHOTO_DIR, { recursive: true }); } catch (e) {}
loadSync();
loadPhotosSync();
server.listen(PORT, () => console.log(`[arcam-api] listening on ${PORT}, data=${DATA_FILE}, write=${WRITE_KEY ? 'key-protected' : 'open'}`));
