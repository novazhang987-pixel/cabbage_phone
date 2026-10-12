/* 手机版的数据层。
 *
 * 思路：界面代码（app.js）一行都不用改。它照样去请求 /api/xxx，
 * 只是这些请求在这里被拦下来，用浏览器自己的存储（localStorage）就地处理。
 * 所以这一层等于把后端的接口在浏览器里重新实现了一遍：
 * 增删改查、筛选排序、临期分级、消耗流水、周报月报、回收站、导入导出、中英对照。
 *
 * 数据存在这台手机的浏览器里，不上传、不联网也能用。
 * 存储格式和后端导出的 JSON 完全一致，所以电脑版和手机版可以用「导出/导入」互相搬数据。
 */

(function () {
  "use strict";

  const STORE_KEY = "food-keeper-db-v1";
  const EXPIRING_SOON_DAYS = 3;
  const EXPIRING_WARN_DAYS = 7;

  const DEFAULT_CATEGORIES = ["蔬菜", "水果", "肉类", "水产", "蛋奶", "豆制品", "主食", "调料", "冷冻食品", "零食", "饮料", "其他"];
  const DEFAULT_LOCATIONS = ["冷藏", "冷冻", "常温", "橱柜", "阳台"];
  const DEFAULT_UNITS = ["个", "斤", "克", "千克", "包", "袋", "盒", "瓶", "罐", "把", "块", "条", "根", "升", "毫升"];
  const STATUS_LABELS = { active: "在用", used_up: "已用完", discarded: "已丢弃" };
  const ACTION_LABELS = { use: "用掉", discard: "丢弃", restock: "补货", adjust: "调整" };

  /* ---------------- 中英对照（和 app/i18n.py 一致） ---------------- */

  const CATEGORY_EN = { 蔬菜: "Vegetables", 水果: "Fruits", 肉类: "Meat", 水产: "Seafood", 蛋奶: "Eggs & Dairy", 豆制品: "Soy Products", 主食: "Staples", 调料: "Seasoning", 冷冻食品: "Frozen Food", 零食: "Snacks", 饮料: "Drinks", 其他: "Other" };
  const LOCATION_EN = { 冷藏: "Fridge", 冷冻: "Freezer", 常温: "Room temp", 橱柜: "Pantry", 阳台: "Balcony" };
  const UNIT_EN = { 个: "pcs", 斤: "jin (500g)", 克: "g", 千克: "kg", 包: "pack", 袋: "bag", 盒: "box", 瓶: "bottle", 罐: "can", 把: "bunch", 块: "piece", 条: "strip", 根: "root", 升: "L", 毫升: "mL" };
  const STATUS_EN = { active: "In stock", used_up: "Used up", discarded: "Discarded" };
  const ACTION_EN = { use: "Used", discard: "Discarded", restock: "Restocked", adjust: "Adjusted" };
  const EXPIRY_LEVEL_EN = { expired: "Expired", soon: "Use soon", warn: "This week", fresh: "Fresh" };

  const CSV_HEADERS = {
    zh: {
      ingredients: ["id", "名称", "分类", "数量", "单位", "购买日期", "保质期天数", "到期日", "剩余天数", "存放位置", "状态", "备注", "在回收站"],
      logs: ["时间", "食材", "动作", "数量", "单位", "库存变化", "备注"],
      shopping: ["名称", "数量", "单位", "分类", "已买", "备注"],
    },
    en: {
      ingredients: ["id", "Name", "Category", "Quantity", "Unit", "Purchased", "Shelf life (days)", "Expiry date", "Days left", "Location", "Status", "Note", "In trash"],
      logs: ["Time", "Ingredient", "Action", "Quantity", "Unit", "Stock change", "Note"],
      shopping: ["Name", "Quantity", "Unit", "Category", "Bought", "Note"],
    },
  };

  const identity = (values) => Object.fromEntries(values.map((v) => [v, v]));

  function i18nMaps(lang) {
    if (lang === "en") {
      return {
        categories: { ...CATEGORY_EN }, locations: { ...LOCATION_EN }, units: { ...UNIT_EN },
        statuses: { ...STATUS_EN }, actions: { ...ACTION_EN }, expiry_levels: { ...EXPIRY_LEVEL_EN },
      };
    }
    return {
      categories: identity(DEFAULT_CATEGORIES), locations: identity(DEFAULT_LOCATIONS),
      units: identity(DEFAULT_UNITS), statuses: identity(Object.values(STATUS_LABELS)),
      actions: identity(Object.values(ACTION_LABELS)), expiry_levels: identity(Object.values(EXPIRY_LEVEL_EN)),
    };
  }

  /* ---------------- 时间：和后端一样 ---------------- */

  // 存的是「不带时区的 UTC」，和后端 Python 的 datetime.isoformat() 一致，
  // 这样两边导出的 JSON 能互相认。
  const nowIso = () => new Date().toISOString().replace("Z", "");
  const pad2 = (n) => String(n).padStart(2, "0");
  const localDate = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  const todayIso = () => localDate(new Date());

  const utcDayNumber = (isoDate) => {
    const [y, m, d] = isoDate.split("-").map(Number);
    return Date.UTC(y, m - 1, d) / 86400000;
  };
  const dayDiff = (a, b) => utcDayNumber(a) - utcDayNumber(b);

  /** 本地某天 00:00 对应的 UTC 时刻（返回和后端一样的朴素 ISO）。 */
  function localMidnightUtcIso(isoDate) {
    const [y, m, d] = isoDate.split("-").map(Number);
    return new Date(new Date(y, m - 1, d, 0, 0, 0).getTime()).toISOString().replace("Z", "");
  }

  /* ---------------- 存储 ---------------- */

  function emptyDb() {
    return {
      app: "食材库",
      version: 1,
      exported_at: nowIso(),
      nextId: { ingredients: 1, shopping_items: 1, consumption_logs: 1 },
      ingredients: [],
      shopping_items: [],
      consumption_logs: [],
    };
  }

  let DB = (() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return emptyDb();
      const parsed = JSON.parse(raw);
      const base = emptyDb();
      return {
        ...base,
        ...parsed,
        nextId: { ...base.nextId, ...(parsed.nextId || {}) },
        ingredients: parsed.ingredients || [],
        shopping_items: parsed.shopping_items || [],
        consumption_logs: parsed.consumption_logs || [],
      };
    } catch (error) {
      console.warn("[本地数据] 读取失败，从空库开始：", error);
      return emptyDb();
    }
  })();

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(DB));
    } catch (error) {
      console.warn("[本地数据] 保存失败（可能空间满了）：", error);
      throw httpError(507, "手机存储写不进去了，先导出备份、清理一些旧数据再试");
    }
  }

  const nextId = (table) => {
    const id = DB.nextId[table] || 1;
    DB.nextId[table] = id + 1;
    return id;
  };

  /* ---------------- 小工具 ---------------- */

  function httpError(status, detail) {
    const error = new Error(detail);
    error.status = status;
    return error;
  }

  const round3 = (n) => Math.round(n * 1000) / 1000;
  const notBlank = (value, fallback) => {
    const text = (value === null || value === undefined ? "" : String(value)).trim();
    return text || fallback;
  };

  function units(sortedPairs) {
    return sortedPairs
      .filter(([, quantity]) => Math.abs(quantity) > 1e-9)
      .map(([unit, quantity]) => ({ unit, quantity: round3(quantity) }));
  }

  function resolveExpiry(purchaseDate, shelfLifeDays, expiryDate) {
    if (expiryDate) return expiryDate;
    if (purchaseDate && shelfLifeDays !== null && shelfLifeDays !== undefined) {
      const [y, m, d] = purchaseDate.split("-").map(Number);
      return localDate(new Date(y, m - 1, d + Number(shelfLifeDays)));
    }
    return null;
  }

  // 注意方向：剩余天数 = 到期日 − 今天。过期的是负数，和电脑版一致。
  const daysLeft = (item) => (item.expiry_date ? dayDiff(item.expiry_date, todayIso()) : null);

  function expiryLevel(item) {
    const days = daysLeft(item);
    if (days === null || days === undefined) return null;
    if (days < 0) return "expired";
    if (days <= EXPIRING_SOON_DAYS) return "soon";
    if (days <= EXPIRING_WARN_DAYS) return "warn";
    return "fresh";
  }

  function toRead(item) {
    return { ...item, days_left: daysLeft(item), expiry_level: expiryLevel(item) };
  }

  /* ---------------- 消耗流水 ---------------- */

  function logChange(item, action, quantity, { delta = null, note = null, happenedAt = null } = {}) {
    const qty = round3(Number(quantity) || 0);
    if (qty <= 0) return null;
    let signed = delta;
    if (signed === null) signed = action === "restock" ? qty : -qty;
    const log = {
      id: nextId("consumption_logs"),
      ingredient_id: item.id,
      ingredient_name: item.name,
      unit: item.unit,
      action,
      quantity: qty,
      delta: round3(signed),
      note: note || null,
      happened_at: happenedAt || nowIso(),
      created_at: nowIso(),
    };
    DB.consumption_logs.push(log);
    return log;
  }

  /* ---------------- 食材 ---------------- */

  const alive = (item) => !item.deleted_at;
  const findIngredient = (id) => DB.ingredients.find((item) => item.id === id) || null;

  function queryIngredients(params) {
    const status = params.status ?? "active";
    const limit = Number(params.limit ?? 200);
    const offset = Number(params.offset ?? 0);
    let list = DB.ingredients.slice();

    if (params.include_deleted !== "true") list = list.filter(alive);
    if (params.category) list = list.filter((item) => item.category === params.category);
    if (params.location) list = list.filter((item) => item.location === params.location);
    if (status && status !== "all") list = list.filter((item) => item.status === status);
    if (params.q) {
      const needle = params.q.trim().toLowerCase();
      list = list.filter((item) => [item.name, item.note, item.category]
        .some((field) => (field || "").toLowerCase().includes(needle)));
    }
    if (params.expiring_days !== undefined && params.expiring_days !== "") {
      const days = Number(params.expiring_days);
      const deadline = localDate(new Date(Date.now() + days * 86400000));
      list = list.filter((item) => item.expiry_date && item.expiry_date <= deadline);
    }

    const sort = params.sort || "days_left";
    const defaultDesc = sort === "created_at" || sort === "updated_at";
    const desc = (params.order || (defaultDesc ? "desc" : "asc")).toLowerCase() === "desc";
    const key = sort === "days_left" ? "expiry_date" : sort;
    list.sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av === null || av === undefined) {
        if (bv === null || bv === undefined) return b.id - a.id;
        return 1; // 没有到期日的排最后
      }
      if (bv === null || bv === undefined) return -1;
      let cmp;
      if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
      else if (key === "name") cmp = String(av).toLowerCase().localeCompare(String(bv).toLowerCase());
      else cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
      if (cmp !== 0) return desc ? -cmp : cmp;
      return b.id - a.id;
    });

    return { total: list.length, items: list.slice(offset, offset + limit).map(toRead), limit, offset };
  }

  function createIngredient(payload) {
    const name = notBlank(payload.name, null);
    if (!name) throw httpError(422, "食材名称不能为空");
    const purchaseDate = payload.purchase_date || todayIso();
    const shelfLife = payload.shelf_life_days === null || payload.shelf_life_days === undefined ? null : Number(payload.shelf_life_days);
    const item = {
      id: nextId("ingredients"),
      name,
      category: notBlank(payload.category, "其他"),
      quantity: round3(Number(payload.quantity ?? 1)),
      unit: notBlank(payload.unit, "个"),
      purchase_date: purchaseDate,
      shelf_life_days: shelfLife,
      expiry_date: resolveExpiry(purchaseDate, shelfLife, payload.expiry_date || null),
      location: notBlank(payload.location, "常温"),
      note: notBlank(payload.note, null),
      status: payload.status || "active",
      deleted_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    DB.ingredients.push(item);
    save();
    return toRead(item);
  }

  function updateIngredient(id, payload) {
    const item = findIngredient(id);
    if (!item) throw httpError(404, `食材 ${id} 不存在`);
    const before = item.quantity;
    const touchedExpiry = ["purchase_date", "shelf_life_days", "expiry_date"].some((key) => key in payload);

    for (const [key, value] of Object.entries(payload)) {
      if (["purchase_date", "shelf_life_days", "expiry_date", "note", "status"].includes(key)) item[key] = value;
      else if (key === "quantity") item.quantity = round3(Number(value));
      else if (["name", "category", "unit", "location"].includes(key)) item[key] = notBlank(value, item[key]);
    }

    if (touchedExpiry) {
      item.expiry_date = resolveExpiry(item.purchase_date, item.shelf_life_days, payload.expiry_date ?? null);
    }
    if ("quantity" in payload && Math.abs(item.quantity - before) > 1e-9) {
      const delta = item.quantity - before;
      logChange(item, "adjust", Math.abs(delta), { delta, note: "手动修改数量" });
    }
    item.updated_at = nowIso();
    save();
    return toRead(item);
  }

  function changeQuantity(id, patch) {
    const item = findIngredient(id);
    if (!item) throw httpError(404, `食材 ${id} 不存在`);
    const op = patch.op || "add";
    const amount = patch.amount === null || patch.amount === undefined ? null : Number(patch.amount);
    const before = item.quantity;

    if (op === "add") {
      const added = amount === null ? 1 : amount;
      item.quantity = round3(before + added);
      logChange(item, "restock", item.quantity - before, { note: patch.note });
      if (item.status !== "active" && item.quantity > 0) item.status = "active";
    } else if (op === "sub") {
      const removed = Math.min(before, amount === null ? 1 : amount);
      item.quantity = Math.max(0, round3(before - removed));
      logChange(item, "use", removed, { note: patch.note });
    } else if (op === "set") {
      if (amount === null) throw httpError(422, "op=set 时必须提供 amount");
      item.quantity = round3(amount);
      const delta = item.quantity - before;
      if (Math.abs(delta) > 1e-9) logChange(item, "adjust", Math.abs(delta), { delta, note: patch.note || "手动校正" });
    } else if (op === "use_half") {
      const used = round3(before / 2);
      item.quantity = round3(before - used);
      logChange(item, "use", used, { note: patch.note });
    } else if (op === "use_up") {
      item.quantity = 0;
      item.status = "used_up";
      logChange(item, "use", before, { note: patch.note });
    } else if (op === "discard") {
      item.status = "discarded";
      logChange(item, "discard", before, { note: patch.note });
    } else {
      throw httpError(422, `不认识的操作：${op}`);
    }

    if (["sub", "set", "use_half"].includes(op) && item.quantity === 0 && item.status === "active") {
      item.status = "used_up";
    }
    if (patch.note) item.note = patch.note;
    item.updated_at = nowIso();
    save();
    return toRead(item);
  }

  function softDelete(id) {
    const item = findIngredient(id);
    if (!item) throw httpError(404, `食材 ${id} 不存在`);
    item.deleted_at = nowIso();
    item.updated_at = nowIso();
    save();
    return { ok: true, id, message: "已移入回收站，可在回收站里恢复" };
  }

  function hardDelete(id) {
    const index = DB.ingredients.findIndex((item) => item.id === id);
    if (index < 0) throw httpError(404, `食材 ${id} 不存在`);
    DB.ingredients.splice(index, 1);
    // 流水留着（名称快照还在），只是把关联断掉，和后端的 ON DELETE SET NULL 一致
    for (const log of DB.consumption_logs) if (log.ingredient_id === id) log.ingredient_id = null;
    save();
    return { ok: true, id, message: "已彻底删除" };
  }

  function restore(id) {
    const item = findIngredient(id);
    if (!item) throw httpError(404, `食材 ${id} 不存在`);
    item.deleted_at = null;
    item.updated_at = nowIso();
    save();
    return toRead(item);
  }

  function queryTrash(params) {
    const list = DB.ingredients.filter((item) => item.deleted_at)
      .sort((a, b) => String(b.deleted_at).localeCompare(String(a.deleted_at)));
    const limit = Number(params.limit ?? 200);
    const offset = Number(params.offset ?? 0);
    return { total: list.length, items: list.slice(offset, offset + limit).map(toRead) };
  }

  function purgeTrash() {
    const doomed = DB.ingredients.filter((item) => item.deleted_at).map((item) => item.id);
    DB.ingredients = DB.ingredients.filter((item) => !item.deleted_at);
    for (const log of DB.consumption_logs) if (doomed.includes(log.ingredient_id)) log.ingredient_id = null;
    save();
    return { ok: true, id: null, message: `已彻底删除 ${doomed.length} 条` };
  }

  const BATCH_LABELS = { use_up: "用完", discard: "丢弃", delete: "移入回收站", restore: "恢复" };

  function batchAction(payload) {
    const ids = payload.ids || [];
    const op = payload.op || "use_up";
    if (!ids.length) throw httpError(422, "至少要选一条");
    let affected = 0;
    const missing = [];
    for (const id of ids) {
      const item = findIngredient(id);
      if (!item) { missing.push(id); continue; }
      if (item.deleted_at && op !== "restore") { missing.push(id); continue; }
      if (!item.deleted_at && op === "restore") { missing.push(id); continue; }

      if (op === "use_up") {
        logChange(item, "use", item.quantity, { note: payload.note });
        item.quantity = 0;
        item.status = "used_up";
      } else if (op === "discard") {
        logChange(item, "discard", item.quantity, { note: payload.note });
        item.status = "discarded";
      } else if (op === "delete") {
        item.deleted_at = nowIso();
      } else if (op === "restore") {
        item.deleted_at = null;
      }
      if (payload.note) item.note = payload.note;
      item.updated_at = nowIso();
      affected += 1;
    }
    save();
    return {
      ok: true, op, affected, missing,
      message: `${BATCH_LABELS[op] || op} ${affected} 条` + (missing.length ? `，跳过 ${missing.length} 条` : ""),
    };
  }

  function cleanupArchived(payload) {
    const statuses = payload.statuses && payload.statuses.length ? payload.statuses : ["used_up", "discarded"];
    const mode = payload.mode || "trash";
    const olderThan = payload.older_than_days === null || payload.older_than_days === undefined ? null : Number(payload.older_than_days);
    const cutoff = olderThan === null ? null : new Date(Date.now() - olderThan * 86400000).toISOString().replace("Z", "");

    const doomed = DB.ingredients.filter((item) => alive(item) && statuses.includes(item.status)
      && (cutoff === null || item.updated_at <= cutoff));
    for (const item of doomed) {
      if (mode === "purge") hardDelete(item.id);
      else { item.deleted_at = nowIso(); item.updated_at = nowIso(); }
    }
    save();
    const action = mode === "purge" ? "彻底删除" : "移入回收站";
    return { ok: true, mode, affected: doomed.length, message: `${action} ${doomed.length} 条` };
  }

  /* ---------------- 统计 / 选项 ---------------- */

  function stats() {
    const today = todayIso();
    const soonDeadline = localDate(new Date(Date.now() + EXPIRING_SOON_DAYS * 86400000));
    const warnDeadline = localDate(new Date(Date.now() + EXPIRING_WARN_DAYS * 86400000));
    const live = DB.ingredients.filter(alive);
    const active = live.filter((item) => item.status === "active");
    const withExpiry = active.filter((item) => item.expiry_date);

    const expired = withExpiry.filter((item) => item.expiry_date < today);
    const soon = withExpiry.filter((item) => item.expiry_date >= today && item.expiry_date <= soonDeadline);
    const warn = withExpiry.filter((item) => item.expiry_date > soonDeadline && item.expiry_date <= warnDeadline);

    const group = (key) => {
      const out = {};
      for (const item of active) out[item[key]] = (out[item[key]] || 0) + 1;
      return out;
    };

    const parts = [];
    if (expired.length) parts.push(`${expired.length} 样已过期`);
    if (soon.length) parts.push(`${soon.length} 样 ${EXPIRING_SOON_DAYS} 天内到期`);
    if (warn.length) parts.push(`${warn.length} 样 ${EXPIRING_WARN_DAYS} 天内到期`);

    const sortByExpiry = (list) => [...list].sort((a, b) => String(a.expiry_date).localeCompare(String(b.expiry_date)));

    return {
      total: live.length,
      active: active.length,
      expiring_soon: soon.length,
      expiring_week: soon.length + warn.length,
      expired: expired.length,
      used_up: live.filter((item) => item.status === "used_up").length,
      discarded: live.filter((item) => item.status === "discarded").length,
      out_of_stock: active.filter((item) => item.quantity <= 0).length,
      by_category: group("category"),
      by_location: group("location"),
      expiring_items: sortByExpiry([...expired, ...soon]).slice(0, 20).map(toRead),
      attention_text: parts.length ? parts.join("、") : "暂时没有临期食材，冰箱很健康",
      attention_items: sortByExpiry([...expired, ...soon]).slice(0, 50).map(toRead),
      attention_counts: {
        expired: expired.length, soon: soon.length, warn: warn.length,
        soon_days: EXPIRING_SOON_DAYS, warn_days: EXPIRING_WARN_DAYS,
      },
      soon_days: EXPIRING_SOON_DAYS,
      warn_days: EXPIRING_WARN_DAYS,
      generated_at: nowIso(),
    };
  }

  function options() {
    const live = DB.ingredients.filter(alive);
    const distinct = (key) => [...new Set(live.map((item) => item[key]).filter(Boolean))];
    const merge = (defaults, used) => [...defaults, ...used.filter((v) => !defaults.includes(v)).sort()];
    return {
      categories: merge(DEFAULT_CATEGORIES, distinct("category")),
      locations: merge(DEFAULT_LOCATIONS, distinct("location")),
      units: merge(DEFAULT_UNITS, distinct("unit")),
      statuses: Object.keys(STATUS_LABELS),
      soon_days: EXPIRING_SOON_DAYS,
      warn_days: EXPIRING_WARN_DAYS,
      name_suggestions: [...new Set(live.filter((item) => item.status === "active").map((item) => item.name))].sort(),
    };
  }

  /* ---------------- 流水 / 报表 ---------------- */

  function queryLogs(params) {
    let list = DB.consumption_logs.slice();
    if (params.ingredient_id) list = list.filter((log) => log.ingredient_id === Number(params.ingredient_id));
    if (params.action) list = list.filter((log) => log.action === params.action);
    if (params.date_from) list = list.filter((log) => log.happened_at >= localMidnightUtcIso(params.date_from));
    if (params.date_to) {
      const end = new Date(new Date(`${params.date_to}T00:00:00`).getTime() + 86400000);
      list = list.filter((log) => log.happened_at < localMidnightUtcIso(localDate(end)));
    }
    if (params.q) {
      const needle = params.q.trim().toLowerCase();
      list = list.filter((log) => [log.ingredient_name, log.note].some((f) => (f || "").toLowerCase().includes(needle)));
    }
    list.sort((a, b) => String(b.happened_at).localeCompare(String(a.happened_at)) || b.id - a.id);
    const limit = Number(params.limit ?? 100);
    const offset = Number(params.offset ?? 0);
    return { total: list.length, items: list.slice(offset, offset + limit), limit, offset };
  }

  function periodRange(period, anchor) {
    const base = anchor ? new Date(`${anchor}T00:00:00`) : new Date();
    if (period === "day") return [localDate(base), localDate(base)];
    if (period === "month") {
      const start = new Date(base.getFullYear(), base.getMonth(), 1);
      const end = new Date(base.getFullYear(), base.getMonth() + 1, 0);
      return [localDate(start), localDate(end)];
    }
    const weekday = (base.getDay() + 6) % 7; // 周一算一周开始
    const start = new Date(base.getTime() - weekday * 86400000);
    const end = new Date(start.getTime() + 6 * 86400000);
    return [localDate(start), localDate(end)];
  }

  function stockSnapshot(momentUtc) {
    const items = DB.ingredients.filter((item) => item.created_at <= momentUtc
      && (!item.deleted_at || item.deleted_at > momentUtc)).length;

    const current = {};
    for (const item of DB.ingredients.filter(alive)) {
      current[item.unit] = (current[item.unit] || 0) + item.quantity;
    }
    for (const log of DB.consumption_logs) {
      if (log.happened_at > momentUtc) {
        current[log.unit] = (current[log.unit] || 0) - (log.delta || 0);
      }
    }
    return { items, by_unit: units(Object.entries(current).sort()) };
  }

  function buildReport(params) {
    const period = params.period || "week";
    const [start, end] = periodRange(period, params.date || null);
    const startUtc = localMidnightUtcIso(start);
    const endUtc = localMidnightUtcIso(localDate(new Date(new Date(`${end}T00:00:00`).getTime() + 86400000)));

    const logs = DB.consumption_logs.filter((log) => log.happened_at >= startUtc && log.happened_at < endUtc);
    const counts = { use: 0, discard: 0, restock: 0, adjust: 0 };
    const sums = { use: {}, discard: {}, restock: {} };
    const ranking = { use: {}, discard: {} };

    for (const log of logs) {
      counts[log.action] = (counts[log.action] || 0) + 1;
      if (sums[log.action]) sums[log.action][log.unit] = (sums[log.action][log.unit] || 0) + log.quantity;
      if (ranking[log.action]) {
        const entry = ranking[log.action][log.ingredient_name] || { count: 0, quantities: {} };
        entry.count += 1;
        entry.quantities[log.unit] = (entry.quantities[log.unit] || 0) + log.quantity;
        ranking[log.action][log.ingredient_name] = entry;
      }
    }

    const top = (action) => Object.entries(ranking[action])
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([name, info]) => ({ name, count: info.count, quantities: units(Object.entries(info.quantities).sort()) }));

    const consumed = counts.use + counts.discard;
    const newIngredients = DB.ingredients.filter((item) => item.created_at >= startUtc && item.created_at < endUtc).length;
    const expiringInPeriod = DB.ingredients.filter((item) => alive(item) && item.expiry_date
      && item.expiry_date >= start && item.expiry_date <= end).length;

    return {
      period, start, end, days: dayDiff(end, start) + 1,
      use_count: counts.use, discard_count: counts.discard,
      restock_count: counts.restock, adjust_count: counts.adjust,
      used: units(Object.entries(sums.use).sort()),
      discarded: units(Object.entries(sums.discard).sort()),
      restocked: units(Object.entries(sums.restock).sort()),
      waste_rate: consumed ? Math.round((counts.discard / consumed) * 10000) / 10000 : 0,
      new_ingredients: newIngredients, expiring_in_period: expiringInPeriod,
      top_used: top("use"), top_discarded: top("discard"),
      stock_start: stockSnapshot(startUtc), stock_end: stockSnapshot(endUtc),
      generated_at: nowIso(),
    };
  }

  /* ---------------- 购物清单 ---------------- */

  function queryShopping(params) {
    let list = DB.shopping_items.slice();
    if (params.done === "true") list = list.filter((item) => item.done);
    else if (params.done === "false") list = list.filter((item) => !item.done);
    if (params.q) {
      const needle = params.q.trim().toLowerCase();
      list = list.filter((item) => [item.name, item.note].some((f) => (f || "").toLowerCase().includes(needle)));
    }
    list.sort((a, b) => Number(a.done) - Number(b.done) || String(b.created_at).localeCompare(String(a.created_at)));
    return { items: list, total: list.length, pending: DB.shopping_items.filter((item) => !item.done).length };
  }

  const findShopping = (id) => DB.shopping_items.find((item) => item.id === id) || null;

  function createShopping(payload) {
    const name = notBlank(payload.name, null);
    if (!name) throw httpError(422, "名称不能为空");
    const item = {
      id: nextId("shopping_items"),
      name,
      quantity: round3(Number(payload.quantity ?? 1)),
      unit: notBlank(payload.unit, "个"),
      category: notBlank(payload.category, null),
      note: notBlank(payload.note, null),
      done: Boolean(payload.done),
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    DB.shopping_items.push(item);
    save();
    return item;
  }

  function updateShopping(id, payload) {
    const item = findShopping(id);
    if (!item) throw httpError(404, `清单条目 ${id} 不存在`);
    for (const [key, value] of Object.entries(payload)) {
      if (key === "quantity") item.quantity = round3(Number(value));
      else if (key === "done") item.done = Boolean(value);
      else if (["name", "category", "note", "unit"].includes(key)) item[key] = notBlank(value, null) || (key === "unit" ? "个" : null);
    }
    item.updated_at = nowIso();
    save();
    return item;
  }

  function lastIngredientOf(name) {
    const needle = name.trim().toLowerCase();
    return DB.ingredients
      .filter((item) => item.name.toLowerCase() === needle)
      .sort((a, b) => Number(Boolean(a.deleted_at)) - Number(Boolean(b.deleted_at))
        || String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
  }

  function shoppingToIngredient(id, payload) {
    const item = findShopping(id);
    if (!item) throw httpError(404, `清单条目 ${id} 不存在`);
    const data = payload || {};
    const previous = lastIngredientOf(item.name);
    const purchaseDate = data.purchase_date || todayIso();
    let shelfLife = data.shelf_life_days === undefined ? null : data.shelf_life_days;
    if (shelfLife === null && !data.expiry_date && previous) shelfLife = previous.shelf_life_days;

    const ingredient = createIngredient({
      name: item.name,
      category: data.category || item.category || (previous ? previous.category : "其他"),
      quantity: data.quantity === undefined || data.quantity === null ? item.quantity : data.quantity,
      unit: data.unit || item.unit || (previous ? previous.unit : "个"),
      purchase_date: purchaseDate,
      shelf_life_days: shelfLife,
      expiry_date: data.expiry_date || null,
      location: data.location || (previous ? previous.location : "常温"),
      note: data.note !== undefined && data.note !== null ? data.note : item.note,
      status: "active",
    });
    if (data.mark_done !== false) {
      item.done = true;
      item.updated_at = nowIso();
      save();
    }
    return { ok: true, created: [ingredient], items: item.done ? [item] : [], skipped: [], message: `${item.name} 已入库` };
  }

  function checkout(payload) {
    const data = payload || {};
    let targets = data.item_ids && data.item_ids.length
      ? data.item_ids.map((id) => findShopping(id)).filter(Boolean)
      : DB.shopping_items.filter((item) => !item.done);
    const created = [];
    const doneItems = [];
    for (const item of targets) {
      const result = shoppingToIngredient(item.id, {
        location: data.location || null,
        shelf_life_days: data.shelf_life_days === undefined ? null : data.shelf_life_days,
        purchase_date: data.purchase_date || null,
        mark_done: data.mark_done !== false,
      });
      created.push(...result.created);
      doneItems.push(...result.items);
    }
    return { ok: true, created, items: doneItems, skipped: [], message: `入库 ${created.length} 样` };
  }

  function clearDoneShopping() {
    const before = DB.shopping_items.length;
    DB.shopping_items = DB.shopping_items.filter((item) => !item.done);
    save();
    return { ok: true, id: null, message: `已清理 ${before - DB.shopping_items.length} 条` };
  }

  /* ---------------- 导出 / 导入 ---------------- */

  function exportAll() {
    return {
      app: "食材库",
      version: 1,
      exported_at: nowIso(),
      counts: {
        ingredients: DB.ingredients.length,
        shopping_items: DB.shopping_items.length,
        consumption_logs: DB.consumption_logs.length,
      },
      ingredients: DB.ingredients,
      shopping_items: DB.shopping_items,
      consumption_logs: DB.consumption_logs,
    };
  }

  function csvCell(value) {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function exportCsv(kind, lang) {
    const language = lang === "en" ? "en" : "zh";
    const headers = CSV_HEADERS[language];
    const statuses = language === "en" ? STATUS_EN : STATUS_LABELS;
    const actions = language === "en" ? ACTION_EN : ACTION_LABELS;
    const yes = language === "en" ? "yes" : "是";
    const no = language === "en" ? "no" : "否";
    const rows = [];

    if (kind === "logs") {
      rows.push(headers.logs);
      for (const log of [...DB.consumption_logs].sort((a, b) => String(b.happened_at).localeCompare(String(a.happened_at)))) {
        rows.push([log.happened_at.slice(0, 16).replace("T", " "), log.ingredient_name,
          actions[log.action] || log.action, log.quantity, log.unit, log.delta, log.note || ""]);
      }
    } else if (kind === "shopping") {
      rows.push(headers.shopping);
      for (const item of DB.shopping_items) {
        rows.push([item.name, item.quantity, item.unit, item.category || "", item.done ? yes : no, item.note || ""]);
      }
    } else {
      rows.push(headers.ingredients);
      const list = [...DB.ingredients].sort((a, b) => String(a.expiry_date || "9999").localeCompare(String(b.expiry_date || "9999")));
      for (const item of list) {
        rows.push([item.id, item.name, item.category, item.quantity, item.unit, item.purchase_date,
          item.shelf_life_days ?? "", item.expiry_date || "", daysLeft(item) ?? "",
          item.location, statuses[item.status] || item.status, item.note || "", item.deleted_at ? yes : ""]);
      }
    }
    return "\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  }

  function importAll(payload, mode) {
    const replace = mode === "replace";
    if (!payload || !Array.isArray(payload.ingredients)) throw httpError(422, "备份文件格式不对（缺 ingredients）");
    if (replace) {
      DB.ingredients = [];
      DB.shopping_items = [];
      DB.consumption_logs = [];
      DB.nextId = { ingredients: 1, shopping_items: 1, consumption_logs: 1 };
    }

    let createdIngredients = 0;
    let skipped = 0;
    for (const raw of payload.ingredients) {
      const exists = !replace && DB.ingredients.some((item) => item.name === raw.name
        && item.purchase_date === raw.purchase_date && item.quantity === Number(raw.quantity));
      if (exists) { skipped += 1; continue; }
      const id = replace && raw.id ? Number(raw.id) : nextId("ingredients");
      if (replace && raw.id) DB.nextId.ingredients = Math.max(DB.nextId.ingredients, Number(raw.id) + 1);
      DB.ingredients.push({
        id,
        name: raw.name,
        category: raw.category || "其他",
        quantity: round3(Number(raw.quantity ?? 1)),
        unit: raw.unit || "个",
        purchase_date: raw.purchase_date || todayIso(),
        shelf_life_days: raw.shelf_life_days ?? null,
        expiry_date: raw.expiry_date || resolveExpiry(raw.purchase_date, raw.shelf_life_days, null),
        location: raw.location || "常温",
        note: raw.note || null,
        status: raw.status || "active",
        deleted_at: raw.deleted_at || null,
        created_at: raw.created_at || nowIso(),
        updated_at: raw.updated_at || nowIso(),
      });
      createdIngredients += 1;
    }

    let createdShopping = 0;
    for (const raw of payload.shopping_items || []) {
      const id = replace && raw.id ? Number(raw.id) : nextId("shopping_items");
      if (replace && raw.id) DB.nextId.shopping_items = Math.max(DB.nextId.shopping_items, Number(raw.id) + 1);
      DB.shopping_items.push({
        id, name: raw.name, quantity: round3(Number(raw.quantity ?? 1)), unit: raw.unit || "个",
        category: raw.category || null, note: raw.note || null, done: Boolean(raw.done),
        created_at: raw.created_at || nowIso(), updated_at: raw.updated_at || nowIso(),
      });
      createdShopping += 1;
    }

    let createdLogs = 0;
    const known = new Set(DB.ingredients.map((item) => item.id));
    for (const raw of payload.consumption_logs || []) {
      const id = nextId("consumption_logs");
      let ingredientId = replace && raw.ingredient_id ? Number(raw.ingredient_id) : null;
      if (ingredientId !== null && !known.has(ingredientId)) ingredientId = null;
      const quantity = Number(raw.quantity ?? 0);
      DB.consumption_logs.push({
        id, ingredient_id: ingredientId,
        ingredient_name: raw.ingredient_name || "（已删除）", unit: raw.unit || "个",
        action: raw.action || "adjust", quantity,
        delta: raw.delta === null || raw.delta === undefined
          ? (raw.action === "restock" ? quantity : -quantity) : Number(raw.delta),
        note: raw.note || null,
        happened_at: raw.happened_at || nowIso(), created_at: raw.created_at || nowIso(),
      });
      createdLogs += 1;
    }

    save();
    return {
      ok: true, mode: replace ? "replace" : "merge",
      ingredients: createdIngredients, shopping_items: createdShopping, consumption_logs: createdLogs,
      skipped_ingredients: skipped,
      message: `导入完成：食材 ${createdIngredients}、清单 ${createdShopping}、流水 ${createdLogs}`
        + (skipped ? `，跳过重复 ${skipped} 条` : ""),
    };
  }

  /* ---------------- 路由 ---------------- */

  const ROUTES = [
    ["GET", /^\/api\/health$/, () => ({ status: "ok", version: "本地版", database: "localStorage", time: nowIso() })],
    ["GET", /^\/api\/stats$/, () => stats()],
    ["GET", /^\/api\/meta\/options$/, () => options()],
    ["GET", /^\/api\/meta\/i18n$/, (m, q) => ({ lang: q.get("lang") === "en" ? "en" : "zh", ...i18nMaps(q.get("lang")) })],

    ["GET", /^\/api\/ingredients$/, (m, q) => queryIngredients(Object.fromEntries(q))],
    ["POST", /^\/api\/ingredients$/, (m, q, body) => createIngredient(body)],
    ["POST", /^\/api\/ingredients\/batch-action$/, (m, q, body) => batchAction(body)],
    ["POST", /^\/api\/ingredients\/cleanup$/, (m, q, body) => cleanupArchived(body || {})],
    ["GET", /^\/api\/ingredients\/(\d+)$/, (m, q, b, id) => {
      const item = findIngredient(Number(id));
      if (!item || item.deleted_at) throw httpError(404, `食材 ${id} 不存在`);
      return toRead(item);
    }],
    ["PUT", /^\/api\/ingredients\/(\d+)$/, (m, q, body, id) => updateIngredient(Number(id), body)],
    ["PATCH", /^\/api\/ingredients\/(\d+)\/quantity$/, (m, q, body, id) => changeQuantity(Number(id), body)],
    ["POST", /^\/api\/ingredients\/(\d+)\/restore$/, (m, q, b, id) => restore(Number(id))],
    ["DELETE", /^\/api\/ingredients\/(\d+)$/, (m, q, b, id) => (
      q.get("hard") === "true" ? hardDelete(Number(id)) : softDelete(Number(id))
    )],

    ["GET", /^\/api\/shopping$/, (m, q) => queryShopping(Object.fromEntries(q))],
    ["POST", /^\/api\/shopping$/, (m, q, body) => createShopping(body)],
    ["POST", /^\/api\/shopping\/clear-done$/, () => clearDoneShopping()],
    ["POST", /^\/api\/shopping\/checkout$/, (m, q, body) => checkout(body || {})],
    ["POST", /^\/api\/shopping\/(\d+)\/toggle$/, (m, q, b, id) => {
      const item = findShopping(Number(id));
      if (!item) throw httpError(404, `清单条目 ${id} 不存在`);
      item.done = !item.done;
      item.updated_at = nowIso();
      save();
      return item;
    }],
    ["POST", /^\/api\/shopping\/(\d+)\/to-ingredient$/, (m, q, body, id) => shoppingToIngredient(Number(id), body || {})],
    ["PATCH", /^\/api\/shopping\/(\d+)$/, (m, q, body, id) => updateShopping(Number(id), body)],
    ["DELETE", /^\/api\/shopping\/(\d+)$/, (m, q, b, id) => {
      const index = DB.shopping_items.findIndex((item) => item.id === Number(id));
      if (index < 0) throw httpError(404, `清单条目 ${id} 不存在`);
      DB.shopping_items.splice(index, 1);
      save();
      return { ok: true, id: Number(id), message: "已删除" };
    }],

    ["GET", /^\/api\/logs$/, (m, q) => queryLogs(Object.fromEntries(q))],
    ["GET", /^\/api\/reports$/, (m, q) => buildReport(Object.fromEntries(q))],

    ["GET", /^\/api\/trash$/, (m, q) => queryTrash(Object.fromEntries(q))],
    ["DELETE", /^\/api\/trash$/, () => purgeTrash()],
    ["DELETE", /^\/api\/trash\/(\d+)$/, (m, q, b, id) => {
      const item = findIngredient(Number(id));
      if (!item || !item.deleted_at) throw httpError(404, `回收站里没有食材 ${id}`);
      return hardDelete(Number(id));
    }],

    ["GET", /^\/api\/export$/, (m, q) => {
      if ((q.get("format") || "json") === "csv") {
        // 和真服务器一样：CSV 是纯文本响应，不是 JSON
        return { __raw: { body: exportCsv(q.get("kind") || "ingredients", q.get("lang") || "zh"), mime: "text/csv" } };
      }
      return exportAll();
    }],
    ["POST", /^\/api\/import$/, (m, q, body) => importAll(body, q.get("mode") === "replace" ? "replace" : "merge")],
    ["POST", /^\/api\/parse$/, (m, q, body) => window.LocalParser.parseText(body.text || "", body.lang || "zh")],
  ];

  async function handle(method, url, body) {
    const parsed = new URL(url, location.href);
    const query = parsed.searchParams;
    for (const [verb, pattern, fn] of ROUTES) {
      if (verb !== method) continue;
      const match = pattern.exec(parsed.pathname);
      if (!match) continue;
      try {
        return { status: 200, data: fn(match, query, body, match[1]) };
      } catch (error) {
        // 和真服务器一样：出错也返回一个带状态码的响应，而不是让请求本身炸掉
        return { status: error.status || 500, data: { detail: error.message || String(error) } };
      }
    }
    return { status: 404, data: { detail: `本地版没有这个接口：${method} ${parsed.pathname}` } };
  }

  /* ---------------- 拦截浏览器的请求 ---------------- */

  const realFetch = window.fetch ? window.fetch.bind(window) : null;

  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const isLocalApi = url.startsWith("/api/") || url.startsWith(`${location.origin}/api/`);
    if (!isLocalApi) return realFetch ? realFetch(input, init) : Promise.reject(new Error("没有网络"));

    const options = init || {};
    const method = (options.method || (input && input.method) || "GET").toUpperCase();
    const path = url.startsWith("/") ? url : new URL(url).pathname + new URL(url).search;

    let body = null;
    if (options.body) {
      try { body = JSON.parse(options.body); } catch { body = null; }
    }

    return handle(method, path, body).then(({ status, data }) => {
      if (data && data.__raw) {
        return new Response(data.__raw.body, {
          status,
          headers: { "Content-Type": `${data.__raw.mime}; charset=utf-8` },
        });
      }
      return new Response(
        JSON.stringify(data),
        { status, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    });
  };

  /* ---------------- 导出链接：在本地生成文件并下载 ---------------- */

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 0);
  }

  document.addEventListener("click", (event) => {
    const link = event.target && event.target.closest ? event.target.closest('a[href^="/api/export"]') : null;
    if (!link) return;
    event.preventDefault();
    const url = new URL(link.getAttribute("href"), location.href);
    const lang = url.searchParams.get("lang") || "zh";
    if ((url.searchParams.get("format") || "json") === "csv") {
      const kind = url.searchParams.get("kind") || "ingredients";
      download(`food-${kind}-${todayIso()}.csv`, exportCsv(kind, lang), "text/csv");
    } else {
      download(`food-backup-${todayIso()}.json`, JSON.stringify(exportAll(), null, 2), "application/json");
    }
  });

  // 方便调试：浏览器控制台里能看到这一层
  window.LocalStore = {
    get db() { return DB; },
    exportAll, importAll, reset() { DB = emptyDb(); save(); },
  };
})();
