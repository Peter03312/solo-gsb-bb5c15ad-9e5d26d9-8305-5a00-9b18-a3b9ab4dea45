// 离心运行（纯函数 + 输入规整，无数据库依赖，便于测试）。
//
// 开始一次运行须由调用方在单个数据库事务内重读全部依据后调用 evaluateRunStart：
//   1) 核验存在且已完成（核验通过才会置完成标记）；
//   2) 核验与生效预约指向同一条发布图；
//   3) 该发布图当前仍可用于装载（冻结数据指纹与当前录入一致）；
//   4) 当前服务端时刻处于预约左闭右开时段 [start, end)；
//   5) 该预约未被其他运行使用（一个预约终生至多一次运行）；
//   6) 同一设备没有进行中（未完结）运行。
// 前 3 项属于引用/依据本身不成立（precondition，HTTP 400）；
// 后 3 项属于与当前状态冲突（conflicts，HTTP 409，附冲突定位）。
//
// 开始即冻结发布图、核验结论与预约时段三份快照；完结时由服务端记录结束时间，
// 结束时间晚于开始、结束时刻不早于预约终点（[start,end) 语义：end 已在窗外）
// 即标记超时。完结后任何配置、库存或预约状态变化都不改写运行历史。

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

// ---------- 开始请求规整 ----------
//
// 输入：{ runNo, deviceId, verificationId, reservationId }
// runNo / deviceId 为非空字符串（trim 后比较）；编号为正整数。
export function normalizeRunStart(input) {
  const errors = [];
  if (input === null || typeof input !== 'object') {
    return { errors: ['请求体必须是对象'], value: null };
  }
  const runNo = typeof input.runNo === 'string' ? input.runNo.trim() : '';
  if (!runNo) errors.push('运行编号（runNo）不能为空');
  else if (runNo.length > 100) errors.push('运行编号过长（最多 100 字符）');

  const deviceId = typeof input.deviceId === 'string' ? input.deviceId.trim() : '';
  if (!deviceId) errors.push('设备编号（deviceId）不能为空');
  else if (deviceId.length > 100) errors.push('设备编号过长（最多 100 字符）');

  const verificationId = Number(input.verificationId);
  if (!isInt(verificationId) || verificationId <= 0) {
    errors.push('verificationId 必须是已完成核验的编号（正整数）');
  }
  const reservationId = Number(input.reservationId);
  if (!isInt(reservationId) || reservationId <= 0) {
    errors.push('reservationId 必须是生效预约的编号（正整数）');
  }

  return {
    errors,
    value: errors.length
      ? null
      : { runNo, deviceId, verificationId, reservationId },
  };
}

// ---------- 完结请求规整：outcome ∈ completed | aborted ----------
export function normalizeOutcome(input) {
  const errors = [];
  if (input === null || typeof input !== 'object') {
    return { errors: ['请求体必须是对象，形如 {"outcome":"completed"}'], outcome: null };
  }
  const outcome = input.outcome;
  if (outcome !== 'completed' && outcome !== 'aborted') {
    errors.push('outcome 必须是 "completed"（完成）或 "aborted"（中止）');
  }
  return { errors, outcome: errors.length ? null : outcome };
}

// ---------- 开始前判定（事务内重读后调用） ----------
//
// 入参：
//   verification      verifications 行（null 表示未知核验）
//   reservation       reservations 行（null 表示未知预约）
//   publication       getPublication() 的冻结发布记录（null 表示未知图）
//   currentHash       当前录入数据指纹（loadData 为 null 时为 null）
//   nowMs             服务端当前时刻（毫秒）
//   runByReservation  引用该预约的任意运行行（含已完结；null 表示未被使用）
//   openRunByDevice   同设备进行中运行行（null 表示设备空闲）
//   deviceId          本次请求的设备编号
// 返回：
//   { precondition: string[],
//     conflicts: [{ type, ...定位字段 }] }
//   precondition 非空时调用方应回 400；否则 conflicts 非空回 409。
export function evaluateRunStart({
  verification,
  reservation,
  publication,
  currentHash,
  nowMs,
  runByReservation,
  openRunByDevice,
  deviceId,
}) {
  const precondition = [];

  if (!verification) {
    precondition.push('核验记录不存在：请先用已通过的现场装载核验编号发起运行');
  } else if (!verification.completed_at) {
    precondition.push(
      `核验 #${verification.id} 尚未完成核验：仅已通过核验的记录可用于开始运行`,
    );
  }

  if (!reservation) {
    precondition.push('预约记录不存在：请先用生效中的配重块预约编号发起运行');
  } else if (reservation.status === 'cancelled') {
    precondition.push(`预约 #${reservation.id}（批次号「${reservation.batch_no}」）已取消，不能用于开始运行`);
  }

  // 核验与预约须指向同一条发布图
  if (verification && reservation && verification.publication_id !== reservation.publication_id) {
    precondition.push(
      `核验 #${verification.id} 指向发布图 #${verification.publication_id}，` +
        `而预约 #${reservation.id} 指向发布图 #${reservation.publication_id}：` +
        '核验与预约必须指向同一条发布图',
    );
  }

  // 发布图当前可用（须为可行图且数据指纹与当前录入一致）
  if (verification && reservation && verification.publication_id === reservation.publication_id) {
    if (!publication) {
      precondition.push(
        `发布记录 #${verification.publication_id} 不存在，无法开始运行`,
      );
    } else if (!publication.feasible) {
      precondition.push(
        `发布记录 #${publication.id} 不含可行装载图，不能用于开始运行`,
      );
    } else if (currentHash === null || publication.basisHash !== currentHash) {
      precondition.push(
        `发布记录 #${publication.id} 当前不可用于装载（录入配置已变化），` +
          '请重新发布并完成核验后再开始运行',
      );
    }
  }

  const conflicts = [];

  // 当前时刻处于预约左闭右开时段 [start, end)
  if (reservation && reservation.status !== 'cancelled') {
    const startMs = Date.parse(reservation.start_utc);
    const endMs = Date.parse(reservation.end_utc);
    if (nowMs < startMs || nowMs >= endMs) {
      conflicts.push({
        type: 'outsideWindow',
        reservationId: reservation.id,
        now: new Date(nowMs).toISOString(),
        start: reservation.start_utc,
        end: reservation.end_utc,
      });
    }
  }

  // 该预约未用于其他运行（一个预约终生至多一次运行，含已完结运行）
  if (runByReservation) {
    conflicts.push({
      type: 'reservationUsed',
      runId: runByReservation.id,
      runNo: runByReservation.run_no,
      open: !runByReservation.end_utc,
    });
  }

  // 同设备无进行中运行
  if (openRunByDevice) {
    conflicts.push({
      type: 'deviceBusy',
      deviceId,
      runId: openRunByDevice.id,
      runNo: openRunByDevice.run_no,
    });
  }

  return { precondition, conflicts };
}

// ---------- 超时判定 ----------
// 左闭右开 [start, end)：结束时刻等于预约终点时已在窗外 → 超时。
export function isTimedOut(endMs, reservationEndMs) {
  return endMs >= reservationEndMs;
}

// ---------- 冻结快照（开始时构造，此后不再变化） ----------

export function buildPublicationSnapshot(pub) {
  return {
    id: pub.id,
    createdAt: pub.createdAt,
    basisHash: pub.basisHash,
    feasible: pub.feasible,
    weightCount: pub.weightCount,
    diffSum: pub.diffSum,
    config: pub.config,
    result: pub.result,
  };
}

export function buildVerificationSnapshot(row, pub) {
  const completed = !!row.completed_at;
  return {
    id: row.id,
    publicationId: row.publication_id,
    completed,
    completedAt: row.completed_at,
    diffSum: row.diff_sum,
    massSum: row.mass_sum,
    checks: completed && row.checks_json ? JSON.parse(row.checks_json) : null,
    frozenEntries: completed && row.result_json ? JSON.parse(row.result_json) : null,
    // 冻结时的图可用性依据（数据指纹与当时发布图）
    basisHash: pub.basisHash,
  };
}

export function buildReservationSnapshot(row) {
  return {
    id: row.id,
    batchNo: row.batch_no,
    publicationId: row.publication_id,
    startUtc: row.start_utc,
    endUtc: row.end_utc,
    usage: JSON.parse(row.usage_json),
    statusAtStart: row.status,
  };
}
