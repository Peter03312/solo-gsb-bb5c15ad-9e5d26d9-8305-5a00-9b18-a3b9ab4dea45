// Express 服务：REST API + 静态前端。
// 启动时自动建表；所有集合替换/发布均在 SQLite 事务中完成。

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openDb,
  loadData,
  currentHash,
  getDraft,
  saveDraft,
  listPublications,
  getPublication,
  insertPublication,
  getVerificationRow,
  getVerificationRowByPublication,
  createVerification,
  updateVerificationEntries,
  completeVerification,
  listVerificationRows,
  listReservationRows,
  getReservationRow,
  getReservationRowByBatch,
  listOverlappingActiveReservations,
  listActiveReservations,
  insertReservation,
  cancelReservation,
  listSuspensionRows,
  getSuspensionRow,
  listOverlappingActiveSuspensions,
  listActiveSuspensions,
  insertSuspension,
  revokeSuspension,
} from './db.js';
import { solve, verify, computeHash } from './solver.js';
import { normalizeEntries, measureProgress, verifyMeasurements } from './verify.js';
import {
  parseUtcMs,
  toIso,
  planUsage,
  checkCapacity,
  checkSuspension,
  buildSchedule,
} from './reserve.js';
import {
  ValidationError,
  ConflictError,
  validateConfig,
  validateTubes,
  validateWeights,
  validateExclusions,
  validateFixedSlots,
} from './validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // ---------- 状态 ----------

  app.get('/api/state', (req, res) => {
    const data = loadData(db);
    const hash = data ? computeHash(data) : null;
    const rawDraft = getDraft(db);
    let draft = null;
    if (rawDraft) {
      draft = {
        ...rawDraft,
        stale: hash === null || rawDraft.basisHash !== hash,
      };
    }
    const publications = listPublications(db).map((p) => ({
      ...p,
      usable: hash !== null && p.feasible && p.basisHash === hash,
    }));
    res.json({
      data,
      currentHash: hash,
      draft,
      publications,
      verifications: serializeVerifications(db, hash),
      reservations: listReservationRows(db).map((r) =>
        reservationView(r, hash, Date.now()),
      ),
      suspensions: listSuspensionRows(db).map((r) => suspensionView(r, Date.now())),
    });
  });

  // ---------- 转子配置（整体替换，事务） ----------

  app.put('/api/config', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const clean = validateConfig(body, current);
        db.prepare('DELETE FROM hole_max').run();
        db.prepare('DELETE FROM config').run();
        db.prepare('INSERT INTO config (id, hole_count, tolerance) VALUES (1, ?, ?)').run(
          clean.holes,
          clean.tolerance,
        );
        const ins = db.prepare('INSERT INTO hole_max (hole, max_mass) VALUES (?, ?)');
        clean.holeMaxMass.forEach((m, h) => ins.run(h, m));
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 离心管（整表替换，事务） ----------

  app.put('/api/tubes', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const N = current ? current.holes : null;
        const clean = validateTubes(body, N);
        // 替换离心管不得留下失效避邻对（对中管不再存在）：整次拒绝并保留原数据
        const ids = new Set(clean.map((t) => t.id));
        const dangling = (current ? current.exclusionPairs : []).filter(
          (p) => !ids.has(p.a) || !ids.has(p.b),
        );
        if (dangling.length > 0) {
          throw new ValidationError([
            '本次离心管替换会使现有避邻对失效（对中离心管不再存在），已拒绝并保留原数据：',
            ...dangling.map((p) => `避邻对「${p.a} ↔ ${p.b}」`),
            '请先解除相关避邻对，或保留对应离心管编号',
          ]);
        }
        // 替换离心管不得使现有固定孔位失效（管不再存在或孔位不再可用）：整次拒绝并保留原数据
        const newTubeMap = new Map(clean.map((t) => [t.id, t]));
        const brokenFixed = (current ? current.fixedSlots : []).filter((f) => {
          const t = newTubeMap.get(f.tube);
          return !t || !t.usableHoles.includes(f.hole);
        });
        if (brokenFixed.length > 0) {
          throw new ValidationError([
            '本次离心管替换会使现有固定孔位失效（管不再存在或孔位不再可用），已拒绝并保留原数据：',
            ...brokenFixed.map((f) => `固定孔位 ${f.hole}：离心管「${f.tube}」`),
            '请先解除相关固定孔位，或保留对应离心管编号与可用孔位',
          ]);
        }
        db.prepare('DELETE FROM tube_holes').run();
        db.prepare('DELETE FROM tubes').run();
        const insTube = db.prepare('INSERT INTO tubes (id, mass, ord) VALUES (?, ?, ?)');
        const insHole = db.prepare('INSERT INTO tube_holes (tube_id, hole) VALUES (?, ?)');
        clean.forEach((t, i) => {
          insTube.run(t.id, t.mass, i);
          for (const h of t.usableHoles) insHole.run(t.id, h);
        });
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 避邻对（整体替换，事务） ----------
  // 环形孔位中孔 i 与 (i+1) % N 相邻，同对两管不得相邻。
  // 未知编号、自配对、重复配对（含颠倒）任一出现即整次拒绝，不留下部分数据。

  app.get('/api/exclusions', (req, res) => {
    const data = loadData(db);
    res.json(data ? data.exclusionPairs : []);
  });

  app.put('/api/exclusions', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const clean = validateExclusions(body, current);
        db.prepare('DELETE FROM exclusion_pairs').run();
        const ins = db.prepare(
          'INSERT INTO exclusion_pairs (tube_a, tube_b, ord) VALUES (?, ?, ?)',
        );
        clean.forEach((p, i) => ins.run(p.a, p.b, i));
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 固定孔位（整体替换，事务） ----------
  // 实验人员预先摆好的离心管：按「管编号 + 孔位」整组保存/修改/清空。
  // 未知管、重复管或孔、越界孔、不在该管可用孔位内的绑定，任一出现即整组拒绝，
  // 不留下部分数据（原绑定保留）。

  app.get('/api/fixed-slots', (req, res) => {
    const data = loadData(db);
    res.json(data ? data.fixedSlots : []);
  });

  app.put('/api/fixed-slots', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const clean = validateFixedSlots(body, current);
        db.prepare('DELETE FROM fixed_slots').run();
        const ins = db.prepare(
          'INSERT INTO fixed_slots (tube_id, hole, ord) VALUES (?, ?, ?)',
        );
        clean.forEach((f, i) => ins.run(f.tube, f.hole, i));
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 配重块（整表替换，事务） ----------

  app.put('/api/weights', (req, res, next) => {
    try {
      const tx = db.transaction((body) => {
        const current = loadData(db);
        const N = current ? current.holes : null;
        const clean = validateWeights(body, N);
        db.prepare('DELETE FROM weights').run();
        const ins = db.prepare('INSERT INTO weights (mass, quantity) VALUES (?, ?)');
        clean.forEach((w) => ins.run(w.mass, w.quantity));
      });
      tx(req.body);
      res.json({ ok: true, currentHash: currentHash(db) });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 重算草稿 ----------

  app.post('/api/solve', (req, res, next) => {
    try {
      const data = loadData(db);
      if (!data) throw new ValidationError(['请先配置转子（孔位数、各孔最大质量、容差）']);
      const hash = computeHash(data);
      const result = solve(data);
      saveDraft(db, {
        basisHash: hash,
        feasible: result.feasible,
        reasons: result.feasible ? [] : result.reasons,
        result,
      });
      res.json({
        basisHash: hash,
        feasible: result.feasible,
        reasons: result.feasible ? [] : result.reasons,
        result,
      });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 发布：事务内重读当前数据 → 求解 → 独立复核 → 冻结 ----------

  app.post('/api/publish', (req, res, next) => {
    try {
      let pubId;
      const tx = db.transaction(() => {
        const data = loadData(db);
        if (!data) throw new ValidationError(['请先配置转子（孔位数、各孔最大质量、容差）']);
        const hash = computeHash(data);
        const result = solve(data);
        if (!result.feasible) {
          throw new ValidationError([
            '当前数据不存在可行装载图，无法发布：',
            ...result.reasons,
          ]);
        }
        // 独立复核：不信任求解器输出本身
        const check = verify(data, result.arrangement);
        if (!check.ok) {
          throw new Error(`发布前独立复核失败：${check.errors.join('；')}`);
        }
        pubId = insertPublication(db, {
          basisHash: hash,
          feasible: true,
          weightCount: check.weightCount,
          diffSum: check.diffSum,
          config: data,
          result,
          reasons: [],
        });
      });
      tx();
      res.status(201).json(getPublication(db, pubId));
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/publications', (req, res) => {
    const hash = currentHash(db);
    res.json(
      listPublications(db).map((p) => ({
        ...p,
        usable: hash !== null && p.feasible && p.basisHash === hash,
      })),
    );
  });

  app.get('/api/publications/:id', (req, res, next) => {
    const pub = getPublication(db, Number(req.params.id));
    if (!pub) return res.status(404).json({ error: '发布记录不存在' });
    const hash = currentHash(db);
    res.json({ ...pub, usable: pub.feasible && pub.basisHash === hash });
  });

  // ---------- 配重块时段预约 ----------
  //
  // 时段按左闭右开 [start, end) 计算；占用量按冻结装载图统计（各质量规格）。
  // 创建在单个事务内原子完成：重读冻结图、当前可选数量与重叠的生效中预约，
  // 任一时刻同规格预约总量不得超过当前录入数量；不足时返回冲突规格与时段，
  // 不产生任何部分占用。批次号为幂等键：同号同内容返回原记录（含已取消记录，
  // 不重新占用），同号不同内容拒绝。仅未开始的预约可取消，取消后历史保留。

  // 列表/详情视图：状态、阶段（相对当前时刻）、依据图当前可用性
  function reservationView(row, hash, nowMs) {
    const startMs = Date.parse(row.start_utc);
    const endMs = Date.parse(row.end_utc);
    const phase =
      row.status === 'cancelled'
        ? 'cancelled'
        : nowMs < startMs
          ? 'notStarted'
          : nowMs < endMs
            ? 'ongoing'
            : 'ended';
    return {
      id: row.id,
      batchNo: row.batch_no,
      publicationId: row.publication_id,
      startUtc: row.start_utc,
      endUtc: row.end_utc,
      usage: JSON.parse(row.usage_json),
      status: row.status,
      phase,
      cancellable: row.status === 'active' && nowMs < startMs,
      createdAt: row.created_at,
      cancelledAt: row.cancelled_at,
      publicationUsable:
        hash !== null &&
        !!row.pub_basis_hash &&
        row.pub_basis_hash === hash &&
        !!row.pub_feasible,
    };
  }

  app.post('/api/reservations', (req, res, next) => {
    try {
      const body = req.body || {};
      const errors = [];
      const batchNo = typeof body.batchNo === 'string' ? body.batchNo.trim() : '';
      if (!batchNo) errors.push('批次号不能为空');
      else if (batchNo.length > 100) errors.push('批次号过长（最多 100 字符）');
      const publicationId = Number(body.publicationId);
      if (!Number.isInteger(publicationId) || publicationId <= 0) {
        errors.push('publicationId 必须是发布记录编号（正整数）');
      }
      const startMs = parseUtcMs(body.startUtc);
      const endMs = parseUtcMs(body.endUtc);
      if (startMs === null) errors.push('开始时间不是合法的 UTC 时间（ISO 8601）');
      if (endMs === null) errors.push('结束时间不是合法的 UTC 时间（ISO 8601）');
      if (startMs !== null && endMs !== null && !(startMs < endMs)) {
        errors.push('开始时间必须早于结束时间（时段按左闭右开 [start, end) 计算）');
      }
      if (errors.length) throw new ValidationError(errors);

      const startUtc = toIso(startMs);
      const endUtc = toIso(endMs);

      let status = 201;
      let view;
      const tx = db.transaction(() => {
        // 幂等：同批次号重复提交——内容一致返回原记录（含已取消记录，不重新占用），
        // 内容不同拒绝。
        const existing = getReservationRowByBatch(db, batchNo);
        if (existing) {
          const same =
            existing.publication_id === publicationId &&
            existing.start_utc === startUtc &&
            existing.end_utc === endUtc;
          if (!same) {
            throw new ConflictError(
              [`批次号「${batchNo}」已被使用且预约内容不同，拒绝重复提交`],
              { existingId: existing.id },
            );
          }
          view = reservationView(existing, currentHash(db), Date.now());
          status = 200;
          return;
        }

        // 原子重读：冻结图、当前数量、重叠预约
        const pub = getPublication(db, publicationId);
        if (!pub) {
          throw new ValidationError([`发布记录 #${publicationId} 不存在（未知装载图）`]);
        }
        if (!pub.feasible) {
          throw new ValidationError([
            `发布记录 #${publicationId} 不含可行装载图，不能用于预约`,
          ]);
        }
        const hash = currentHash(db);
        if (hash === null || pub.basisHash !== hash) {
          throw new ValidationError([
            `发布记录 #${publicationId} 当前不可用于装载（录入数据已变化），请选择仍可用的发布记录`,
          ]);
        }
        const data = loadData(db);
        const capacityOf = (mass) => {
          const w = data.weights.find((x) => x.mass === mass);
          return w ? w.quantity : 0;
        };
        const usage = planUsage(pub);
        const overlapping = listOverlappingActiveReservations(db, startUtc, endUtc).map(
          (r) => ({
            startMs: Date.parse(r.start_utc),
            endMs: Date.parse(r.end_utc),
            usage: JSON.parse(r.usage_json),
          }),
        );
        // 同时核对当前库存、重叠的生效停用：占用 + 停用任一时刻不得超过当前数量。
        // 停用允许与既有预约重叠，既有预约不因此改写。
        const suspOverlap = listOverlappingActiveSuspensions(db, startUtc, endUtc).map(
          (sp) => ({
            startMs: Date.parse(sp.start_utc),
            endMs: Date.parse(sp.end_utc),
            mass: sp.mass,
            count: sp.quantity,
          }),
        );
        const check = checkCapacity({
          usage,
          capacityOf,
          overlapping,
          suspensions: suspOverlap,
          startMs,
          endMs,
        });
        if (!check.ok) {
          const errs = ['当前可用数量不足（预约占用 + 生效停用超出当前库存），预约未产生任何占用：'];
          for (const c of check.conflicts) {
            for (const w of c.windows) {
              errs.push(
                `规格 ${c.mass} g：${w.start} 至 ${w.end} 已预约占用 ${w.used} 枚、` +
                  `临时停用 ${w.suspended} 枚，本次需 ${c.required} 枚，` +
                  `合计超出当前库存 ${c.capacity} 枚`,
              );
            }
          }
          throw new ConflictError(errs, { detail: { conflicts: check.conflicts } });
        }
        const row = insertReservation(db, {
          batchNo,
          publicationId,
          startUtc,
          endUtc,
          usage,
        });
        view = reservationView(row, hash, Date.now());
      });
      tx();
      res.status(status).json(view);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/reservations', (req, res) => {
    const hash = currentHash(db);
    const nowMs = Date.now();
    res.json(listReservationRows(db).map((r) => reservationView(r, hash, nowMs)));
  });

  app.get('/api/reservations/:id', (req, res, next) => {
    const row = getReservationRow(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: '预约记录不存在' });
    res.json(reservationView(row, currentHash(db), Date.now()));
  });

  // 取消：仅未开始的预约可取消；已取消的预约幂等返回原记录（历史保留）
  app.post('/api/reservations/:id/cancel', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existed = getReservationRow(db, id);
      if (!existed) return res.status(404).json({ error: '预约记录不存在' });
      let view;
      const tx = db.transaction(() => {
        const row = getReservationRow(db, id);
        if (row.status === 'cancelled') {
          view = reservationView(row, currentHash(db), Date.now());
          return;
        }
        const nowMs = Date.now();
        if (nowMs >= Date.parse(row.start_utc)) {
          throw new ConflictError([
            `预约 #${id} 已开始（${row.start_utc}），仅未开始的预约可取消`,
          ]);
        }
        const updated = cancelReservation(db, id, toIso(nowMs));
        if (!updated) throw new ConflictError([`预约 #${id} 状态已变化，请刷新后重试`]);
        view = reservationView(updated, currentHash(db), nowMs);
      });
      tx();
      res.json(view);
    } catch (e) {
      next(e);
    }
  });

  // 预约日程：各质量规格在 [from, to) 内的分段占用/停用与「不足」区段。
  // segments.shortage 仅表示预约占用超过当前录入数量（字段含义不变）；
  // 另展示停用量（suspendedSegments）与「占用+停用」合计不足区段（combinedSegments）。
  // 既有预约/停用不因数量减少或图失效被改写。
  app.get('/api/schedule', (req, res, next) => {
    try {
      const active = listActiveReservations(db).map((r) => ({
        startMs: Date.parse(r.start_utc),
        endMs: Date.parse(r.end_utc),
        usage: JSON.parse(r.usage_json),
      }));
      const suspensions = listActiveSuspensions(db).map((sp) => ({
        startMs: Date.parse(sp.start_utc),
        endMs: Date.parse(sp.end_utc),
        mass: sp.mass,
        count: sp.quantity,
      }));
      const fromMs = parseUtcMs(req.query.from);
      const toMs = parseUtcMs(req.query.to);
      if (req.query.from !== undefined && fromMs === null) {
        throw new ValidationError(['from 不是合法的 UTC 时间（ISO 8601）']);
      }
      if (req.query.to !== undefined && toMs === null) {
        throw new ValidationError(['to 不是合法的 UTC 时间（ISO 8601）']);
      }
      const horizon = [
        ...active.map((r) => [r.startMs, r.endMs]),
        ...suspensions.map((sp) => [sp.startMs, sp.endMs]),
      ];
      const from =
        fromMs !== null
          ? fromMs
          : horizon.length
            ? Math.min(...horizon.map(([a]) => a))
            : Date.now();
      const to =
        toMs !== null
          ? toMs
          : horizon.length
            ? Math.max(...horizon.map(([, b]) => b))
            : from;
      if (!(from < to)) {
        if (from === to && horizon.length === 0) {
          return res.json({ from: toIso(from), to: toIso(to), specs: [] });
        }
        throw new ValidationError(['from 必须早于 to（时段按左闭右开 [from, to) 计算）']);
      }
      const data = loadData(db);
      const capacityOf = (mass) => {
        const w = data && data.weights.find((x) => x.mass === mass);
        return w ? w.quantity : 0;
      };
      const massSet = new Set();
      if (data) for (const w of data.weights) massSet.add(w.mass);
      for (const r of active) for (const u of r.usage) massSet.add(u.mass);
      for (const sp of suspensions) massSet.add(sp.mass);
      const specs = buildSchedule({
        reservations: active,
        suspensions,
        masses: [...massSet].sort((a, b) => a - b),
        capacityOf,
        fromMs: from,
        toMs: to,
      });
      res.json({ from: toIso(from), to: toIso(to), specs });
    } catch (e) {
      next(e);
    }
  });

  // ---------- 配重块临时停用 ----------
  //
  // 按质量规格登记停用数量、原因与 UTC 起止时间（左闭右开 [start, end)）。
  // 同规格重叠停用量累加；登记在单个事务内重读当前库存与重叠的生效停用，
  // 任一时刻停用量不得超过登记时该规格当前数量（停用可与既有预约重叠，
  // 既有预约不改写）。登记后即影响新预约：预约事务同时核对库存、停用与已有预约。
  // 仅未开始的停用可撤销，撤销留历史且释放后续容量。

  function suspensionView(row, nowMs) {
    const startMs = Date.parse(row.start_utc);
    const endMs = Date.parse(row.end_utc);
    const phase =
      row.status === 'revoked'
        ? 'revoked'
        : nowMs < startMs
          ? 'notStarted'
          : nowMs < endMs
            ? 'ongoing'
            : 'ended';
    return {
      id: row.id,
      mass: row.mass,
      quantity: row.quantity,
      reason: row.reason,
      startUtc: row.start_utc,
      endUtc: row.end_utc,
      status: row.status,
      phase,
      revocable: row.status === 'active' && nowMs < startMs,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
    };
  }

  // 登记停用：非法时间/数量/未知规格 → 400；超量停用 → 409（附冲突规格与时段），
  // 任何失败均在事务内回滚，不留下记录。
  app.post('/api/suspensions', (req, res, next) => {
    try {
      const body = req.body || {};
      const errors = [];

      const mass = body.mass;
      if (typeof mass !== 'number' || !Number.isFinite(mass) || mass <= 0) {
        errors.push('mass 必须是有限正数（配重块质量规格，单位 g）');
      }
      const quantity = body.quantity;
      if (!Number.isInteger(quantity) || quantity <= 0) {
        errors.push('停用数量必须是正整数');
      }
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (!reason) errors.push('停用原因不能为空');
      else if (reason.length > 200) errors.push('停用原因过长（最多 200 字符）');

      const startMs = parseUtcMs(body.startUtc);
      const endMs = parseUtcMs(body.endUtc);
      if (startMs === null) errors.push('开始时间不是合法的 UTC 时间（ISO 8601）');
      if (endMs === null) errors.push('结束时间不是合法的 UTC 时间（ISO 8601）');
      if (startMs !== null && endMs !== null && !(startMs < endMs)) {
        errors.push('开始时间必须早于结束时间（时段按左闭右开 [start, end) 计算）');
      }
      if (errors.length) throw new ValidationError(errors);

      const startUtc = toIso(startMs);
      const endUtc = toIso(endMs);

      let view;
      const tx = db.transaction(() => {
        // 原子重读：当前库存（未知规格按当前录入判定）与重叠的生效停用
        const data = loadData(db);
        const spec = data && data.weights.find((w) => w.mass === mass);
        if (!spec) {
          throw new ValidationError([
            `未知质量规格 ${mass} g：当前配重块录入中不存在该规格，不能登记停用`,
          ]);
        }
        const overlapping = listOverlappingActiveSuspensions(db, startUtc, endUtc).map(
          (sp) => ({
            startMs: Date.parse(sp.start_utc),
            endMs: Date.parse(sp.end_utc),
            mass: sp.mass,
            count: sp.quantity,
          }),
        );
        const result = checkSuspension({
          mass,
          quantity,
          capacity: spec.quantity,
          overlapping,
          startMs,
          endMs,
        });
        if (!result.ok) {
          const c = result.conflict;
          const errs = ['停用量超出该规格当前数量，停用未登记：'];
          for (const w of c.windows) {
            errs.push(
              `规格 ${c.mass} g：${w.start} 至 ${w.end} 已停用 ${w.suspended} 枚，` +
                `本次再停用 ${c.required} 枚，超出当前库存 ${c.capacity} 枚`,
            );
          }
          throw new ConflictError(errs, { detail: { conflicts: [c] } });
        }
        const row = insertSuspension(db, {
          mass,
          quantity,
          reason,
          startUtc,
          endUtc,
        });
        view = suspensionView(row, Date.now());
      });
      tx();
      res.status(201).json(view);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/suspensions', (req, res) => {
    const nowMs = Date.now();
    res.json(listSuspensionRows(db).map((r) => suspensionView(r, nowMs)));
  });

  app.get('/api/suspensions/:id', (req, res) => {
    const row = getSuspensionRow(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: '停用记录不存在' });
    res.json(suspensionView(row, Date.now()));
  });

  // 撤销：仅未开始的生效停用可撤销；已撤销幂等返回原记录（历史保留）；
  // 已开始/已结束 409。撤销立即释放后续容量（新预约可见）。
  app.post('/api/suspensions/:id/revoke', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existed = getSuspensionRow(db, id);
      if (!existed) return res.status(404).json({ error: '停用记录不存在' });
      let view;
      const tx = db.transaction(() => {
        const row = getSuspensionRow(db, id);
        if (row.status === 'revoked') {
          view = suspensionView(row, Date.now());
          return;
        }
        const nowMs = Date.now();
        if (nowMs >= Date.parse(row.start_utc)) {
          throw new ConflictError([
            `停用 #${id} 已开始（${row.start_utc}），仅未开始的停用可撤销`,
          ]);
        }
        const updated = revokeSuspension(db, id, toIso(nowMs));
        if (!updated) throw new ConflictError([`停用 #${id} 状态已变化，请刷新后重试`]);
        view = suspensionView(updated, nowMs);
      });
      tx();
      res.json(view);
    } catch (e) {
      next(e);
    }
  });

  // ---------- 现场装载核验 ----------
  //
  // 流程：POST 选择可用发布记录建立草稿（同一发布记录只保留一份）→
  //       PUT 按孔位暂存实际物件编号/实测质量（携带 version 乐观锁，可反复暂存恢复）→
  //       POST .../complete 在单事务内重读发布快照与当前数据做最终判定。
  // 完成后结果冻结：重复完成不产生第二份结果，后续 PUT 被拒绝。

  // 列表项：进度 + 完成状态 + 发布记录当前可用性
  function verificationSummary(row, hash) {
    const pub = getPublication(db, row.publication_id);
    const entries = JSON.parse(row.entries_json);
    const progress = measureProgress(
      { config: pub.config, result: pub.result },
      entries,
    );
    const completed = !!row.completed_at;
    return {
      id: row.id,
      publicationId: row.publication_id,
      version: row.version,
      completed,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      progress,
      usable: hash !== null && !!row.pub_basis_hash && row.pub_basis_hash === hash,
      ...(completed
        ? { diffSum: row.diff_sum, massSum: row.mass_sum }
        : {}),
    };
  }

  function serializeVerifications(dbArg, hash) {
    return listVerificationRows(dbArg).map((row) => verificationSummary(row, hash));
  }

  // 详情（草稿或完成均返回；完成时附冻结的判定明细与冻结实测值）
  function verificationDetail(row) {
    const pub = getPublication(db, row.publication_id);
    const hash = currentHash(db);
    const entries = JSON.parse(row.entries_json);
    const completed = !!row.completed_at;
    const progress = measureProgress(
      { config: pub.config, result: pub.result },
      entries,
    );
    const detail = {
      id: row.id,
      publicationId: row.publication_id,
      version: row.version,
      completed,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      progress,
      usable: hash !== null && pub.feasible && pub.basisHash === hash,
      publication: {
        id: pub.id,
        createdAt: pub.createdAt,
        basisHash: pub.basisHash,
        config: pub.config,
        result: pub.result,
      },
      // 草稿阶段为当前暂存录入；完成后即为冻结实测值
      entries,
    };
    if (completed) {
      detail.diffSum = row.diff_sum;
      detail.massSum = row.mass_sum;
      detail.checks = JSON.parse(row.checks_json);
      detail.frozenEntries = JSON.parse(row.result_json);
    }
    return detail;
  }

  // 建立核验草稿：仅允许针对「当前仍可用」的可行发布记录
  app.post('/api/verifications', (req, res, next) => {
    try {
      const publicationId = Number(req.body && req.body.publicationId);
      if (!Number.isInteger(publicationId)) {
        throw new ValidationError(['publicationId 必须是发布记录编号（整数）']);
      }
      let detail;
      const tx = db.transaction(() => {
        const pub = getPublication(db, publicationId);
        if (!pub) throw new ValidationError(['发布记录不存在']);
        if (!pub.feasible) {
          throw new ValidationError([`发布记录 #${publicationId} 不含可行装载图，无法核验`]);
        }
        const hash = currentHash(db);
        if (hash === null || pub.basisHash !== hash) {
          throw new ValidationError([
            `发布记录 #${publicationId} 当前不可用于装载（录入数据已变化），请选择仍可用的发布记录`,
          ]);
        }
        const existing = getVerificationRowByPublication(db, publicationId);
        if (existing) {
          throw new ConflictError(
            [
              existing.completed_at
                ? `发布记录 #${publicationId} 的核验已完成（结果已冻结），不能再建草稿`
                : `发布记录 #${publicationId} 已存在未完成核验，请直接恢复该草稿`,
            ],
            { existingId: existing.id, completed: !!existing.completed_at },
          );
        }
        const N = pub.config.holes;
        const emptyEntries = Array.from({ length: N }, (_, h) => ({
          hole: h,
          ref: '',
          mass: 0,
        }));
        const row = createVerification(db, publicationId, emptyEntries);
        detail = verificationDetail(row);
      });
      tx();
      res.status(201).json(detail);
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/verifications', (req, res) => {
    res.json(serializeVerifications(db, currentHash(db)));
  });

  app.get('/api/verifications/:id', (req, res, next) => {
    const row = getVerificationRow(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: '核验记录不存在' });
    res.json(verificationDetail(row));
  });

  // 暂存：整表替换孔位录入；version 不匹配（他人已改）→ 409，拒绝覆盖
  app.put('/api/verifications/:id', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const row0 = getVerificationRow(db, id);
      if (!row0) return res.status(404).json({ error: '核验记录不存在' });
      if (row0.completed_at) {
        throw new ConflictError(['核验已完成，实测值与判定结果已冻结，不能再修改']);
      }
      const expectedVersion = req.body && req.body.version;
      if (!Number.isInteger(expectedVersion)) {
        throw new ValidationError(['更新核验必须携带整数 version（用于防止覆盖他人修改）']);
      }
      if (expectedVersion !== row0.version) {
        throw new ConflictError(
          [`核验数据已被他人更新（当前版本 ${row0.version}），请先恢复最新草稿再提交`],
          { currentVersion: row0.version },
        );
      }
      const pub = getPublication(db, row0.publication_id);
      const { errors, entries } = normalizeEntries(req.body && req.body.entries, pub.config.holes);
      if (errors.length) throw new ValidationError(errors);

      const row = updateVerificationEntries(db, id, expectedVersion, entries);
      if (!row) {
        // 并发情况下版本/状态已被其他事务抢先改变
        const fresh = getVerificationRow(db, id);
        throw new ConflictError(
          [fresh && fresh.completed_at ? '核验刚被完成并冻结' : '核验版本已变化，请恢复最新草稿后再提交'],
          { currentVersion: fresh ? fresh.version : null },
        );
      }
      res.json(verificationDetail(row));
    } catch (e) {
      next(e);
    }
  });

  // 完成核验：同一事务内重读发布快照与当前数据并独立判定
  app.post('/api/verifications/:id/complete', (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const existed = getVerificationRow(db, id);
      if (!existed) return res.status(404).json({ error: '核验记录不存在' });

      let status = 200;
      let detail;
      const tx = db.transaction(() => {
        const row = getVerificationRow(db, id);

        // 幂等：重复完成不产生第二份结果，直接返回冻结结果
        if (row.completed_at) {
          detail = verificationDetail(row);
          status = 200;
          return;
        }

        const pub = getPublication(db, row.publication_id);
        if (!pub || !pub.feasible) {
          throw new ValidationError([
            `发布记录 #${row.publication_id} 不含可行冻结装载图，无法完成核验`,
          ]);
        }
        // 发布记录仍可用于当前装载？
        const hash = currentHash(db);
        if (hash === null || pub.basisHash !== hash) {
          throw new ValidationError([
            `发布记录 #${pub.id} 已不可用于当前装载（录入数据已变化），核验不能完成；草稿已保留`,
          ]);
        }

        // 重读当前暂存录入并做结构规整（不合法也保留草稿）
        const entries = JSON.parse(row.entries_json);
        const N = pub.config.holes;
        if (!Array.isArray(entries) || entries.length !== N) {
          throw new ValidationError(['暂存的核验录入与冻结图孔位数不符，草稿已保留']);
        }
        for (const e of entries) {
          const m = e && e.mass;
          const hasRef = e && typeof e.ref === 'string' && e.ref !== '';
          if (
            !e ||
            typeof m !== 'number' ||
            !Number.isFinite(m) ||
            (hasRef ? !(m > 0) : m !== 0)
          ) {
            throw new ValidationError([
              `孔 ${e ? e.hole : '?'} 录入不完整或质量非法：有物件时质量须为有限正数，空孔质量须为 0`,
            ]);
          }
        }

        // 独立判定：物件一致性、孔承重、对径容差（全部定位到孔位/孔对）
        const verdict = verifyMeasurements(
          { config: pub.config, result: pub.result },
          entries,
        );
        if (!verdict.ok) {
          throw new ValidationError(
            ['核验不通过，草稿已保留、未生成完成记录：', ...verdict.errors],
            { checks: verdict.checks, version: row.version },
          );
        }

        const updated = completeVerification(db, id, {
          checks: verdict.checks,
          diffSum: verdict.diffSum,
          massSum: verdict.massSum,
        });
        if (!updated) throw new Error('核验完成写入失败');
        detail = verificationDetail(updated);
        status = 201;
      });
      tx();
      res.status(status).json(detail);
    } catch (e) {
      next(e);
    }
  });

  // ---------- 静态前端 ----------

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---------- 错误处理 ----------

  app.use((err, req, res, next) => {
    if (err instanceof ValidationError) {
      return res
        .status(400)
        .json({ error: err.message, errors: err.errors, ...(err.detail ? { detail: err.detail } : {}) });
    }
    if (err instanceof ConflictError) {
      return res.status(409).json({
        error: err.message,
        errors: err.errors,
        ...(err.existingId != null ? { existingId: err.existingId } : {}),
        ...(err.completed != null ? { completed: err.completed } : {}),
        ...(err.currentVersion != null ? { currentVersion: err.currentVersion } : {}),
        ...(err.detail ? { detail: err.detail } : {}),
      });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: '请求体不是合法 JSON', errors: ['请求体不是合法 JSON'] });
    }
    console.error(err);
    res.status(500).json({ error: '服务器内部错误', errors: [String(err && err.message)] });
  });

  return app;
}

function start() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'rotor.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  const app = createApp(db);
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '0.0.0.0';
  app.listen(port, host, () => {
    console.log(`离心转子配平服务已启动: http://localhost:${port}  (数据库: ${dbPath})`);
  });
}

// 仅在直接运行时监听端口（测试中 import 不触发）
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  start();
}
