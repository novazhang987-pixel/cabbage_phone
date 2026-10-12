/* 食材库 · 前端逻辑
   原生 JS，无框架。所有数据来自后端接口，文案来自 i18n.js + /api/meta/i18n。 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const savedLang = localStorage.getItem("fk.lang");

const state = {
  lang: savedLang || ((navigator.language || "").toLowerCase().startsWith("en") ? "en" : "zh"),
  view: "food",
  items: [],
  total: 0,
  stats: null,
  shopping: { items: [], pending: 0 },
  options: { categories: [], locations: [], units: [], name_suggestions: [] },
  dataLabels: {},
  filters: { q: "", category: "", location: "", status: "active", sort: "days_left", expiring: null },
  batch: false,
  selected: new Set(),
  editing: null,
  report: { period: "week", date: "" },
  logFilter: { action: "", from: "", to: "", q: "" },
};

/* ---------------- 小工具 ---------------- */

function t(key, vars) {
  const dict = window.I18N[state.lang] || window.I18N.zh;
  let text = dict[key] ?? window.I18N.zh[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(v);
  }
  return text;
}

/** 数据值翻译：分类/位置/单位这些预置值走对照表，自定义值原样显示。 */
function dl(kind, value) {
  if (value === null || value === undefined || value === "") return "";
  const table = state.dataLabels[kind];
  return (table && table[value]) || value;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function num(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

/** 后端存的是 UTC，显示要换算成本地时间，否则晚上看日期会差一天。 */
function localTime(iso) {
  if (!iso) return "";
  const date = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

let toastTimer = null;
function toast(message, isError = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = "toast"; }, 2800);
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, options);
  } catch (error) {
    // 网络层面的失败（离线、服务器没起来）单独给一句人话
    throw new Error(navigator.onLine === false ? t("offline") : error.message);
  }
  const text = await response.text();
  if (!response.ok) {
    let detail = `${response.status}`;
    try {
      const body = JSON.parse(text);
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body);
    } catch { /* 保持状态码 */ }
    throw new Error(detail);
  }
  return text ? JSON.parse(text) : null;
}

const jsonPost = (path, payload, method = "POST") => api(path, {
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload ?? {}),
});

/* ---------------- 文案 ---------------- */

function applyStaticText() {
  document.documentElement.lang = state.lang === "en" ? "en" : "zh-CN";
  $$("[data-i18n]").forEach((node) => { node.textContent = t(node.dataset.i18n); });
  $$("[data-i18n-ph]").forEach((node) => { node.placeholder = t(node.dataset.i18nPh); });
  $$("[data-i18n-title]").forEach((node) => { node.title = t(node.dataset.i18nTitle); });
  $$("#langSwitch button").forEach((b) => b.classList.toggle("active", b.dataset.lang === state.lang));
}

function fillSelect(node, entries, current) {
  node.innerHTML = entries
    .map(([value, label]) => `<option value="${esc(value)}"${value === current ? " selected" : ""}>${esc(label)}</option>`)
    .join("");
}

function rebuildSelects() {
  fillSelect($("#categorySelect"),
    [["", t("all_category")], ...state.options.categories.map((v) => [v, dl("categories", v)])],
    state.filters.category);
  fillSelect($("#locationSelect"),
    [["", t("all_location")], ...state.options.locations.map((v) => [v, dl("locations", v)])],
    state.filters.location);
  fillSelect($("#statusSelect"), [
    ["active", t("status_active")],
    ["used_up", t("status_used_up")],
    ["discarded", t("status_discarded")],
    ["all", t("status_all")],
  ], state.filters.status);
  fillSelect($("#sortSelect"), [
    ["days_left", t("sort_days")],
    ["expiry_date", t("sort_expiry")],
    ["created_at", t("sort_created")],
    ["name", t("sort_name")],
    ["quantity", t("sort_quantity")],
  ], state.filters.sort);
  fillSelect($("#reportPeriod"), [
    ["week", t("report_week")],
    ["month", t("report_month")],
    ["day", t("report_day")],
  ], state.report.period);
  fillSelect($("#logAction"), [
    ["", t("logs_all_actions")],
    ["use", t("act_use")],
    ["discard", t("act_discard")],
    ["restock", t("act_restock")],
    ["adjust", t("act_adjust")],
  ], state.logFilter.action);

  $("#categoryList").innerHTML = state.options.categories.map((v) => `<option value="${esc(v)}">`).join("");
  $("#locationList").innerHTML = state.options.locations.map((v) => `<option value="${esc(v)}">`).join("");
  $("#unitList").innerHTML = state.options.units.map((v) => `<option value="${esc(v)}">`).join("");
}

/* ---------------- 加载 ---------------- */

async function loadOptions() {
  const [options, labels] = await Promise.all([
    api("/api/meta/options"),
    api(`/api/meta/i18n?lang=${state.lang}`),
  ]);
  state.options = options;
  state.dataLabels = labels;
  rebuildSelects();
}

async function loadStats() {
  state.stats = await api("/api/stats");
  renderStats();
  renderBanner();
}

async function loadItems() {
  const params = new URLSearchParams({ sort: state.filters.sort, limit: "300" });
  if (state.filters.q) params.set("q", state.filters.q);
  if (state.filters.category) params.set("category", state.filters.category);
  if (state.filters.location) params.set("location", state.filters.location);
  if (state.filters.status) params.set("status", state.filters.status);
  if (state.filters.expiring !== null) params.set("expiring_days", String(state.filters.expiring));

  const data = await api(`/api/ingredients?${params}`);
  state.items = data.items;
  state.total = data.total;
  renderGrid();
}

async function loadShopping() {
  state.shopping = await api("/api/shopping?done=all");
  renderShopping();
}

/* ---------------- 渲染：横幅 / 统计 ---------------- */

function renderBanner() {
  const banner = $("#banner");
  const counts = state.stats?.attention_counts;
  if (!counts) { banner.hidden = true; return; }

  const parts = [];
  if (counts.expired) parts.push(state.lang === "en" ? `${counts.expired} expired` : `${counts.expired} 样已过期`);
  if (counts.soon) {
    parts.push(state.lang === "en"
      ? `${counts.soon} expiring within ${counts.soon_days} days`
      : `${counts.soon} 样 ${counts.soon_days} 天内到期`);
  }
  if (counts.warn) {
    parts.push(state.lang === "en"
      ? `${counts.warn} within ${counts.warn_days} days`
      : `${counts.warn} 样 ${counts.warn_days} 天内到期`);
  }

  banner.hidden = false;
  banner.className = "banner" + (counts.expired ? " alarm" : counts.soon || counts.warn ? " urgent" : "");
  $("#bannerText").textContent = parts.length ? parts.join(state.lang === "en" ? ", " : "、") : t("banner_ok");
}

const STAT_CHIPS = [
  ["st_total", "total", () => ({ status: "all", expiring: null })],
  ["st_active", "active", () => ({ status: "active", expiring: null })],
  ["st_soon", "expiring_soon", () => ({ status: "active", expiring: state.stats.soon_days })],
  ["st_expired", "expired", () => ({ status: "active", expiring: 0 })],
  ["st_used", "used_up", () => ({ status: "used_up", expiring: null })],
  ["st_discarded", "discarded", () => ({ status: "discarded", expiring: null })],
];

function renderStats() {
  const stats = state.stats;
  if (!stats) return;
  $("#statsRow").innerHTML = STAT_CHIPS.map(([labelKey, field, targetFn]) => {
    const target = targetFn();
    const active = state.filters.status === target.status
      && String(state.filters.expiring) === String(target.expiring);
    const cls = field === "expired" && stats[field] ? "alarm" : field === "expiring_soon" && stats[field] ? "urgent" : "";
    return `<button class="stat${active ? " active" : ""}" data-chip="${labelKey}">
      <b class="${cls}">${stats[field] ?? 0}</b><span>${esc(t(labelKey))}</span></button>`;
  }).join("");
}

/* ---------------- 渲染：食材列表 ---------------- */

function daysText(item) {
  if (item.days_left === null || item.days_left === undefined) return t("no_expiry");
  if (item.days_left < 0) return t("days_overdue", { n: -item.days_left });
  if (item.days_left === 0) return t("days_today");
  return t("days_left", { n: item.days_left });
}

function cardHtml(item) {
  const picked = state.selected.has(item.id);
  const level = item.expiry_level || "fresh";
  const active = item.status === "active";
  const actions = active
    ? `<button class="btn sm" data-act="sub" data-id="${item.id}">${esc(t("act_minus"))}</button>
       <button class="btn sm" data-act="add" data-id="${item.id}">${esc(t("act_plus"))}</button>
       <button class="btn sm primary" data-act="use_up" data-id="${item.id}">${esc(t("act_finish"))}</button>
       <button class="btn sm ghost danger" data-act="discard" data-id="${item.id}">${esc(t("act_discard"))}</button>`
    : `<button class="btn sm" data-act="add" data-id="${item.id}">${esc(t("act_plus"))}</button>
       <span class="tag">${esc(dl("statuses", item.status))}</span>
       <button class="btn sm ghost danger" data-act="delete" data-id="${item.id}">${esc(t("btn_delete"))}</button>`;

  return `<article class="card level-${esc(level)}${picked ? " selected" : ""}" data-card="${item.id}">
    ${state.batch ? `<input type="checkbox" class="pick" data-pick="${item.id}"${picked ? " checked" : ""}>` : ""}
    <div class="card-head"><h3 data-edit="${item.id}">${esc(item.name)}</h3></div>
    <div class="card-meta">
      <span class="tag">${esc(dl("categories", item.category))}</span>
      <span class="tag">${esc(dl("locations", item.location))}</span>
    </div>
    <div class="card-qty">${esc(num(item.quantity))} ${esc(dl("units", item.unit))}</div>
    <div class="card-days ${esc(level)}">${esc(daysText(item))}</div>
    ${item.note ? `<div class="card-note">${esc(item.note)}</div>` : ""}
    <div class="card-actions">${actions}</div>
  </article>`;
}

function renderGrid() {
  const grid = $("#foodGrid");
  const empty = $("#foodEmpty");
  grid.innerHTML = state.items.map(cardHtml).join("");
  const filtered = state.filters.q || state.filters.category || state.filters.location || state.filters.expiring !== null;
  empty.hidden = state.items.length > 0;
  empty.textContent = filtered ? t("empty_filter") : t("empty_food");
  renderBatchBar();
}

function renderBatchBar() {
  const bar = $("#batchBar");
  bar.classList.toggle("show", state.batch);
  $("#batchCount").textContent = t("selected", { n: state.selected.size });
  $$("#batchBar [data-batch]").forEach((btn) => {
    btn.disabled = state.selected.size === 0;
  });
  $("#batchBtn").textContent = state.batch ? t("btn_batch_exit") : t("btn_batch");
}

/* ---------------- 渲染：购物清单 ---------------- */

function renderShopping() {
  $("#shoppingCount").textContent = state.shopping.pending;
  $("#drawerPending").textContent = `${state.shopping.pending} ${t("shopping_pending")}`;

  const pending = state.shopping.items.filter((i) => !i.done);
  const done = state.shopping.items.filter((i) => i.done);
  const row = (item) => `<div class="shop-row${item.done ? " done" : ""}" data-shop="${item.id}">
      <input type="checkbox" data-shop-toggle="${item.id}"${item.done ? " checked" : ""}>
      <span class="shop-name" data-shop-name="${item.id}">${esc(item.name)}</span>
      <span class="tag">${esc(num(item.quantity))} ${esc(dl("units", item.unit))}</span>
      <button class="btn sm ghost" data-shop-in="${item.id}" title="${esc(t("btn_checkout"))}">📥</button>
      <button class="btn sm ghost danger" data-shop-del="${item.id}">✕</button>
    </div>`;

  $("#shopList").innerHTML = state.shopping.items.length
    ? [...pending, ...done].map(row).join("")
    : `<div class="empty">${esc(t("shopping_empty"))}</div>`;
}

/* ---------------- 报表 ---------------- */

function formatUnits(list) {
  if (!list || !list.length) return "—";
  return list.map((entry) => `${num(entry.quantity)} ${dl("units", entry.unit)}`).join(state.lang === "en" ? ", " : "、");
}

function rankBars(list, kind) {
  if (!list || !list.length) return `<div class="empty">${esc(t("report_none"))}</div>`;
  const max = Math.max(...list.map((item) => item.count));
  return list.map((item) => `<div class="bar-row">
      <span class="name">${esc(item.name)}</span>
      <span class="bar ${kind}" style="width:${Math.max(6, (item.count / max) * 120)}px"></span>
      <span class="num">${item.count} 次 · ${esc(formatUnits(item.quantities))}</span>
    </div>`).join("");
}

async function loadReport() {
  const params = new URLSearchParams({ period: state.report.period });
  if (state.report.date) params.set("date", state.report.date);
  const data = await api(`/api/reports?${params}`);
  const scope = t("report_scope", { start: data.start, end: data.end, days: data.days });
  const timesLabel = state.lang === "en" ? "×" : " 次";

  $("#reportBody").innerHTML = `
    <div class="panel">
      <h2>${esc(t("report_period"))} · ${esc(scope)}</h2>
      <div class="metrics">
        <div class="metric"><b>${data.use_count}</b><span>${esc(t("report_used"))}</span></div>
        <div class="metric"><b>${data.discard_count}</b><span>${esc(t("report_discarded"))}</span></div>
        <div class="metric"><b>${data.restock_count}</b><span>${esc(t("report_restocked"))}</span></div>
        <div class="metric"><b>${Math.round(data.waste_rate * 100)}%</b><span>${esc(t("report_waste"))}</span></div>
        <div class="metric"><b>${data.new_ingredients}</b><span>${esc(t("report_new"))}</span></div>
        <div class="metric"><b>${data.expiring_in_period}</b><span>${esc(t("report_expiring"))}</span></div>
      </div>
    </div>

    <div class="panel">
      <h2>${esc(t("report_used"))} / ${esc(t("report_discarded"))}</h2>
      <div class="metrics">
        <div class="metric"><b>${esc(formatUnits(data.used))}</b><span>${esc(t("act_use"))}</span></div>
        <div class="metric"><b>${esc(formatUnits(data.discarded))}</b><span>${esc(t("act_discard"))}</span></div>
        <div class="metric"><b>${esc(formatUnits(data.restocked))}</b><span>${esc(t("act_restock"))}</span></div>
      </div>
    </div>

    <div class="panel">
      <h2>${esc(t("report_top_used"))}</h2>
      <div class="bars">${rankBars(data.top_used, "")}</div>
      <h2 style="margin-top:16px">${esc(t("report_top_discarded"))}</h2>
      <div class="bars">${rankBars(data.top_discarded, "discard")}</div>
    </div>

    <div class="panel">
      <h2>${esc(t("report_stock_start"))} → ${esc(t("report_stock_end"))}</h2>
      <div class="metrics">
        <div class="metric"><b>${data.stock_start.items}</b><span>${esc(t("report_stock_start"))}</span></div>
        <div class="metric"><b>${data.stock_end.items}</b><span>${esc(t("report_stock_end"))}</span></div>
      </div>
      <div style="color:var(--muted);font-size:.85rem;margin-top:8px">
        ${esc(formatUnits(data.stock_start.by_unit))} → ${esc(formatUnits(data.stock_end.by_unit))}
      </div>
    </div>`;
}

/* ---------------- 流水 ---------------- */

async function loadLogs() {
  const params = new URLSearchParams({ limit: "200" });
  if (state.logFilter.action) params.set("action", state.logFilter.action);
  if (state.logFilter.from) params.set("date_from", state.logFilter.from);
  if (state.logFilter.to) params.set("date_to", state.logFilter.to);
  if (state.logFilter.q) params.set("q", state.logFilter.q);

  const data = await api(`/api/logs?${params}`);
  $("#logsBody").innerHTML = data.items.length
    ? data.items.map((log) => `<div class="log-row">
        <span class="log-time">${esc(localTime(log.happened_at))}</span>
        <span class="log-name">${esc(log.ingredient_name)}</span>
        <span class="act ${esc(log.action)}">${esc(dl("actions", log.action))}</span>
        <span>${esc(num(log.quantity))} ${esc(dl("units", log.unit))}</span>
        <span style="color:var(--muted);font-size:.82rem">${esc(log.note || "")}</span>
      </div>`).join("")
    : `<div class="empty">${esc(t("empty_logs"))}</div>`;
}

/* ---------------- 回收站 ---------------- */

async function loadTrash() {
  const data = await api("/api/trash");
  $("#trashBody").innerHTML = data.items.length
    ? data.items.map((item) => `<div class="trash-row">
        <span class="log-name">${esc(item.name)}</span>
        <span class="tag">${esc(dl("categories", item.category))}</span>
        <span class="tag">${esc(num(item.quantity))} ${esc(dl("units", item.unit))}</span>
        <button class="btn sm" data-restore="${item.id}">${esc(t("btn_restore"))}</button>
        <button class="btn sm ghost danger" data-purge="${item.id}">${esc(t("btn_purge"))}</button>
      </div>`).join("")
    : `<div class="empty">${esc(t("empty_trash"))}</div>`;
}

/* ---------------- 视图切换 ---------------- */

async function switchView(view) {
  state.view = view;
  $$("#navTabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  ["food", "report", "logs", "trash"].forEach((name) => { $(`#view-${name}`).hidden = name !== view; });
  if (view === "report") await loadReport();
  if (view === "logs") await loadLogs();
  if (view === "trash") await loadTrash();
}

/* ---------------- 弹窗 ---------------- */

const FORM_MAP = {
  name: "#f-name",
  category: "#f-category",
  location: "#f-location",
  quantity: "#f-quantity",
  unit: "#f-unit",
  purchase_date: "#f-purchase",
  shelf_life_days: "#f-shelf",
  expiry_date: "#f-expiry",
  note: "#f-note",
};

function today() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function fillForm(data = {}, inferred = []) {
  for (const [key, selector] of Object.entries(FORM_MAP)) {
    const input = $(selector);
    input.value = data[key] === null || data[key] === undefined ? "" : data[key];
    input.classList.toggle("inferred", inferred.includes(key));
  }
}

function openModal(item = null) {
  state.editing = item;
  $("#modalTitle").textContent = t(item ? "modal_edit" : "modal_new");
  $("#modalSub").textContent = "";
  $("#voiceHint").textContent = "";
  $("#voiceHint").className = "voice-hint";
  $("#deleteBtn").hidden = !item;

  if (item) {
    fillForm(item);
  } else {
    fillForm({ purchase_date: today(), quantity: 1 });
  }
  $("#overlay").classList.add("open");
  setTimeout(() => $("#f-name").focus(), 40);
}

function closeModal() {
  $("#overlay").classList.remove("open");
  state.editing = null;
}

/* ---------------- 语音 ---------------- */

let recognizer = null;
let listening = false;

function setVoiceHint(text, isListening = false) {
  const node = $("#voiceHint");
  node.textContent = text || "";
  node.className = "voice-hint" + (isListening ? " listening" : "");
}

function voiceSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/** 浏览器给的错误码 → 人话。
    语音识别是联网的（Chrome 走 Google、Edge 走微软），最常见的就是网络不通。 */
function voiceErrorText(code) {
  const key = `voice_err_${String(code || "other").replace(/-/g, "_")}`;
  const dict = window.I18N[state.lang] || window.I18N.zh;
  return dict[key] || t("voice_err_other", { code: code || "unknown" });
}

function startVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { toast(t("voice_unsupported"), true); return; }
  if (listening && recognizer) { recognizer.stop(); return; }

  if (!$("#overlay").classList.contains("open")) openModal(null);

  recognizer = new SpeechRecognition();
  recognizer.lang = state.lang === "en" ? "en-US" : "zh-CN";
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 1;
  listening = true;
  setVoiceHint(t("voice_listening"), true);

  recognizer.onresult = (event) => {
    const text = event.results[0][0].transcript;
    handleVoiceText(text).catch((error) => {
      setVoiceHint(t("api_error", { msg: error.message }));
    });
  };
  recognizer.onerror = (event) => {
    listening = false;
    const code = event?.error || "unknown";
    const message = voiceErrorText(code);
    setVoiceHint(message);
    toast(message, true); // 弹窗里可能看不到，外面再提示一次
    console.warn("[语音] 识别失败，错误码：", code, event);
  };
  recognizer.onend = () => {
    listening = false;
    if ($("#voiceHint").classList.contains("listening")) setVoiceHint("");
  };
  try {
    recognizer.start();
  } catch (error) {
    listening = false;
    setVoiceHint(voiceErrorText(String(error?.name || "other")));
  }
}

/** 不打字不说话的退路：手打一句话，走同一套解析。 */
async function parseSentence() {
  const input = $("#sentenceInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  try {
    await handleVoiceText(text);
  } catch (error) {
    setVoiceHint(t("api_error", { msg: error.message }));
  }
}

async function handleVoiceText(text) {
  const parsed = await jsonPost("/api/parse", { text, lang: state.lang });
  if (!$("#overlay").classList.contains("open")) openModal(null);
  fillForm(parsed, parsed.inferred || []);
  $("#f-purchase").value = parsed.purchase_date || $("#f-purchase").value || today();
  $("#modalTitle").textContent = t("modal_voice");
  $("#modalSub").textContent = t("voice_heard") + text
    + (parsed.inferred?.length ? ` · ${t("voice_inferred")}` : "");
  setVoiceHint(parsed.warnings?.[0] || "");
  if (!parsed.name) $("#f-name").focus();
}

/* ---------------- 动作 ---------------- */

async function refreshAll() {
  await Promise.all([loadStats(), loadItems(), loadShopping()]);
}

async function quickAction(id, action) {
  const item = state.items.find((i) => i.id === id);
  try {
    if (action === "delete") {
      if (!confirm(t("confirm_delete", { name: item?.name ?? id }))) return;
      await api(`/api/ingredients/${id}`, { method: "DELETE" });
      toast(t("deleted"));
    } else if (action === "use_up" || action === "discard") {
      await jsonPost(`/api/ingredients/${id}/quantity`, { op: action }, "PATCH");
      toast(action === "use_up" ? t("finished", { name: item?.name ?? id }) : t("discarded", { name: item?.name ?? id }));
    } else {
      await jsonPost(`/api/ingredients/${id}/quantity`, { op: action }, "PATCH");
    }
    await refreshAll();
  } catch (error) {
    toast(t("api_error", { msg: error.message }), true);
  }
}

async function runBatch(op) {
  if (!state.selected.size) return;
  try {
    const result = await jsonPost("/api/ingredients/batch-action", { ids: [...state.selected], op });
    toast(t("batch_done", { n: result.affected }));
    state.selected.clear();
    state.batch = false;
    await refreshAll();
  } catch (error) {
    toast(t("api_error", { msg: error.message }), true);
  }
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $("#navTabs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-view]");
    if (button) return switchView(button.dataset.view);
  });

  $("#langSwitch").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-lang]");
    if (!button || button.dataset.lang === state.lang) return;
    state.lang = button.dataset.lang;
    localStorage.setItem("fk.lang", state.lang);
    applyStaticText();
    await loadOptions();
    await refreshAll();
    if (state.view === "report") await loadReport();
    if (state.view === "logs") await loadLogs();
    if (state.view === "trash") await loadTrash();
  });

  $("#searchInput").addEventListener("input", debounce((event) => {
    state.filters.q = event.target.value.trim();
    loadItems().catch((e) => toast(e.message, true));
  }, 260));

  const filterChange = (selector, key) => $(selector).addEventListener("change", (event) => {
    state.filters[key] = event.target.value;
    state.filters.expiring = null; // 手动换筛选条件时，取消「临期」这个临时条件
    renderStats();
    return loadItems().catch((e) => toast(e.message, true));
  });
  filterChange("#categorySelect", "category");
  filterChange("#locationSelect", "location");
  filterChange("#statusSelect", "status");
  filterChange("#sortSelect", "sort");

  $("#statsRow").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-chip]");
    if (!chip) return;
    const entry = STAT_CHIPS.find(([key]) => key === chip.dataset.chip);
    if (!entry) return;
    const target = entry[2]();
    state.filters.status = target.status;
    state.filters.expiring = target.expiring;
    $("#statusSelect").value = target.status;
    renderStats();
    return loadItems().catch((e) => toast(e.message, true));
  });

  $("#banner").addEventListener("click", () => {
    const soon = state.stats?.attention_counts?.soon_days ?? 3;
    state.filters.status = "active";
    state.filters.expiring = state.filters.expiring === null ? soon : null;
    $("#statusSelect").value = "active";
    renderStats();
    return loadItems().catch((e) => toast(e.message, true));
  });

  $("#foodGrid").addEventListener("click", (event) => {
    const actionBtn = event.target.closest("[data-act]");
    // 返回 Promise：浏览器里没差别，自动化测试才能准确等它做完
    if (actionBtn) return quickAction(Number(actionBtn.dataset.id), actionBtn.dataset.act);
    const editTarget = event.target.closest("[data-edit]");
    if (editTarget) {
      const item = state.items.find((i) => i.id === Number(editTarget.dataset.edit));
      if (item) openModal(item);
    }
  });

  $("#foodGrid").addEventListener("change", (event) => {
    const pick = event.target.closest("[data-pick]");
    if (!pick) return;
    const id = Number(pick.dataset.pick);
    if (pick.checked) state.selected.add(id); else state.selected.delete(id);
    renderGrid();
  });

  $("#batchBtn").addEventListener("click", () => {
    state.batch = !state.batch;
    if (!state.batch) state.selected.clear();
    renderGrid();
  });
  $("#batchCancel").addEventListener("click", () => {
    state.batch = false;
    state.selected.clear();
    renderGrid();
  });
  $("#batchBar").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-batch]");
    if (btn) return runBatch(btn.dataset.batch);
  });

  $("#addBtn").addEventListener("click", () => openModal(null));
  $("#voiceBtn").addEventListener("click", startVoice);
  $("#voiceInModal").addEventListener("click", startVoice);
  $("#sentenceBtn").addEventListener("click", parseSentence);
  $("#sentenceInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); parseSentence(); }
  });
  $("#cancelBtn").addEventListener("click", closeModal);
  $("#overlay").addEventListener("click", (event) => { if (event.target === $("#overlay")) closeModal(); });

  $("#deleteBtn").addEventListener("click", async () => {
    const item = state.editing;
    if (!item || !confirm(t("confirm_delete", { name: item.name }))) return;
    try {
      await api(`/api/ingredients/${item.id}`, { method: "DELETE" });
      closeModal();
      toast(t("deleted"));
      await refreshAll();
    } catch (error) { toast(t("api_error", { msg: error.message }), true); }
  });

  $("#ingredientForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = { name: $("#f-name").value.trim() };
    if (!payload.name) return;
    const category = $("#f-category").value.trim();
    const location = $("#f-location").value.trim();
    const unit = $("#f-unit").value.trim();
    const quantity = $("#f-quantity").value;
    const purchase = $("#f-purchase").value;
    const shelf = $("#f-shelf").value;
    const expiry = $("#f-expiry").value;
    const note = $("#f-note").value.trim();

    if (category) payload.category = category;
    if (location) payload.location = location;
    if (unit) payload.unit = unit;
    if (quantity !== "") payload.quantity = Number(quantity);
    if (purchase) payload.purchase_date = purchase;

    if (state.editing) {
      payload.shelf_life_days = shelf === "" ? null : Number(shelf);
      payload.expiry_date = expiry || null;
      payload.note = note || null;
    } else {
      if (shelf !== "") payload.shelf_life_days = Number(shelf);
      if (expiry) payload.expiry_date = expiry;
      if (note) payload.note = note;
    }

    try {
      if (state.editing) await jsonPost(`/api/ingredients/${state.editing.id}`, payload, "PUT");
      else await jsonPost("/api/ingredients", payload);
      closeModal();
      toast(t("saved"));
      await refreshAll();
    } catch (error) { toast(t("api_error", { msg: error.message }), true); }
  });

  $("#cleanupBtn").addEventListener("click", async () => {
    try {
      const probe = await jsonPost("/api/ingredients/cleanup", { statuses: ["used_up", "discarded"], mode: "trash" });
      toast(t("cleanup_done", { n: probe.affected }));
      await refreshAll();
    } catch (error) { toast(t("api_error", { msg: error.message }), true); }
  });

  // 购物清单
  $("#shoppingBtn").addEventListener("click", () => $("#drawer").classList.add("open"));
  $("#drawerClose").addEventListener("click", () => $("#drawer").classList.remove("open"));

  $("#shopAddBtn").addEventListener("click", addShopping);
  $("#shopName").addEventListener("keydown", (event) => { if (event.key === "Enter") addShopping(); });

  $("#shopList").addEventListener("click", async (event) => {
    const toggle = event.target.closest("[data-shop-toggle]");
    const remove = event.target.closest("[data-shop-del]");
    const toStock = event.target.closest("[data-shop-in]");
    try {
      if (toggle) {
        await api(`/api/shopping/${toggle.dataset.shopToggle}/toggle`, { method: "POST" });
        await loadShopping();
      } else if (remove) {
        await api(`/api/shopping/${remove.dataset.shopDel}`, { method: "DELETE" });
        await loadShopping();
      } else if (toStock) {
        const result = await jsonPost(`/api/shopping/${toStock.dataset.shopIn}/to-ingredient`, {});
        toast(t("checkout_done", { n: result.created.length }));
        await refreshAll();
      }
    } catch (error) { toast(t("api_error", { msg: error.message }), true); }
  });

  $("#checkoutBtn").addEventListener("click", async () => {
    try {
      const result = await jsonPost("/api/shopping/checkout", {});
      toast(t("checkout_done", { n: result.created.length }));
      await refreshAll();
    } catch (error) { toast(t("api_error", { msg: error.message }), true); }
  });

  $("#clearDoneBtn").addEventListener("click", async () => {
    try {
      await jsonPost("/api/shopping/clear-done", {});
      await loadShopping();
    } catch (error) { toast(t("api_error", { msg: error.message }), true); }
  });

  // 报表 / 流水筛选
  $("#reportPeriod").addEventListener("change", (event) => {
    state.report.period = event.target.value;
    return loadReport().catch((e) => toast(e.message, true));
  });
  $("#reportDate").addEventListener("change", (event) => {
    state.report.date = event.target.value;
    return loadReport().catch((e) => toast(e.message, true));
  });
  const logFilter = (selector, key, immediate = true) => $(selector).addEventListener("input", debounce((event) => {
    state.logFilter[key] = event.target.value;
    loadLogs().catch((e) => toast(e.message, true));
  }, immediate ? 260 : 0));
  logFilter("#logSearch", "q");
  $("#logAction").addEventListener("change", (event) => {
    state.logFilter.action = event.target.value;
    return loadLogs().catch((e) => toast(e.message, true));
  });
  $("#logFrom").addEventListener("change", (event) => {
    state.logFilter.from = event.target.value;
    return loadLogs().catch((e) => toast(e.message, true));
  });
  $("#logTo").addEventListener("change", (event) => {
    state.logFilter.to = event.target.value;
    return loadLogs().catch((e) => toast(e.message, true));
  });

  // 回收站
  $("#trashBody").addEventListener("click", async (event) => {
    const restore = event.target.closest("[data-restore]");
    const purge = event.target.closest("[data-purge]");
    try {
      if (restore) {
        await api(`/api/ingredients/${restore.dataset.restore}/restore`, { method: "POST" });
        toast(t("restored"));
      } else if (purge) {
        await api(`/api/trash/${purge.dataset.purge}`, { method: "DELETE" });
        toast(t("deleted"));
      }
      await Promise.all([loadTrash(), loadStats()]);
    } catch (error) { toast(t("api_error", { msg: error.message }), true); }
  });

  $("#emptyTrashBtn").addEventListener("click", async () => {
    try {
      const data = await api("/api/trash");
      if (!data.total) { toast(t("empty_trash")); return; }
      if (!confirm(t("confirm_empty_trash", { n: data.total }))) return;
      await api("/api/trash", { method: "DELETE" });
      toast(t("deleted"));
      await Promise.all([loadTrash(), loadStats()]);
    } catch (error) { toast(t("api_error", { msg: error.message }), true); }
  });

  // 导入备份（选一个导出的 json 文件，覆盖现有数据）——搬家到云上时最省事的办法
  $("#importFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!confirm(t("confirm_import"))) { event.target.value = ""; return; }
    try {
      const payload = JSON.parse(await file.text());
      const result = await jsonPost("/api/import?mode=replace", payload);
      toast(t("imported", { n: result.ingredients }));
      await refreshAll();
      if (state.view === "report") await loadReport();
      if (state.view === "logs") await loadLogs();
      if (state.view === "trash") await loadTrash();
    } catch (error) {
      toast(t("api_error", { msg: error.message }), true);
    } finally {
      event.target.value = "";
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeModal();
      $("#drawer").classList.remove("open");
    }
    if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) {
      event.preventDefault();
      $("#searchInput").focus();
    }
  });

  // 断网/恢复时给个提示（离线时界面还在，因为 Service Worker 缓存了外壳）
  window.addEventListener("offline", () => toast(t("offline"), true));
  window.addEventListener("online", () => toast(t("saved")));
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

async function addShopping() {
  const input = $("#shopName");
  const name = input.value.trim();
  if (!name) return;
  try {
    await jsonPost("/api/shopping", { name });
    input.value = "";
    await loadShopping();
  } catch (error) { toast(t("api_error", { msg: error.message }), true); }
}

/* ---------------- 启动 ---------------- */

async function init() {
  applyStaticText();
  bindEvents();
  try {
    await loadOptions();
    await refreshAll();
  } catch (error) {
    toast(t("api_error", { msg: error.message }), true);
  }
  if (!voiceSupported()) {
    $("#voiceBtn").disabled = true;
    $("#voiceInModal").disabled = true;
    $("#voiceBtn").title = t("voice_unsupported");
  }
}

init();
