import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createApp } from '../src/server.js';
import { normalizeRunStart, normalizeOutcome, evaluateRunStart, isTimedOut } from '../src/runs.js';

let baseUrl;
let server;
let db;

// 可注入时钟：服务端记录的开始/结束时间与“当前时刻”一律来自 nowMs
let nowMs = Date.parse('2030-06-01T10:00:00Z');
const clock = () => nowMs;

before(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const { SCHEMA } = await import('../src/db.js');
  db.exec(SCHEMA);
  const app = createApp(db, { now: clock });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function call(method, p, body) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  return { status: res.status, json };
}

// 4 孔、容差 0.5：管 A=50 在孔 0，对径孔 2 放 50 g 配重 → 每张图占用 50 g × 1
const cfg = { holes: 4, tolerance: 0.5, holeMaxMass: [100, 100, 100, 100] };

async function publishNew(weightsQty) {
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [{ id: 'A', mass: 50, usableHoles: [0, 1, 2, 3] }]);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: weightsQty }]);
  const pub = await call('POST', '/api/publish');
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  return pub.json;
}

// 对发布图建立核验 → 按冻结图精确录入 → 完成核验（通过并冻结）
async function verifiedFor(pubId) {
  const v0 = await call('POST', '/api/verifications', { publicationId: pubId });
  assert.equal(v0.status, 201, JSON.stringify(v0.json));
  const pub = (await call('GET', `/api/publications/${pubId}`)).json;
  const entries = pub.result.arrangement.map((slot, hole) =>
    slot ? { hole, ref: slot.ref, mass: slot.mass } : { hole, ref: '', mass: 0 },
  );
  const saved = await call('PUT', `/api/verifications/${v0.json.id}`, { version: 1, entries });
  assert.equal(saved.status, 200, JSON.stringify(saved.json));
  const done = await call('POST', `/api/verifications/${v0.json.id}/complete`);
  assert.equal(done.status, 201, JSON.stringify(done.json));
  return v0.json.id;
}

async function reserve(batchNo, publicationId, start, end) {
  const r = await call('POST', '/api/reservations', {
    batchNo,
    publicationId,
    startUtc: start,
    endUtc: end,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}

const T = (s) => `2030-06-01T${s}:00.000Z`;
let pub1;
let pub2;
let ver1;
let ver2;
let res1; // 10:00–12:00
let res2; // 10:00–12:00（同图同时段，库存 2）
let res3; // 14:00–16:00

test('准备：发布两张可用图、完成两份核验、建立三条预约', async () => {
  pub1 = await publishNew(2);
  pub2 = await publishNew(2); // 同数据再发布：两张图都可用
  ver1 = await verifiedFor(pub1.id);
  ver2 = await verifiedFor(pub2.id);
  res1 = await reserve('RUN-B1', pub1.id, T('10:00'), T('12:00'));
  res2 = await reserve('RUN-B2', pub2.id, T('10:00'), T('12:00'));
  res3 = await reserve('RUN-B3', pub1.id, T('14:00'), T('16:00'));
});

test('非法输入 → 400：空运行编号/空设备编号/非法编号', async () => {
  let r = await call('POST', '/api/runs', {
    runNo: '  ',
    deviceId: 'DEV',
    verificationId: ver1,
    reservationId: res1,
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('运行编号'));

  r = await call('POST', '/api/runs', {
    runNo: 'R-X',
    deviceId: '',
    verificationId: ver1,
    reservationId: res1,
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('设备编号'));

  r = await call('POST', '/api/runs', {
    runNo: 'R-X',
    deviceId: 'DEV',
    verificationId: -1,
    reservationId: res1,
  });
  assert.equal(r.status, 400);
  r = await call('POST', '/api/runs', {
    runNo: 'R-X',
    deviceId: 'DEV',
    verificationId: ver1,
    reservationId: 'x',
  });
  assert.equal(r.status, 400);
});

test('核验不存在 / 预约不存在 → 400', async () => {
  let r = await call('POST', '/api/runs', {
    runNo: 'R-NO-VER',
    deviceId: 'DEV',
    verificationId: 99999,
    reservationId: res1,
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('核验记录不存在'));

  r = await call('POST', '/api/runs', {
    runNo: 'R-NO-RES',
    deviceId: 'DEV',
    verificationId: ver1,
    reservationId: 99999,
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('预约记录不存在'));
});

test('核验与预约指向不同发布图 → 400（指出冲突）', async () => {
  // ver2 指向 pub2，res1 指向 pub1
  const r = await call('POST', '/api/runs', {
    runNo: 'R-MISMATCH',
    deviceId: 'DEV',
    verificationId: ver2,
    reservationId: res1,
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('同一条发布图'));
});

test('当前时刻不在预约左闭右开时段 → 409，detail.conflicts 定位 outsideWindow，不留记录', async () => {
  nowMs = Date.parse('2030-06-01T09:59:59.999Z');
  let r = await call('POST', '/api/runs', {
    runNo: 'R-EARLY',
    deviceId: 'DEV',
    verificationId: ver1,
    reservationId: res1,
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.detail.conflicts[0].type, 'outsideWindow');

  // 终点右开：now == end 已在窗外
  nowMs = Date.parse('2030-06-01T12:00:00.000Z');
  r = await call('POST', '/api/runs', {
    runNo: 'R-LATE',
    deviceId: 'DEV',
    verificationId: ver1,
    reservationId: res1,
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.detail.conflicts[0].type, 'outsideWindow');

  // 失败不留记录：列表为空
  const list = await call('GET', '/api/runs');
  assert.equal(list.json.length, 0);
});

test('窗口边界：start 闭区间可开始；成功开始冻结三份快照', async () => {
  nowMs = Date.parse('2030-06-01T10:00:00.000Z');
  const r = await call('POST', '/api/runs', {
    runNo: 'RUN-01',
    deviceId: 'CENT-A',
    verificationId: ver1,
    reservationId: res1,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.startUtc, T('10:00'));
  assert.equal(r.json.status, 'running');
  assert.equal(r.json.endUtc, null);
  assert.equal(r.json.timedOut, null);
  assert.equal(r.json.publicationUsable, true);
  assert.equal(r.json.frozenBasis.publication.id, pub1.id);
  assert.equal(r.json.frozenBasis.verification.id, ver1);
  assert.equal(r.json.frozenBasis.verification.completed, true);
  assert.equal(r.json.frozenBasis.reservation.id, res1);
  assert.equal(r.json.frozenBasis.reservation.endUtc, T('12:00'));
  assert.ok(Array.isArray(r.json.frozenBasis.publication.result.arrangement));
  assert.ok(r.json.frozenBasis.verification.checks.holes.length === 4);
});

test('同设备进行中运行 → 409（deviceBusy），不留记录', async () => {
  const r = await call('POST', '/api/runs', {
    runNo: 'RUN-02',
    deviceId: 'CENT-A',
    verificationId: ver2,
    reservationId: res2,
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.detail.conflicts[0].type, 'deviceBusy');
  const list = await call('GET', '/api/runs');
  assert.equal(list.json.length, 1);
});

test('同一预约不能用于第二次运行（预约终生一次）→ 409 reservationUsed', async () => {
  // 不同设备、窗口内；res1 已被 RUN-01 使用
  const r = await call('POST', '/api/runs', {
    runNo: 'RUN-03',
    deviceId: 'CENT-B',
    verificationId: ver1,
    reservationId: res1,
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.detail.conflicts[0].type, 'reservationUsed');
});

test('同运行编号同开始内容重复提交 → 200 返回原记录（幂等）', async () => {
  const r = await call('POST', '/api/runs', {
    runNo: 'RUN-01',
    deviceId: 'CENT-A',
    verificationId: ver1,
    reservationId: res1,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.id, 1);
  assert.equal(r.json.startUtc, T('10:00'));
  const list = await call('GET', '/api/runs');
  assert.equal(list.json.length, 1);
});

test('同运行编号异内容重复提交 → 409（existingId），不产生新记录', async () => {
  const r = await call('POST', '/api/runs', {
    runNo: 'RUN-01',
    deviceId: 'CENT-X',
    verificationId: ver1,
    reservationId: res1,
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.existingId, 1);
  const list = await call('GET', '/api/runs');
  assert.equal(list.json.length, 1);
});

test('完结：非法 outcome → 400；同状态重复返回原结果，异状态拒绝', async () => {
  let r = await call('POST', '/api/runs/1/complete', { outcome: 'paused' });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('outcome'));

  nowMs = Date.parse('2030-06-01T11:00:00.000Z');
  r = await call('POST', '/api/runs/1/complete', { outcome: 'completed' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.outcome, 'completed');
  assert.equal(r.json.timedOut, false);
  assert.equal(r.json.status, 'finished');
  assert.ok(r.json.endUtc > r.json.startUtc);

  // 同状态幂等
  nowMs = Date.parse('2030-06-01T11:30:00.000Z');
  r = await call('POST', '/api/runs/1/complete', { outcome: 'completed' });
  assert.equal(r.status, 200);
  assert.equal(r.json.endUtc, T('11:00')); // 返回原结果，不刷新结束时间

  // 异状态拒绝
  r = await call('POST', '/api/runs/1/complete', { outcome: 'aborted' });
  assert.equal(r.status, 409);
  assert.equal(r.json.existingOutcome, 'completed');
});

test('完结释放设备：原设备可立即开始新运行（新预约）', async () => {
  const r = await call('POST', '/api/runs', {
    runNo: 'RUN-04',
    deviceId: 'CENT-A',
    verificationId: ver2,
    reservationId: res2,
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.deviceId, 'CENT-A');
});

test('超过预约终点完结：如实完结并标记 timedOut（end == 预约终点即超时）', async () => {
  nowMs = Date.parse('2030-06-01T12:00:00.000Z');
  let r = await call('POST', '/api/runs/2/complete', { outcome: 'completed' });
  assert.equal(r.status, 201);
  assert.equal(r.json.timedOut, true);
  assert.equal(r.json.endUtc, T('12:00'));
  assert.equal(r.json.status, 'finished');

  // 之后仍可幂等返回带超时标记的原结果
  r = await call('POST', '/api/runs/2/complete', { outcome: 'completed' });
  assert.equal(r.status, 200);
  assert.equal(r.json.timedOut, true);
});

test('已完结预约仍不能再次用于运行；已取消预约不能开始运行（400）', async () => {
  nowMs = Date.parse('2030-06-01T11:00:00.000Z');
  // res2 已被 RUN-04 使用并完结——预约已用是终生的
  let r = await call('POST', '/api/runs', {
    runNo: 'RUN-05',
    deviceId: 'CENT-C',
    verificationId: ver2,
    reservationId: res2,
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.detail.conflicts[0].type, 'reservationUsed');
  assert.equal(r.json.detail.conflicts[0].open, false);

  // 取消 res3（未开始可取消），再用于运行 → 400
  const cancel = await call('POST', `/api/reservations/${res3}/cancel`);
  assert.equal(cancel.status, 200);
  r = await call('POST', '/api/runs', {
    runNo: 'RUN-06',
    deviceId: 'CENT-C',
    verificationId: ver1,
    reservationId: res3,
  });
  assert.equal(r.status, 400);
  assert.ok(r.json.errors.join(' ').includes('已取消'));
});

test('完结不改写预约：运行结束后预约仍 active 且时段不变', async () => {
  const r = await call('GET', `/api/reservations/${res1}`);
  assert.equal(r.json.status, 'active');
  assert.equal(r.json.startUtc, T('10:00'));
  assert.equal(r.json.endUtc, T('12:00'));
});

test('中止完结：aborted 正常冻结并释放设备', async () => {
  // res3 已取消不能用；新建一条预约（库存已因 RUN-01/RUN-04 结束而释放——
  // 但预约占用与运行无关，新建同时段预约会因两条 active 预约（res1/res2）满库存失败，
  // 故使用 14:00 之后的新时段）
  const res4 = await reserve('RUN-B4', pub1.id, T('16:00'), T('18:00'));
  nowMs = Date.parse('2030-06-01T16:05:00.000Z');
  const r = await call('POST', '/api/runs', {
    runNo: 'RUN-07',
    deviceId: 'CENT-D',
    verificationId: ver1,
    reservationId: res4,
  });
  assert.equal(r.status, 201);
  nowMs = Date.parse('2030-06-01T16:20:00.000Z');
  const fin = await call('POST', `/api/runs/${r.json.id}/complete`, { outcome: 'aborted' });
  assert.equal(fin.status, 201);
  assert.equal(fin.json.outcome, 'aborted');
  assert.equal(fin.json.timedOut, false);
});

test('依据图失效后：历史运行不改写（快照保留），仅当前可用性标记变化；新运行被拒', async () => {
  // 修改配置 → pub1/pub2 当前不可用；frozenBasis 仍是当时快照
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [{ id: 'A', mass: 51, usableHoles: [0, 1, 2, 3] }]);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 2 }]);

  const detail = await call('GET', '/api/runs/1');
  assert.equal(detail.status, 200);
  assert.equal(detail.json.publicationUsable, false);
  // 冻结快照内容未被改写
  assert.equal(detail.json.frozenBasis.publication.result.arrangement[0].mass, 50);
  assert.equal(detail.json.frozenBasis.verification.basisHash, pub1.basisHash);
  assert.equal(detail.json.frozenBasis.reservation.batchNo, 'RUN-B1');
  assert.equal(detail.json.outcome, 'completed');
  assert.equal(detail.json.timedOut, false);

  // /api/state 中含运行列表（RUN-01 / RUN-04 / RUN-07 共 3 条；RUN-08 被拒不留记录）
  const st = await call('GET', '/api/state');
  assert.ok(Array.isArray(st.json.runs));
  assert.equal(st.json.runs.length, 3);
  assert.equal(st.json.runs.find((x) => x.runNo === 'RUN-01').publicationUsable, false);

  // 依据图不可用时不能再开始新运行（400）：
  // 先恢复数据，新建一条未被使用过的预约，再让 pub1 失效后发起运行。
  await call('PUT', '/api/config', cfg);
  await call('PUT', '/api/tubes', [{ id: 'A', mass: 50, usableHoles: [0, 1, 2, 3] }]);
  await call('PUT', '/api/weights', [{ mass: 50, quantity: 2 }]);
  const res5 = await reserve('RUN-B5', pub1.id, T('20:00'), T('22:00'));
  await call('PUT', '/api/tubes', [{ id: 'A', mass: 52, usableHoles: [0, 1, 2, 3] }]);
  nowMs = Date.parse('2030-06-01T20:10:00.000Z');
  const blocked = await call('POST', '/api/runs', {
    runNo: 'RUN-08',
    deviceId: 'CENT-E',
    verificationId: ver1,
    reservationId: res5,
  });
  assert.equal(blocked.status, 400);
  assert.ok(blocked.json.errors.join(' ').includes('不可用于装载'));
});

test('GET 不存在 → 404；状态聚合含超时标记', async () => {
  const r = await call('GET', '/api/runs/9999');
  assert.equal(r.status, 404);
  const timedOutRun = (await call('GET', '/api/runs/2')).json;
  assert.equal(timedOutRun.timedOut, true);
  assert.equal(timedOutRun.outcome, 'completed');
});

test('纯函数：normalizeRunStart / normalizeOutcome / evaluateRunStart / isTimedOut', () => {
  assert.equal(normalizeRunStart({}).errors.length >= 2, true);
  assert.equal(
    normalizeRunStart({ runNo: 'R', deviceId: 'D', verificationId: 1, reservationId: 2 }).errors
      .length,
    0,
  );
  assert.equal(normalizeOutcome({ outcome: 'completed' }).outcome, 'completed');
  assert.equal(normalizeOutcome({ outcome: 'x' }).errors.length, 1);

  const now = Date.parse('2030-06-01T11:00:00Z');
  // 未完成核验
  let v = evaluateRunStart({
    verification: { id: 1, publication_id: 7, completed_at: null },
    reservation: { id: 2, publication_id: 7, status: 'active', start_utc: T('10:00'), end_utc: T('12:00') },
    publication: { id: 7, feasible: true, basisHash: 'h' },
    currentHash: 'h',
    nowMs: now,
    runByReservation: null,
    openRunByDevice: null,
    deviceId: 'D',
  });
  assert.equal(v.precondition.length, 1);

  // 全部满足
  v = evaluateRunStart({
    verification: { id: 1, publication_id: 7, completed_at: T('09:00') },
    reservation: { id: 2, publication_id: 7, status: 'active', start_utc: T('10:00'), end_utc: T('12:00') },
    publication: { id: 7, feasible: true, basisHash: 'h' },
    currentHash: 'h',
    nowMs: now,
    runByReservation: null,
    openRunByDevice: null,
    deviceId: 'D',
  });
  assert.deepEqual(v.precondition, []);
  assert.deepEqual(v.conflicts, []);

  // 三类冲突同时给出
  v = evaluateRunStart({
    verification: { id: 1, publication_id: 7, completed_at: T('09:00') },
    reservation: { id: 2, publication_id: 7, status: 'active', start_utc: T('10:00'), end_utc: T('12:00') },
    publication: { id: 7, feasible: true, basisHash: 'h' },
    currentHash: 'h',
    nowMs: Date.parse('2030-06-01T13:00:00Z'),
    runByReservation: { id: 5, run_no: 'OLD', end_utc: null },
    openRunByDevice: { id: 6, run_no: 'BUSY' },
    deviceId: 'D',
  });
  assert.deepEqual(
    v.conflicts.map((c) => c.type),
    ['outsideWindow', 'reservationUsed', 'deviceBusy'],
  );

  // 左闭右开超时判定
  assert.equal(isTimedOut(Date.parse(T('12:00')), Date.parse(T('12:00'))), true);
  assert.equal(isTimedOut(Date.parse(T('11:59:59.999')), Date.parse(T('12:00'))), false);
});
