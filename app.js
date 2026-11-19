/* ===========================================================
   记账 · 应用逻辑
   数据全部存在本机 IndexedDB，无网络请求（除版本探测）
   -----------------------------------------------------------
   约定：
   1. 金额一律用「分」存整数，任何地方不做浮点累加
   2. 日期用本地日期拼字符串，禁止 toISOString（会跨时区错一天）
   3. 删除是软删（deletedAt），留撤销余地
   =========================================================== */
'use strict';

var APP_VERSION = '1.1.0';

/* ---------------- 常量 ---------------- */
var METHODS = [
  { id: 'wechat', name: '微信' },
  { id: 'alipay', name: '支付宝' },
  { id: 'card', name: '银行卡' },
  { id: 'cash', name: '现金' }
];
var METHOD_NAME = {};
METHODS.forEach(function (m) { METHOD_NAME[m.id] = m.name; });

/* 月付还款渠道：只在分类选「月付」时出现，记为 expense.channel */
var CHANNELS = [
  { id: 'huabei',  name: '花呗',     icon: '🔵' },
  { id: 'douyin',  name: '抖音月付', icon: '🎵' },
  { id: 'meituan', name: '美团月付', icon: '🟡' },
  { id: 'credit',  name: '信用卡',   icon: '💳' },
  { id: 'other',   name: '其他',     icon: '📦' }
];
var CHANNEL_NAME = {};
CHANNELS.forEach(function (c) { CHANNEL_NAME[c.id] = c.name; });

var DEFAULT_CATEGORIES = [
  { id: 'food',      name: '餐饮',   icon: '🍜', color: '#FF9F0A', sort: 1,  archived: false },
  { id: 'transport', name: '交通',   icon: '🚕', color: '#0A84FF', sort: 2,  archived: false },
  { id: 'shopping',  name: '购物',   icon: '🛍️', color: '#FF375F', sort: 3,  archived: false },
  { id: 'home',      name: '居住',   icon: '🏠', color: '#30D158', sort: 4,  archived: false },
  { id: 'utility',   name: '水电煤', icon: '💡', color: '#FFD60A', sort: 5,  archived: false },
  { id: 'telecom',   name: '通讯',   icon: '📱', color: '#5E5CE6', sort: 6,  archived: false },
  { id: 'medical',   name: '医疗',   icon: '💊', color: '#64D2FF', sort: 7,  archived: false },
  { id: 'fun',       name: '娱乐',   icon: '🎮', color: '#BF5AF2', sort: 8,  archived: false },
  { id: 'monthly',   name: '月付',   icon: '💳', color: '#00B8A9', sort: 9,  archived: false },
  { id: 'other',     name: '其他',   icon: '📦', color: '#8E8E93', sort: 10, archived: false }
];

var ICON_CHOICES = ['🍜','🍚','☕','🍺','🚕','🚇','⛽','🛒','🛍️','👕','🏠','💡','💧','📱','💊','🏥','🎮','🎬','🎁','✈️','📚','🐱','💅','🏋️','📦','💳','🎓','🧾'];
var COLOR_CHOICES = ['#FF9F0A','#0A84FF','#FF375F','#30D158','#FFD60A','#5E5CE6','#64D2FF','#BF5AF2','#FF6482','#8E8E93','#00C7BE','#A2845E'];

/* ---------------- 小工具 ---------------- */
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
  });
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/* 本地日期字符串，禁用 toISOString */
function dstr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function mstr(d) { return dstr(d).slice(0, 7); }
function parseDate(s) { var p = String(s).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
function daysIn(ym) { var p = ym.split('-'); return new Date(Number(p[0]), Number(p[1]), 0).getDate(); }
function addMonths(ym, n) {
  var p = ym.split('-');
  var d = new Date(Number(p[0]), Number(p[1]) - 1 + n, 1);
  return dstr(d).slice(0, 7);
}
function monthLabel(ym) { var p = ym.split('-'); return p[0] + '年' + Number(p[1]) + '月'; }

var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function dayTitle(ds) {
  var d = parseDate(ds);
  var t = new Date();
  var today = dstr(t);
  var yest = dstr(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1));
  var pre = ds === today ? '今天 · ' : (ds === yest ? '昨天 · ' : '');
  return pre + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK[d.getDay()];
}
function dayTitleShort(ds) {
  var d = parseDate(ds);
  var t = new Date();
  var today = dstr(t);
  var yest = dstr(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1));
  var pre = ds === today ? '今天 · ' : (ds === yest ? '昨天 · ' : '');
  return pre + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

/* 金额：字符串 -> 分（唯一允许做小数解析的地方） */
function toCents(str) {
  if (!str) return 0;
  var s = String(str).trim();
  if (!/^\d{0,7}(\.\d{0,2})?$/.test(s) || s === '' || s === '.') return 0;
  var parts = s.split('.');
  var yuan = parts[0] ? parseInt(parts[0], 10) : 0;
  var frac = (parts[1] || '').padEnd(2, '0').slice(0, 2);
  var cents = yuan * 100 + (frac ? parseInt(frac, 10) : 0);
  return cents > 0 ? cents : 0;
}

/* 分 -> 带千分位的展示串 */
function yuan(cents) {
  var v = Math.abs(Math.round(cents));
  var y = Math.floor(v / 100);
  var c = v % 100;
  var s = String(y).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (cents < 0 ? '-' : '') + s + '.' + pad2(c);
}
function money(cents) { return '¥' + yuan(cents); }

function hexA(hex, a) {
  var h = String(hex || '#8E8E93').replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  var n = parseInt(h, 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

function catOf(id) {
  for (var i = 0; i < cache.categories.length; i++) if (cache.categories[i].id === id) return cache.categories[i];
  return { id: 'unknown', name: '未分类', icon: '❔', color: '#8E8E93' };
}
function catName(id) { return catOf(id).name; }
function catIcon(id) { return catOf(id).icon; }
function catColor(id) { return catOf(id).color; }

/* ---------------- IndexedDB ---------------- */
var DB_NAME = 'ledger';
var DB_VER = 1;
var db = null;

function openDB() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = function () {
      var d = r.result;
      if (!d.objectStoreNames.contains('expenses')) {
        var s = d.createObjectStore('expenses', { keyPath: 'id' });
        s.createIndex('by_month', 'month');
        s.createIndex('by_date', 'date');
        s.createIndex('by_category', 'categoryId');
      }
      if (!d.objectStoreNames.contains('categories')) d.createObjectStore('categories', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('budgets')) d.createObjectStore('budgets', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('rules')) d.createObjectStore('rules', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = function () { db = r.result; res(db); };
    r.onerror = function () { rej(r.error); };
    r.onblocked = function () { rej(new Error('数据库被其他窗口占用')); };
  });
}

function store(name, mode) { return db.transaction(name, mode).objectStore(name); }
function reqP(r) {
  return new Promise(function (res, rej) {
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
}
function dbAll(n) { return reqP(store(n, 'readonly').getAll()); }
function dbPut(n, v) { return reqP(store(n, 'readwrite').put(v)); }
function dbDel(n, k) { return reqP(store(n, 'readwrite').delete(k)); }
function dbGet(n, k) { return reqP(store(n, 'readonly').get(k)); }
function dbClear(n) { return reqP(store(n, 'readwrite').clear()); }

/* ---------------- 内存缓存 ---------------- */
var cache = {
  raw: [],          // 全部记录（含软删）
  expenses: [],     // 有效记录
  categories: [],
  budgets: {},      // id -> 分
  rules: [],
  settings: {},
  meta: {}
};

async function loadAll() {
  var packs = await Promise.all([dbAll('expenses'), dbAll('categories'), dbAll('budgets'), dbAll('rules'), dbAll('meta')]);
  var ex = packs[0], cats = packs[1], buds = packs[2], rules = packs[3], metas = packs[4];

  cache.raw = ex;
  cache.expenses = ex.filter(function (e) { return !e.deletedAt; });
  cache.categories = cats.sort(function (a, b) { return (a.sort || 0) - (b.sort || 0); });

  cache.budgets = {};
  buds.forEach(function (b) { cache.budgets[b.id] = b.amountCents; });

  cache.rules = rules;

  cache.meta = {};
  metas.forEach(function (m) { cache.meta[m.key] = m.value; });

  cache.settings = Object.assign({ theme: 'auto', lastMethod: 'wechat', lastChannel: null, lastBackupAt: 0 }, cache.meta.settings || {});
}

async function saveSettings() { await dbPut('meta', { key: 'settings', value: cache.settings }); }

async function seedIfNeeded() {
  if (!cache.categories.length) {
    for (var i = 0; i < DEFAULT_CATEGORIES.length; i++) {
      await dbPut('categories', Object.assign({}, DEFAULT_CATEGORIES[i]));
    }
  }
  if (cache.meta.schemaVersion === undefined) {
    await dbPut('meta', { key: 'schemaVersion', value: 1 });
  }
}

/* ---------------- 数据迁移 ---------------- */
/* v2：新增「月付」分类，移除不常用的「人情」。
   有人情历史记录时只停用不删除，否则老账会变成「未分类」。 */
async function migrate() {
  var ver = Number(cache.meta.schemaVersion || 1);

  if (ver < 2) {
    var hasMonthly = cache.categories.some(function (c) { return c.id === 'monthly'; });
    if (!hasMonthly) {
      await dbPut('categories', { id: 'monthly', name: '月付', icon: '💳', color: '#00B8A9', sort: 9, archived: false });
    }

    var gift = null;
    cache.categories.forEach(function (c) { if (c.id === 'gift') gift = c; });
    if (gift) {
      var used = cache.raw.some(function (e) { return e.categoryId === 'gift'; });
      if (used) await dbPut('categories', Object.assign({}, gift, { archived: true, sort: 99 }));
      else await dbDel('categories', 'gift');
    }

    var other = null;
    cache.categories.forEach(function (c) { if (c.id === 'other') other = c; });
    if (other && other.sort !== 10) await dbPut('categories', Object.assign({}, other, { sort: 10 }));

    await dbPut('meta', { key: 'schemaVersion', value: 2 });
  }
}

/* ---------------- 固定支出引擎 ---------------- */
/* 幂等：记录 id 固定为 ruleId_YYYY-MM，put 覆盖，同月不会重复 */
async function runRules() {
  if (!cache.rules.length) return 0;
  var cur = mstr(new Date());
  var ids = {};
  cache.raw.forEach(function (e) { ids[e.id] = true; });
  var created = 0;

  for (var i = 0; i < cache.rules.length; i++) {
    var rule = cache.rules[i];
    var start = rule.lastMonth ? addMonths(rule.lastMonth, 1) : (rule.startMonth || cur);
    if (start > cur) continue;

    var lastDone = null;
    var guard = 0;
    for (var ym = start; ym <= cur && guard < 24; ym = addMonths(ym, 1), guard++) {
      if (rule.endMonth && ym > rule.endMonth) break;
      var id = rule.id + '_' + ym;
      lastDone = ym;
      if (ids[id]) continue;
      var dim = daysIn(ym);
      var day = rule.dayOfMonth === 'end' ? dim : Math.min(Number(rule.dayOfMonth) || 1, dim);
      await dbPut('expenses', {
        id: id,
        amountCents: rule.amountCents,
        categoryId: rule.categoryId,
        method: rule.method || 'wechat',
        date: ym + '-' + pad2(day),
        month: ym,
        ruleId: rule.id,
        note: rule.name || '',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      ids[id] = true;
      created++;
    }
    if (lastDone && rule.lastMonth !== lastDone) {
      rule.lastMonth = lastDone;
      await dbPut('rules', rule);
    }
  }
  if (created) await loadAll();
  return created;
}

/* ---------------- 界面状态 ---------------- */
var state = {
  tab: 'add',
  month: mstr(new Date()),
  draft: { amount: '', categoryId: null, channel: null, method: 'wechat', note: '', date: dstr(new Date()), editingId: null },
  targetDay: null
};

/* ---------------- Toast ---------------- */
var toastTimer = null;
var toastAction = null;

function toast(msg, actionLabel, action) {
  var el = $('#toast');
  $('#toastText').textContent = msg;
  var act = $('#toastAct');
  toastAction = action || null;
  if (action) {
    act.hidden = false;
    act.textContent = actionLabel || '撤销';
  } else {
    act.hidden = true;
  }
  clearTimeout(toastTimer);
  el.hidden = false;
  requestAnimationFrame(function () { el.classList.add('is-on'); });
  toastTimer = setTimeout(dismissToast, action ? 5000 : 2200);
}

function dismissToast() {
  var el = $('#toast');
  clearTimeout(toastTimer);
  el.classList.remove('is-on');
  toastAction = null;
  setTimeout(function () { el.hidden = true; }, 220);
}

$('#toastAct').addEventListener('click', function () {
  var fn = toastAction;
  dismissToast();
  if (fn) fn();
});

/* ---------------- 底部弹层 ---------------- */
var sheetHandlers = {};

function openSheet(title, html, handlers) {
  sheetHandlers = handlers || {};
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = html;
  var mask = $('#sheetMask'), sheet = $('#sheet');
  mask.hidden = false;
  sheet.hidden = false;
  requestAnimationFrame(function () {
    mask.classList.add('is-on');
    sheet.classList.add('is-on');
  });
}

function closeSheet() {
  var mask = $('#sheetMask'), sheet = $('#sheet');
  mask.classList.remove('is-on');
  sheet.classList.remove('is-on');
  sheetHandlers = {};
  setTimeout(function () {
    mask.hidden = true;
    sheet.hidden = true;
    $('#sheetBody').innerHTML = '';
  }, 280);
}

$('#sheetMask').addEventListener('click', closeSheet);
$('#sheetClose').addEventListener('click', closeSheet);

$('#sheetBody').addEventListener('click', function (e) {
  var b = e.target.closest('[data-act]');
  if (!b) return;
  var fn = sheetHandlers[b.dataset.act];
  if (fn) fn(b.dataset, b);
});

/* ---------------- 视图切换 ---------------- */
function setTab(tab) {
  state.tab = tab;
  $$('.view').forEach(function (v) { v.hidden = v.dataset.view !== tab; });
  $$('.tab').forEach(function (b) { b.classList.toggle('is-active', b.dataset.tab === tab); });
  if (tab === 'add') renderAdd();
  if (tab === 'list') renderList();
  if (tab === 'stats') renderStats();
  if (tab === 'settings') renderSettings();
}

$('#tabbar').addEventListener('click', function (e) {
  var b = e.target.closest('.tab');
  if (b) setTab(b.dataset.tab);
});

function renderAll() {
  renderAdd();
  if (state.tab === 'list') renderList();
  if (state.tab === 'stats') renderStats();
  if (state.tab === 'settings') renderSettings();
}

/* ===========================================================
   记账页
   =========================================================== */
function renderAdd() {
  var d = state.draft;

  $('#datePill').textContent = dayTitleShort(d.date);

  var amt = $('#amountText');
  if (d.amount) {
    amt.textContent = d.amount;
    amt.parentNode.classList.remove('is-empty');
  } else {
    amt.textContent = '0.00';
    amt.parentNode.classList.add('is-empty');
  }

  var cats = cache.categories.filter(function (c) { return !c.archived; });
  var grid = $('#catGrid');
  grid.innerHTML = cats.map(function (c) {
    return '<button type="button" class="cat-item' + (d.categoryId === c.id ? ' is-on' : '') + '" data-cat="' + c.id + '">' +
      '<span class="ci-ico" style="background:' + hexA(c.color, 0.16) + '">' + c.icon + '</span>' +
      '<span class="ci-name">' + esc(c.name) + '</span></button>';
  }).join('') || '<div class="empty" style="grid-column:1/-1;padding:18px 0">没有可用分类，去设置里加一个</div>';

  var row = $('#methodRow');
  row.innerHTML = METHODS.map(function (m) {
    return '<button type="button" class="chip' + (d.method === m.id ? ' is-on' : '') + '" data-method="' + m.id + '">' + m.name + '</button>';
  }).join('');

  /* 月付时用「还款渠道」替代「支付方式」：还花呗只能从卡/余额扣，支付方式没有参考价值，
     两者同时出现会把内容撑出屏幕 */
  var chWrap = $('#channelWrap');
  var isMonthly = d.categoryId === 'monthly';
  $('#methodRow').hidden = isMonthly;
  if (isMonthly) {
    chWrap.hidden = false;
    $('#channelRow').innerHTML = '<span class="channel-tag">还款渠道</span>' + CHANNELS.map(function (c) {
      return '<button type="button" class="chip' + (d.channel === c.id ? ' is-on' : '') + '" data-channel="' + c.id + '">' + c.name + '</button>';
    }).join('');
  } else {
    chWrap.hidden = true;
  }

  var noteBtn = $('#noteBtn');
  var noteText = $('#noteText');
  if (d.note) {
    noteText.textContent = d.note;
    noteBtn.classList.add('has-text');
  } else {
    noteText.textContent = '备注（可选）';
    noteBtn.classList.remove('has-text');
  }

  $('#saveBtn').textContent = d.editingId ? '保存修改' : '保存';
  $('#cancelEditBtn').hidden = !d.editingId;

  /* 底部小结：填掉空白，顺便给个本月参照 */
  var ym = mstr(new Date());
  var mSum = 0, mCnt = 0;
  cache.expenses.forEach(function (e) {
    if (e.month === ym) { mSum += e.amountCents; mCnt++; }
  });
  $('#addFoot').innerHTML = mCnt
    ? '本月已记 <b>' + money(mSum) + '</b> · ' + mCnt + ' 笔'
    : '本月还没记录，记下第一笔';
}

function renderAmountOnly() {
  var amt = $('#amountText');
  if (state.draft.amount) {
    amt.textContent = state.draft.amount;
    amt.parentNode.classList.remove('is-empty');
  } else {
    amt.textContent = '0.00';
    amt.parentNode.classList.add('is-empty');
  }
}

$('#catGrid').addEventListener('click', function (e) {
  var b = e.target.closest('[data-cat]');
  if (!b) return;
  state.draft.categoryId = b.dataset.cat;
  $$('.cat-item', $('#catGrid')).forEach(function (x) { x.classList.toggle('is-on', x.dataset.cat === b.dataset.cat); });
  /* 切到月付时，没选过渠道就带上次用过的 */
  if (state.draft.categoryId === 'monthly' && !state.draft.channel) {
    state.draft.channel = cache.settings.lastChannel || null;
  }
  renderAdd();
});

$('#channelRow').addEventListener('click', function (e) {
  var b = e.target.closest('[data-channel]');
  if (!b) return;
  state.draft.channel = b.dataset.channel;
  $$('.chip', $('#channelRow')).forEach(function (x) { x.classList.toggle('is-on', x.dataset.channel === b.dataset.channel); });
});

$('#methodRow').addEventListener('click', function (e) {
  var b = e.target.closest('[data-method]');
  if (!b) return;
  state.draft.method = b.dataset.method;
  $$('.chip', $('#methodRow')).forEach(function (x) { x.classList.toggle('is-on', x.dataset.method === b.dataset.method); });
});

/* 备注：走弹层输入，主界面永不因系统键盘位移 */
$('#noteBtn').addEventListener('click', function () {
  var d = state.draft;
  openSheet('备注',
    '<div class="field"><textarea class="note-area" id="noteArea" maxlength="40" enterkeyhint="done" ' +
    'placeholder="补充说明，比如「和谁、买了什么」，最多 40 字">' + esc(d.note) + '</textarea></div>' +
    '<div class="field-hint"><span id="noteCount">0</span>/40</div>' +
    '<div class="sheet-actions">' +
    '<button type="button" class="btn-primary" data-act="save">确定</button>' +
    (d.note ? '<button type="button" class="btn-plain" data-act="clear">清空备注</button>' : '') +
    '</div>',
    {
      save: function () {
        var v = ($('#noteArea').value || '').trim();
        var ta = $('#noteArea');
        if (ta) ta.blur();
        state.draft.note = v;
        closeSheet();
        renderAdd();
      },
      clear: function () {
        var ta = $('#noteArea');
        if (ta) ta.blur();
        state.draft.note = '';
        closeSheet();
        renderAdd();
      }
    });

  setTimeout(function () {
    var ta = $('#noteArea');
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    var cnt = $('#noteCount');
    var upd = function () { if (cnt) cnt.textContent = ta.value.length; };
    ta.addEventListener('input', upd);
    upd();
  }, 320);
});

/* 键盘 */
function inputKey(k) {
  var d = state.draft;
  var a = d.amount;
  if (k === 'del') {
    d.amount = a.slice(0, -1);
  } else if (k === '.') {
    if (a.indexOf('.') < 0) d.amount = (a || '0') + '.';
  } else {
    if (a.indexOf('.') >= 0) {
      if (a.split('.')[1].length >= 2) return;
      d.amount = a + k;
    } else {
      if (a.replace('.', '').length >= 7) return;
      d.amount = (a === '0') ? k : a + k;
    }
  }
  renderAmountOnly();
}

$('#keys').addEventListener('click', function (e) {
  var b = e.target.closest('.key');
  if (!b) return;
  inputKey(b.dataset.k);
});

/* 长按退格清空 */
var delTimer = null;
$('#keyDel').addEventListener('touchstart', function () {
  delTimer = setTimeout(function () {
    state.draft.amount = '';
    renderAmountOnly();
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (err) {}
  }, 550);
}, { passive: true });
$('#keyDel').addEventListener('touchend', function () { clearTimeout(delTimer); });
$('#keyDel').addEventListener('touchmove', function () { clearTimeout(delTimer); });

/* 日期选择 */
$('#datePill').addEventListener('click', function () {
  var d = state.draft.date;
  var t = new Date();
  var picks = [
    { k: dstr(t), label: '今天' },
    { k: dstr(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1)), label: '昨天' },
    { k: dstr(new Date(t.getFullYear(), t.getMonth(), t.getDate() - 2)), label: '前天' }
  ];
  var html = '<div class="quick-picks">' + picks.map(function (p) {
    return '<button type="button" data-act="pick" data-d="' + p.k + '" class="' + (d === p.k ? 'is-on' : '') + '">' + p.label + '</button>';
  }).join('') + '</div>' +
    '<div class="field"><div class="field-label">其他日期</div>' +
    '<input class="field-input" type="date" id="dateInput" value="' + d + '" max="' + dstr(new Date()) + '"></div>';

  openSheet('选择日期', html, {
    pick: function (ds, el) {
      state.draft.date = ds;
      closeSheet();
      renderAdd();
    }
  });

  setTimeout(function () {
    var inp = $('#dateInput');
    if (inp) inp.addEventListener('change', function () {
      if (this.value) {
        state.draft.date = this.value;
        closeSheet();
        renderAdd();
      }
    });
  }, 60);
});

/* 保存 */
function shakeSave() {
  var b = $('#saveBtn');
  b.classList.remove('is-shake');
  void b.offsetWidth;
  b.classList.add('is-shake');
}

async function saveEntry() {
  var d = state.draft;
  var cents = toCents(d.amount);
  if (!cents) { shakeSave(); toast('先输入金额'); return; }
  if (!d.categoryId) { toast('先选一个分类'); return; }
  if (d.categoryId === 'monthly' && !d.channel) { toast('选一下是哪个渠道还的'); return; }

  var now = Date.now();
  var month = d.date.slice(0, 7);
  var channel = d.categoryId === 'monthly' ? d.channel : null;
  rememberMethod();

  if (d.editingId) {
    var old = null;
    for (var i = 0; i < cache.raw.length; i++) if (cache.raw[i].id === d.editingId) old = cache.raw[i];
    if (!old) { state.draft.editingId = null; toast('这笔找不到了'); return; }
    var rec = Object.assign({}, old, {
      amountCents: cents,
      categoryId: d.categoryId,
      channel: channel,
      method: d.method,
      date: d.date,
      month: month,
      note: (d.note || '').trim(),
      updatedAt: now
    });
    await dbPut('expenses', rec);
    await loadAll();
    state.draft.editingId = null;
    state.draft.amount = '';
    state.draft.note = '';
    state.month = month;
    renderAll();
    toast('已保存修改');
    return;
  }

  var id = 'e' + now + Math.random().toString(36).slice(2, 6);
  var item = {
    id: id,
    amountCents: cents,
    categoryId: d.categoryId,
    channel: channel,
    method: d.method,
    date: d.date,
    month: month,
    note: (d.note || '').trim(),
    createdAt: now,
    updatedAt: now
  };
  await dbPut('expenses', item);
  await loadAll();

  state.draft.amount = '';
  state.draft.note = '';
  state.month = month;
  renderAll();
  checkBackupReminder();

  var label = catName(item.categoryId) + (channel ? ' · ' + (CHANNEL_NAME[channel] || '') : '');
  toast('已记 ' + money(cents) + ' · ' + label, '撤销', async function () {
    await dbDel('expenses', id);
    await loadAll();
    renderAll();
    toast('已撤销');
  });
}

$('#saveBtn').addEventListener('click', saveEntry);

$('#cancelEditBtn').addEventListener('click', function () {
  state.draft.editingId = null;
  state.draft.amount = '';
  state.draft.note = '';
  renderAdd();
});

/* ===========================================================
   明细页
   =========================================================== */
function rowHTML(e) {
  var c = catOf(e.categoryId);
  var parts = [];
  if (e.categoryId === 'monthly') {
    parts.push(e.channel ? (CHANNEL_NAME[e.channel] || '其他') : '未分渠道');
  } else if (METHOD_NAME[e.method]) {
    parts.push(METHOD_NAME[e.method]);
  }
  if (e.note) parts.push(e.note);
  var sub = parts.join(' · ');
  return '<div class="row-wrap" data-id="' + e.id + '">' +
    '<button type="button" class="row-del" data-del="' + e.id + '">删除</button>' +
    '<div class="exp-row" data-row="' + e.id + '">' +
      '<span class="exp-icon" style="background:' + hexA(c.color, 0.16) + '">' + c.icon + '</span>' +
      '<span class="exp-main">' +
        '<span class="exp-title">' + esc(c.name) + '</span>' +
        (sub ? '<span class="exp-sub">' + esc(sub) + '</span>' : '') +
      '</span>' +
      '<span class="exp-amt">' + money(e.amountCents) + (e.ruleId ? '<i class="fix-mark">固</i>' : '') + '</span>' +
    '</div></div>';
}

function emptyHTML(ico, t, s) {
  return '<div class="empty"><div class="em-ico">' + ico + '</div><div class="em-t">' + esc(t) + '</div>' +
    (s ? '<div class="em-s">' + esc(s) + '</div>' : '') + '</div>';
}

function monthItems(ym) {
  return cache.expenses.filter(function (e) { return e.month === ym; })
    .sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });
}

function renderList() {
  var ym = state.month;
  $('#listMonthLabel').textContent = monthLabel(ym);

  var items = monthItems(ym);
  var total = items.reduce(function (s, e) { return s + e.amountCents; }, 0);
  $('#listMonthTotal').textContent = money(total);
  $('#listMonthCount').textContent = items.length + ' 笔';

  var body = $('#listBody');
  if (!items.length) {
    body.innerHTML = emptyHTML('🗒️', '这个月还没有记录', '点底部「记账」加第一笔');
    return;
  }

  var groups = {};
  var order = [];
  items.forEach(function (e) {
    if (!groups[e.date]) { groups[e.date] = []; order.push(e.date); }
    groups[e.date].push(e);
  });

  body.innerHTML = order.map(function (ds) {
    var arr = groups[ds];
    var sum = arr.reduce(function (s, e) { return s + e.amountCents; }, 0);
    return '<div class="day-group" data-day="' + ds + '">' +
      '<div class="day-head"><span>' + dayTitle(ds) + '</span><span class="dh-sum">' + money(sum) + '</span></div>' +
      arr.map(rowHTML).join('') + '</div>';
  }).join('');

  if (state.targetDay) {
    var target = state.targetDay;
    state.targetDay = null;
    setTimeout(function () {
      var el = body.querySelector('.day-group[data-day="' + target + '"]');
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('is-target');
        setTimeout(function () { el.classList.remove('is-target'); }, 1600);
      }
    }, 30);
  }
}

/* 左滑删除 */
var sw = null;
var openRowId = null;

$('#listBody').addEventListener('touchstart', function (e) {
  var row = e.target.closest('.exp-row');
  if (!row || e.target.closest('[data-del]')) { sw = null; return; }
  var t = e.touches[0];
  sw = {
    row: row,
    id: row.dataset.row,
    x0: t.clientX,
    y0: t.clientY,
    dx: 0,
    axis: null,
    base: row.classList.contains('is-open') ? -84 : 0
  };
}, { passive: true });

$('#listBody').addEventListener('touchmove', function (e) {
  if (!sw) return;
  var t = e.touches[0];
  var dx = t.clientX - sw.x0;
  var dy = t.clientY - sw.y0;
  if (!sw.axis) {
    if (Math.abs(dx) < 7 && Math.abs(dy) < 7) return;
    sw.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (sw.axis === 'x') sw.row.classList.add('is-dragging');
  }
  if (sw.axis !== 'x') return;
  e.preventDefault();
  sw.row.parentNode.classList.add('is-dragging-wrap');
  var off = Math.max(-92, Math.min(0, sw.base + dx));
  sw.dx = off;
  sw.row.style.transform = 'translateX(' + off + 'px)';
}, { passive: false });

$('#listBody').addEventListener('touchend', function () {
  if (!sw) return;
  var row = sw.row, off = sw.dx, moved = sw.axis === 'x';
  var wrap = row.parentNode;
  row.classList.remove('is-dragging');
  wrap.classList.remove('is-dragging-wrap');
  if (moved) {
    if (off < -42) {
      row.style.transform = 'translateX(-84px)';
      row.classList.add('is-open');
      wrap.classList.add('is-open');
      openRowId = sw.id;
    } else {
      row.style.transform = '';
      row.classList.remove('is-open');
      wrap.classList.remove('is-open');
      if (openRowId === sw.id) openRowId = null;
    }
    $('#listBody').dataset.suppress = '1';
    setTimeout(function () { delete $('#listBody').dataset.suppress; }, 90);
  }
  sw = null;
});

$('#listBody').addEventListener('click', function (e) {
  var delBtn = e.target.closest('[data-del]');
  if (delBtn) { softDelete(delBtn.dataset.del); return; }
  if (this.dataset.suppress) return;
  var row = e.target.closest('.exp-row');
  if (!row) return;
  if (row.classList.contains('is-open')) {
    row.style.transform = '';
    row.classList.remove('is-open');
    row.parentNode.classList.remove('is-open');
    openRowId = null;
    return;
  }
  openEdit(row.dataset.row);
});

async function softDelete(id) {
  var rec = null;
  for (var i = 0; i < cache.raw.length; i++) if (cache.raw[i].id === id) rec = cache.raw[i];
  if (!rec) return;
  var backup = Object.assign({}, rec);
  await dbPut('expenses', Object.assign({}, rec, { deletedAt: Date.now(), updatedAt: Date.now() }));
  await loadAll();
  renderAll();
  toast('已删除', '撤销', async function () {
    await dbPut('expenses', backup);
    await loadAll();
    renderAll();
  });
}

function openEdit(id) {
  var rec = null;
  for (var i = 0; i < cache.raw.length; i++) if (cache.raw[i].id === id) rec = cache.raw[i];
  if (!rec) { toast('这笔找不到了'); return; }
  var d = state.draft;
  d.editingId = rec.id;
  d.date = rec.date;
  d.categoryId = rec.categoryId;
  d.channel = rec.channel || null;
  d.method = rec.method || 'wechat';
  d.note = rec.note || '';
  d.amount = (rec.amountCents / 100).toFixed(2).replace(/\.00$/, '');
  setTab('add');
  renderAdd();
}

/* 月份切换（明细 + 统计共用） */
$$('.mnav').forEach(function (b) {
  b.addEventListener('click', function () {
    state.month = addMonths(state.month, Number(b.dataset.mstep));
    if (state.tab === 'list') renderList();
    if (state.tab === 'stats') renderStats();
  });
});

/* ===========================================================
   统计页
   =========================================================== */
function donutSVG(segs, total, size) {
  var r = size / 2 - 9;
  var cx = size / 2, cy = size / 2;
  var C = 2 * Math.PI * r;
  var acc = 0;
  var arcs = segs.map(function (s) {
    var len = total ? (s.value / total) * C : 0;
    var el = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + s.color +
      '" stroke-width="17" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) +
      '" stroke-dashoffset="' + (-acc).toFixed(2) + '" transform="rotate(-90 ' + cx + ' ' + cy + ')"></circle>';
    acc += len;
    return el;
  }).join('');

  return '<svg class="donut" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="分类占比">' +
    '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="var(--card-2)" stroke-width="17"></circle>' +
    arcs + '</svg>';
}

function dayBarsSVG(vals, dim) {
  var slot = 10;
  var W = dim * slot;
  var barH = 44;
  var H = barH + 14;
  var max = 1;
  vals.forEach(function (v) { if (v > max) max = v; });

  var bars = vals.map(function (v, i) {
    /* 开方缩放：房租这类极值不会把日常支出压成一条线，仍保留量级差异 */
    var h = max > 0 ? Math.round(Math.sqrt(v / max) * barH) : 0;
    return '<rect class="bar' + (v === max && v > 0 ? ' is-peak' : '') + '" x="' + (i * slot + 2) + '" y="' + (barH - h) +
      '" width="' + (slot - 4) + '" height="' + Math.max(h, v > 0 ? 2 : 1) + '" rx="2"></rect>';
  }).join('');

  var labels = [1, 10, 20, dim].filter(function (d, i, arr) { return d >= 1 && d <= dim && arr.indexOf(d) === i; })
    .map(function (d) {
      return '<text class="lbl" x="' + ((d - 1) * slot + slot / 2) + '" y="' + (H - 1) + '" text-anchor="middle">' + d + '</text>';
    }).join('');

  var hits = vals.map(function (v, i) {
    if (!v) return '';
    return '<rect class="hit" data-day="' + (i + 1) + '" x="' + (i * slot) + '" y="0" width="' + slot + '" height="' + barH + '"></rect>';
  }).join('');

  return '<svg class="daybars" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="每日支出">' +
    bars + hits + '<line class="axis" x1="0" y1="' + (barH + 0.5) + '" x2="' + W + '" y2="' + (barH + 0.5) + '"></line>' +
    labels + '</svg>';
}

function renderStats() {
  var ym = state.month;
  var cur = mstr(new Date());
  $('#statsMonthLabel').textContent = monthLabel(ym);
  $('#statsMonthHint').textContent = ym === cur ? '本月' : (ym > cur ? '未来' : '往月');

  var items = monthItems(ym);
  var total = items.reduce(function (s, e) { return s + e.amountCents; }, 0);
  var prevYm = addMonths(ym, -1);
  var prevTotal = cache.expenses.filter(function (e) { return e.month === prevYm; })
    .reduce(function (s, e) { return s + e.amountCents; }, 0);

  var dim = daysIn(ym);
  var passed = ym === cur ? new Date().getDate() : (ym > cur ? 0 : dim);
  var avg = passed ? Math.round(total / passed) : 0;

  /* 总览 */
  var cmp = '';
  if (prevTotal > 0) {
    var pct = Math.round(((total - prevTotal) / prevTotal) * 100);
    var cls = pct > 0 ? 'up' : (pct < 0 ? 'down' : 'flat');
    var arrow = pct > 0 ? '↑' : (pct < 0 ? '↓' : '—');
    cmp = '<span class="' + cls + '">' + arrow + ' ' + Math.abs(pct) + '%<span style="color:var(--sub);font-weight:400"> 较上月</span></span>';
  } else {
    cmp = '<span class="flat">上月无记录</span>';
  }

  var html = '<div class="stat-hero">' +
    '<div class="sh-label">' + monthLabel(ym) + ' 支出合计</div>' +
    '<div class="sh-value">' + money(total) + '</div>' +
    '<div class="sh-meta">' +
      '<span>日均 <b>' + money(avg) + '</b></span>' +
      '<span>笔数 <b>' + items.length + '</b></span>' +
    '</div>' +
    '<div class="sh-meta" style="margin-top:6px"><span>' + cmp + '</span></div>' +
    '</div>';

  /* 预算 */
  var budget = cache.budgets['total:' + ym] || 0;
  if (budget > 0) {
    var p = Math.min(100, (total / budget) * 100);
    var over = total > budget;
    html += '<div class="card">' +
      '<div class="card-head"><span class="card-title">本月预算</span><span class="card-sub">' + money(budget) + '</span></div>' +
      '<div class="bar-track"><div class="bar-fill' + (over ? ' is-over' : '') + '" style="width:' + p.toFixed(1) + '%"></div></div>' +
      '<div class="budget-line"><span>' + (over ? '已超支 <b style="color:var(--red)">' + money(total - budget) + '</b>' : '剩余 ' + money(budget - total)) + '</span>' +
      '<span>' + Math.round((total / budget) * 100) + '%</span></div></div>';
  } else {
    html += '<div class="card"><div class="card-head"><span class="card-title">本月预算</span></div>' +
      '<div class="budget-empty">还没设置预算 · 去「设置 → 月度预算」定个数</div></div>';
  }

  if (!items.length) {
    html += emptyHTML('📊', '这个月还没有数据', '记几笔之后这里会出现图表');
    $('#statsBody').innerHTML = html;
    return;
  }

  /* 月付还款：按渠道拆开，月初最关心的就是这张卡 */
  var mPay = items.filter(function (e) { return e.categoryId === 'monthly'; });
  if (mPay.length) {
    var mPrev = cache.expenses.filter(function (e) {
      return e.month === addMonths(ym, -1) && e.categoryId === 'monthly';
    });
    var byCh = {};
    var chOrder = [];
    mPay.forEach(function (e) {
      var k = e.channel || 'none';
      if (!byCh[k]) { byCh[k] = 0; chOrder.push(k); }
      byCh[k] += e.amountCents;
    });
    var prevByCh = {};
    mPrev.forEach(function (e) {
      var k = e.channel || 'none';
      prevByCh[k] = (prevByCh[k] || 0) + e.amountCents;
    });
    var mTotal = mPay.reduce(function (s, e) { return s + e.amountCents; }, 0);
    var mPrevTotal = mPrev.reduce(function (s, e) { return s + e.amountCents; }, 0);

    var mHead = mTotal > 0 ? '合计 ' + money(mTotal) : '';
    var mCmp = '';
    if (mPrevTotal > 0) {
      var dp = Math.round(((mTotal - mPrevTotal) / mPrevTotal) * 100);
      var dcls = dp > 0 ? 'up' : (dp < 0 ? 'down' : 'flat');
      mCmp = '<span class="' + dcls + '">' + (dp > 0 ? '↑' : (dp < 0 ? '↓' : '—')) + ' ' + Math.abs(dp) + '%<span style="color:var(--sub);font-weight:400"> 较上月</span></span>';
    }

    var rows = chOrder.sort(function (a, b) { return byCh[b] - byCh[a]; }).map(function (k) {
      var nm = k === 'none' ? '未分渠道' : (CHANNEL_NAME[k] || '其他');
      var pct = mTotal ? (byCh[k] / mTotal) * 100 : 0;
      var delta = '';
      if (prevByCh[k] !== undefined) {
        var dd = byCh[k] - prevByCh[k];
        if (dd !== 0) {
          delta = '<span class="' + (dd > 0 ? 'up' : 'down') + '">' + (dd > 0 ? '↑' : '↓') + money(Math.abs(dd)) + '</span>';
        }
      }
      return '<div class="ch-row">' +
        '<span class="ch-name">' + esc(nm) + '</span>' +
        '<span><span class="ch-amt">' + money(byCh[k]) + '</span>' +
        '<span class="ch-pct">' + Math.round(pct) + '%</span>' +
        (delta ? '<span class="ch-pct">' + delta + '</span>' : '') + '</span>' +
        '</div>' +
        '<div class="ch-bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>';
    }).join('');

    html += '<div class="card">' +
      '<div class="card-head"><span class="card-title">月付还款 · 按渠道</span><span class="card-sub">' + mHead + '</span></div>' +
      (mCmp ? '<div class="budget-line" style="margin:-4px 0 6px"><span></span><span>' + mCmp + '</span></div>' : '') +
      rows + '</div>';
  }

  /* 分类汇总 */
  var byCat = {};
  var catOrder = [];
  items.forEach(function (e) {
    var k = e.categoryId;
    if (!byCat[k]) { byCat[k] = 0; catOrder.push(k); }
    byCat[k] += e.amountCents;
  });
  var segs = catOrder.map(function (k) { return { id: k, value: byCat[k], color: catColor(k) }; })
    .sort(function (a, b) { return b.value - a.value; });

  var top5 = segs.slice(0, 5);
  html += '<div class="card"><div class="card-head"><span class="card-title">花在哪儿了</span><span class="card-sub">共 ' + segs.length + ' 类</span></div>' +
    '<div class="donut-wrap">' + donutSVG(segs, total, 118) +
    '<div class="donut-legend">' + top5.map(function (s) {
      return '<div class="lg-row"><span class="lg-dot" style="background:' + s.color + '"></span>' +
        '<span class="lg-name">' + esc(catName(s.id)) + '</span>' +
        '<span class="lg-num">' + Math.round((s.value / total) * 100) + '%</span></div>';
    }).join('') + '</div></div></div>';

  /* 分类排行条 */
  html += '<div class="card"><div class="card-head"><span class="card-title">分类明细</span></div>';
  segs.forEach(function (s) {
    var cb = cache.budgets['cat:' + s.id + ':' + ym] || 0;
    var overC = cb > 0 && s.value > cb;
    html += '<div class="cat-rank-row">' +
      '<div class="crr-top"><span class="crr-name"><span class="crr-ico">' + catIcon(s.id) + '</span>' + esc(catName(s.id)) +
      (overC ? '<span class="over-tag">超预算</span>' : '') + '</span>' +
      '<span><span class="crr-amt">' + money(s.value) + '</span><span class="crr-pct">' + Math.round((s.value / total) * 100) + '%</span></span></div>' +
      '<div class="crr-track"><div class="crr-fill" style="width:' + ((s.value / total) * 100).toFixed(1) + '%;background:' + s.color + '"></div></div>' +
      '</div>';
  });
  html += '</div>';

  /* 按天 */
  var byDay = [];
  for (var i = 1; i <= dim; i++) byDay.push(0);
  items.forEach(function (e) {
    var dd = Number(e.date.slice(8, 10));
    if (dd >= 1 && dd <= dim) byDay[dd - 1] += e.amountCents;
  });
  html += '<div class="card"><div class="card-head"><span class="card-title">每日支出</span><span class="card-sub">最高 ' + money(Math.max.apply(null, byDay)) + '</span></div>' +
    dayBarsSVG(byDay, dim) + '</div>';

  /* Top 5 */
  var sorted = items.slice().sort(function (a, b) { return b.amountCents - a.amountCents; });
  html += '<div class="card"><div class="card-head"><span class="card-title">最大几笔</span></div>' +
    sorted.slice(0, 5).map(function (e, idx) {
      return '<div class="top-row"><span class="top-idx">' + (idx + 1) + '</span>' +
        '<span class="top-main"><span class="top-t">' + esc(catName(e.categoryId)) + (e.note ? ' · ' + esc(e.note) : '') + '</span>' +
        '<span class="top-s">' + esc(dayTitle(e.date)) + '</span></span>' +
        '<span class="top-a">' + money(e.amountCents) + '</span></div>';
    }).join('') +
    (sorted.length > 5 ? '<button type="button" class="more-btn" data-golist="1">查看全部 ' + sorted.length + ' 笔明细</button>' : '') +
    '</div>';

  $('#statsBody').innerHTML = html;
}

$('#statsBody').addEventListener('click', function (e) {
  if (e.target.closest('[data-golist]')) { setTab('list'); return; }
  var hit = e.target.closest('[data-day]');
  if (hit) jumpToDay(state.month + '-' + pad2(Number(hit.dataset.day)));
});

function jumpToDay(ds) {
  state.month = ds.slice(0, 7);
  state.targetDay = ds;
  setTab('list');
}

/* ===========================================================
   设置页
   =========================================================== */
function groupCard(title, rows) {
  return '<div class="group"><div class="group-title">' + esc(title) + '</div>' +
    '<div class="group-card">' + rows.join('') + '</div></div>';
}

function setRow(ico, label, value, act, extraCls) {
  return '<button type="button" class="set-row' + (extraCls ? ' ' + extraCls : '') + '" data-set="' + act + '">' +
    '<span class="sr-ico">' + ico + '</span>' +
    '<span class="sr-label">' + esc(label) + '</span>' +
    (value ? '<span class="sr-value">' + esc(value) + '</span>' : '') +
    '<span class="sr-arrow">›</span></button>';
}

function themeName() {
  var t = cache.settings.theme || 'auto';
  return t === 'light' ? '浅色' : (t === 'dark' ? '深色' : '跟随系统');
}

function sinceText(ts) {
  var days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  return days + ' 天前';
}

function renderSettings() {
  var curMonth = mstr(new Date());
  var bud = cache.budgets['total:' + curMonth] || 0;
  var lastB = cache.settings.lastBackupAt || 0;
  var activeCats = cache.categories.filter(function (c) { return !c.archived; }).length;

  var html = '<div class="set-hero">' +
    '<img src="icons/icon-180.png" alt="记账">' +
    '<div><div class="sh-t">记账</div><div class="sh-s">只记支出 · 数据保存在本机</div></div>' +
    '</div>';

  html += groupCard('记账设置', [
    setRow('📂', '分类管理', activeCats + ' 个', 'cats'),
    setRow('🎯', '月度预算', bud > 0 ? money(bud) : '未设置', 'budget'),
    setRow('🔁', '固定支出', cache.rules.length ? cache.rules.length + ' 条规则' : '未设置', 'rules'),
    setRow('🎨', '外观', themeName(), 'theme')
  ]);

  html += groupCard('数据', [
    setRow('📤', '导出 CSV', '给 Excel 看', 'csv'),
    setRow('💾', '备份全部数据', lastB ? sinceText(lastB) : '从未备份', 'backup'),
    setRow('📥', '从备份恢复', '', 'restore'),
    setRow('🩺', '数据自检', '', 'check')
  ]);

  html += groupCard('危险操作', [
    setRow('🗑️', '清空全部数据', '', 'wipe', 'is-danger')
  ]);

  html += '<div class="set-foot">已记录 ' + cache.expenses.length + ' 笔 · 版本 ' + APP_VERSION +
    '<br>数据只保存在这台手机上，换手机或删除主屏图标会丢失' +
    '<br>建议每月导出一次备份</div>';

  $('#settingsBody').innerHTML = html;
}

$('#settingsBody').addEventListener('click', function (e) {
  var b = e.target.closest('[data-set]');
  if (!b) return;
  var act = b.dataset.set;
  if (act === 'cats') openCatsSheet();
  if (act === 'budget') openBudgetSheet();
  if (act === 'rules') openRulesSheet();
  if (act === 'theme') openThemeSheet();
  if (act === 'csv') exportCSV();
  if (act === 'backup') exportBackup();
  if (act === 'restore') openRestoreSheet();
  if (act === 'check') runSelfCheck();
  if (act === 'wipe') openWipeSheet();
});

/* ---------- 分类管理 ---------- */
function openCatsSheet() {
  var list = cache.categories.map(function (c) {
    var used = cache.raw.some(function (e) { return e.categoryId === c.id; });
    return '<button type="button" class="lite-row" data-act="edit" data-cid="' + c.id + '">' +
      '<span style="font-size:17px">' + c.icon + '</span>' +
      '<span class="lr-name">' + esc(c.name) + (c.archived ? ' <span style="font-size:11px;color:var(--sub)">已停用</span>' : '') + '</span>' +
      '<span class="lr-val">' + (used ? '有记录' : '未使用') + '</span>' +
      '<span class="sr-arrow">›</span></button>';
  }).join('');

  openSheet('分类管理',
    '<div class="list-lite">' + list + '</div>' +
    '<button type="button" class="btn-plain" data-act="add">+ 新增分类</button>',
    {
      add: function () { openCatEditor(null); },
      edit: function (ds) { openCatEditor(ds.cid); }
    });
}

var catEditor = { id: null, icon: '🍜', color: '#FF9F0A' };

function openCatEditor(cid) {
  var c = null;
  if (cid) for (var i = 0; i < cache.categories.length; i++) if (cache.categories[i].id === cid) c = cache.categories[i];
  catEditor = {
    id: c ? c.id : null,
    icon: c ? c.icon : '🍜',
    color: c ? c.color : '#FF9F0A'
  };
  var name = c ? c.name : '';
  var used = c ? cache.raw.some(function (e) { return e.categoryId === c.id; }) : false;

  var html = '<div class="field"><div class="field-label">名称</div>' +
    '<input class="field-input" id="catName" maxlength="6" value="' + esc(name) + '" placeholder="如：早餐"></div>' +
    '<div class="field"><div class="field-label">图标</div><div class="pick-grid">' +
    ICON_CHOICES.map(function (ic) {
      return '<button type="button" class="pick-item' + (ic === catEditor.icon ? ' is-on' : '') + '" data-act="pickIcon" data-v="' + ic + '">' + ic + '</button>';
    }).join('') + '</div></div>' +
    '<div class="field"><div class="field-label">颜色</div><div class="color-grid">' +
    COLOR_CHOICES.map(function (cl) {
      return '<button type="button" class="color-dot' + (cl === catEditor.color ? ' is-on' : '') + '" data-act="pickColor" data-v="' + cl + '" style="background:' + cl + '"></button>';
    }).join('') + '</div></div>' +
    '<button type="button" class="btn-primary" data-act="save">' + (c ? '保存' : '创建') + '</button>' +
    (c ? (used
      ? '<button type="button" class="btn-plain" data-act="archive">' + (c.archived ? '恢复启用' : '停用（保留历史记录）') + '</button>'
      : '<button type="button" class="btn-danger" data-act="del">删除这个分类</button>') : '');

  openSheet(c ? '编辑分类' : '新增分类', html, {
    pickIcon: function (ds, el) {
      catEditor.icon = ds.v;
      $$('.pick-item', $('#sheetBody')).forEach(function (x) { x.classList.toggle('is-on', x.dataset.v === ds.v); });
    },
    pickColor: function (ds, el) {
      catEditor.color = ds.v;
      $$('.color-dot', $('#sheetBody')).forEach(function (x) { x.classList.toggle('is-on', x.dataset.v === ds.v); });
    },
    save: async function () {
      var nm = ($('#catName').value || '').trim();
      if (!nm) { toast('给分类起个名字'); return; }
      if (catEditor.id) {
        var cur = null;
        for (var i = 0; i < cache.categories.length; i++) if (cache.categories[i].id === catEditor.id) cur = cache.categories[i];
        if (cur) await dbPut('categories', Object.assign({}, cur, { name: nm, icon: catEditor.icon, color: catEditor.color }));
      } else {
        var id = 'c' + Date.now().toString(36);
        var sort = cache.categories.length ? Math.max.apply(null, cache.categories.map(function (x) { return x.sort || 0; })) + 1 : 1;
        await dbPut('categories', { id: id, name: nm, icon: catEditor.icon, color: catEditor.color, sort: sort, archived: false });
      }
      await loadAll();
      renderAll();
      openCatsSheet();
      toast('已保存');
    },
    archive: async function () {
      var cur2 = null;
      for (var j = 0; j < cache.categories.length; j++) if (cache.categories[j].id === catEditor.id) cur2 = cache.categories[j];
      if (!cur2) return;
      await dbPut('categories', Object.assign({}, cur2, { archived: !cur2.archived }));
      await loadAll();
      renderAll();
      openCatsSheet();
      toast(cur2.archived ? '已恢复' : '已停用');
    },
    del: async function () {
      if (!catEditor.id) return;
      await dbDel('categories', catEditor.id);
      await loadAll();
      renderAll();
      openCatsSheet();
      toast('已删除');
    }
  });
}

/* ---------- 预算 ---------- */
function openBudgetSheet() {
  var ym = mstr(new Date());
  var total = cache.budgets['total:' + ym] || 0;
  var cats = cache.categories.filter(function (c) { return !c.archived; });

  var html = '<div class="field"><div class="field-label">' + monthLabel(ym) + ' 总预算</div>' +
    '<input class="field-input" id="budTotal" inputmode="decimal" placeholder="例如 6000" value="' + (total ? (total / 100).toFixed(2) : '') + '">' +
    '<div class="field-hint">留空表示不设预算。预算只用于统计页的进度提醒，不影响记账。</div></div>' +
    '<div class="field"><div class="field-label">分类预算（可选）</div>' +
    '<div class="list-lite" style="padding:0 12px;background:var(--card)">' +
    cats.map(function (c) {
      var v = cache.budgets['cat:' + c.id + ':' + ym] || 0;
      return '<div class="lite-row" style="border-bottom:1px solid var(--line)">' +
        '<span style="font-size:16px">' + c.icon + '</span>' +
        '<span class="lr-name">' + esc(c.name) + '</span>' +
        '<input class="field-input" style="width:104px;padding:7px 10px;text-align:right;font-size:14px" data-cbud="' + c.id + '" inputmode="decimal" placeholder="不限" value="' + (v ? (v / 100).toFixed(2) : '') + '">' +
        '</div>';
    }).join('') + '</div></div>' +
    '<div class="sheet-actions">' +
    '<button type="button" class="btn-primary" data-act="save">保存预算</button>' +
    '<button type="button" class="btn-plain" data-act="copy">沿用上月预算</button>' +
    '</div>';

  openSheet('月度预算', html, {
    copy: async function () {
      var prev = addMonths(ym, -1);
      var t = cache.budgets['total:' + prev] || 0;
      if (t) $('#budTotal').value = (t / 100).toFixed(2);
      cats.forEach(function (c) {
        var v = cache.budgets['cat:' + c.id + ':' + prev] || 0;
        var inp = $('[data-cbud="' + c.id + '"]');
        if (inp) inp.value = v ? (v / 100).toFixed(2) : '';
      });
      toast('已带入上月数值，确认后保存');
    },
    save: async function () {
      var tCents = toCents($('#budTotal').value);
      if (tCents > 0) await dbPut('budgets', { id: 'total:' + ym, amountCents: tCents });
      else await dbDel('budgets', 'total:' + ym);

      for (var i = 0; i < cats.length; i++) {
        var c = cats[i];
        var inp = $('[data-cbud="' + c.id + '"]');
        var v = inp ? toCents(inp.value) : 0;
        if (v > 0) await dbPut('budgets', { id: 'cat:' + c.id + ':' + ym, amountCents: v });
        else await dbDel('budgets', 'cat:' + c.id + ':' + ym);
      }
      await loadAll();
      renderAll();
      closeSheet();
      toast('预算已保存');
    }
  });
}

/* ---------- 固定支出 ---------- */
function openRulesSheet() {
  var list = cache.rules.length ? cache.rules.map(function (r) {
    return '<button type="button" class="lite-row" data-act="edit" data-rid="' + r.id + '">' +
      '<span style="font-size:17px">' + catIcon(r.categoryId) + '</span>' +
      '<span class="lr-name">' + esc(r.name || catName(r.categoryId)) +
      '<span style="font-size:11px;color:var(--sub)"> · 每月' + (r.dayOfMonth === 'end' ? '末' : r.dayOfMonth + '号') + '</span></span>' +
      '<span class="lr-val">' + money(r.amountCents) + '</span>' +
      '<span class="sr-arrow">›</span></button>';
  }).join('') : '<div style="padding:22px 12px;text-align:center;color:var(--sub);font-size:13px">还没有固定支出<br><span style="font-size:11.5px">房租、水电、宽带这类每月都一样的，设一条就不用天天记</span></div>';

  openSheet('固定支出',
    '<div class="list-lite">' + list + '</div>' +
    '<button type="button" class="btn-plain" data-act="add">+ 新增固定支出</button>' +
    '<div class="field-hint">规则只影响之后要生成的账。修改或删除规则，已经生成的记录不会被改动。</div>',
    {
      add: function () { openRuleEditor(null); },
      edit: function (ds) { openRuleEditor(ds.rid); }
    });
}

function monthOptions(selected) {
  var cur = mstr(new Date());
  var out = [];
  for (var k = -36; k <= 12; k++) {
    var ym = addMonths(cur, k);
    out.push('<option value="' + ym + '"' + (ym === selected ? ' selected' : '') + '>' + monthLabel(ym) + '</option>');
  }
  return out.join('');
}

function openRuleEditor(rid) {
  var r = null;
  if (rid) for (var i = 0; i < cache.rules.length; i++) if (cache.rules[i].id === rid) r = cache.rules[i];
  var cats = cache.categories.filter(function (c) { return !c.archived; });
  var cur = mstr(new Date());

  var html = '<div class="field"><div class="field-label">名称</div>' +
    '<input class="field-input" id="rName" maxlength="12" value="' + esc(r ? r.name : '') + '" placeholder="如：房租、宽带"></div>' +
    '<div class="field"><div class="field-label">金额</div>' +
    '<input class="field-input" id="rAmount" inputmode="decimal" placeholder="0.00" value="' + (r ? (r.amountCents / 100).toFixed(2) : '') + '"></div>' +
    '<div class="field"><div class="field-label">分类</div><div class="chip-row" id="rCats">' +
    cats.map(function (c) {
      var on = r ? c.id === r.categoryId : false;
      return '<button type="button" class="chip' + (on ? ' is-on' : '') + '" data-rcat="' + c.id + '">' + c.icon + ' ' + esc(c.name) + '</button>';
    }).join('') + '</div></div>' +
    '<div class="field"><div class="field-label">每月几号</div>' +
    '<input class="field-input" id="rDay" inputmode="numeric" placeholder="1-28，填 0 表示月末" value="' + (r ? (r.dayOfMonth === 'end' ? '0' : r.dayOfMonth) : '1') + '">' +
    '<div class="field-hint">填 29-31 遇到小月会自动落到当月最后一天。</div></div>' +
    '<div class="field"><div class="field-label">开始月份</div>' +
    '<select class="field-input" id="rStart">' + monthOptions(r ? r.startMonth : cur) + '</select></div>' +
    '<div class="sheet-actions">' +
    '<button type="button" class="btn-primary" data-act="save">' + (r ? '保存规则' : '创建规则') + '</button>' +
    (r ? '<button type="button" class="btn-danger" data-act="del">删除规则</button>' : '') +
    '</div>';

  openSheet(r ? '编辑固定支出' : '新增固定支出', html, {
    save: async function () {
      var nm = ($('#rName').value || '').trim();
      var amt = toCents($('#rAmount').value);
      var day = parseInt($('#rDay').value, 10);
      var catSel = $('#rCats .chip.is-on');
      if (!nm) { toast('给这条起个名字'); return; }
      if (!amt) { toast('填个金额'); return; }
      if (!catSel) { toast('选个分类'); return; }
      if (isNaN(day) || day < 0 || day > 31) { toast('日期填 0-31'); return; }

      var rec = {
        id: r ? r.id : 'r' + Date.now().toString(36),
        name: nm,
        amountCents: amt,
        categoryId: catSel.dataset.rcat,
        method: r ? (r.method || 'wechat') : (cache.settings.lastMethod || 'wechat'),
        dayOfMonth: day === 0 ? 'end' : day,
        startMonth: $('#rStart').value,
        endMonth: null,
        lastMonth: r ? r.lastMonth : null
      };
      await dbPut('rules', rec);
      await loadAll();
      var n = await runRules();
      await loadAll();
      renderAll();
      openRulesSheet();
      toast(n ? '已生成 ' + n + ' 条记录' : '规则已保存');
    },
    del: async function () {
      if (!r) return;
      await dbDel('rules', r.id);
      await loadAll();
      renderAll();
      openRulesSheet();
      toast('规则已删除，已生成的记录保留');
    }
  });

  $('#rCats').addEventListener('click', function (e) {
    var b = e.target.closest('[data-rcat]');
    if (!b) return;
    $$('.chip', this).forEach(function (x) { x.classList.toggle('is-on', x === b); });
  });
}

/* ---------- 外观 ---------- */
function openThemeSheet() {
  var cur = cache.settings.theme || 'auto';
  var opts = [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']];
  openSheet('外观', '<div class="list-lite" style="background:var(--card)">' + opts.map(function (o) {
    return '<button type="button" class="lite-row" data-act="pick" data-v="' + o[0] + '">' +
      '<span class="lr-name">' + o[1] + '</span>' +
      '<span class="lr-val">' + (cur === o[0] ? '✓' : '') + '</span></button>';
  }).join('') + '</div>', {
    pick: async function (ds) {
      cache.settings.theme = ds.v;
      await saveSettings();
      applyTheme();
      renderSettings();
      closeSheet();
    }
  });
}

function applyTheme() {
  var t = cache.settings.theme || 'auto';
  document.documentElement.setAttribute('data-theme', t);
}

/* ===========================================================
   导出 / 备份 / 恢复
   =========================================================== */
function csvText() {
  var head = ['日期', '金额', '分类', '支付方式', '备注', '来源'];
  var rows = [head];
  cache.expenses.slice().sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.createdAt || 0) - (b.createdAt || 0);
  }).forEach(function (e) {
    rows.push([
      e.date,
      (e.amountCents / 100).toFixed(2),
      catName(e.categoryId),
      METHOD_NAME[e.method] || '',
      e.note || '',
      e.ruleId ? '固定支出' : '手动'
    ]);
  });
  return '\ufeff' + rows.map(function (r) {
    return r.map(function (v) {
      var s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }).join('\r\n');
}

function clockStr() {
  var d = new Date();
  return pad2(d.getHours()) + pad2(d.getMinutes());
}

function backupText() {
  return JSON.stringify({
    app: 'ledger',
    schemaVersion: 2,
    appVersion: APP_VERSION,
    exportedAt: dstr(new Date()) + ' ' + clockStr(),
    categories: cache.categories,
    expenses: cache.raw,
    budgets: Object.keys(cache.budgets).map(function (k) { return { id: k, amountCents: cache.budgets[k] }; }),
    rules: cache.rules,
    settings: cache.settings
  }, null, 1);
}

/* 分享文件：必须在点击手势内同步构造 File，否则 iOS 吃掉 activation */
async function shareFile(filename, text, mime) {
  try {
    var file = new File([text], filename, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return true;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return true;
  }
  return false;
}

function showTextFallback(title, text, filename) {
  openSheet(title,
    '<div class="field-hint">如果系统分享没弹出，可以全选下面的内容复制走，粘到微信/备忘录里保存。</div>' +
    '<textarea class="io-box" id="ioText" readonly>' + esc(text) + '</textarea>' +
    '<button type="button" class="btn-primary" data-act="copy">复制全部</button>',
    {
      copy: function () {
        var ta = $('#ioText');
        ta.removeAttribute('readonly');
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) {}
        ta.setAttribute('readonly', '');
        toast(ok ? '已复制' : '请手动长按全选');
      }
    });
}

async function exportCSV() {
  var text = csvText();
  var name = '记账_' + dstr(new Date()) + '.csv';
  var ok = await shareFile(name, text, 'text/csv');
  if (ok) { toast('已导出 CSV'); return; }
  showTextFallback('导出 CSV', text, name);
}

async function exportBackup() {
  var text = backupText();
  var name = '记账备份_' + dstr(new Date()) + '.json';
  var ok = await shareFile(name, text, 'application/json');
  if (!ok) { showTextFallback('备份数据', text, name); return; }
  cache.settings.lastBackupAt = Date.now();
  await saveSettings();
  checkBackupReminder();
  renderSettings();
  toast('备份完成');
}

function openRestoreSheet() {
  openSheet('从备份恢复',
    '<div class="field-hint">选择之前导出的 .json 备份文件。相同 id 的记录会保留手机上现有的版本，不会覆盖你后来改的内容。</div>' +
    '<label class="btn-primary" style="text-align:center;display:block;margin-top:12px;position:relative;overflow:hidden">选择备份文件' +
    '<input type="file" id="restoreFile" accept="application/json,.json" style="position:absolute;left:0;top:0;width:100%;height:100%;opacity:0;"></label>',
    {});

  setTimeout(function () {
    var inp = $('#restoreFile');
    if (!inp) return;
    inp.addEventListener('change', async function () {
      var f = this.files && this.files[0];
      if (!f) return;
      try {
        var text = await f.text();
        var stats = await restoreFromText(text);
        closeSheet();
        renderAll();
        toast('恢复完成：' + stats.expenses + ' 笔记录');
      } catch (err) {
        toast('恢复失败：' + (err && err.message ? err.message : '文件格式不对'));
      }
    });
  }, 60);
}

async function restoreFromText(text) {
  var data = JSON.parse(text);
  if (!data || data.app !== 'ledger') throw new Error('不是本应用的备份文件');

  var stats = { expenses: 0, categories: 0, budgets: 0, rules: 0 };
  var exIds = {};
  cache.raw.forEach(function (e) { exIds[e.id] = true; });

  var i;
  for (i = 0; i < (data.expenses || []).length; i++) {
    var e = data.expenses[i];
    if (!e || !e.id || exIds[e.id]) continue;
    await dbPut('expenses', e);
    exIds[e.id] = true;
    stats.expenses++;
  }
  var catIds = {};
  cache.categories.forEach(function (c) { catIds[c.id] = true; });
  for (i = 0; i < (data.categories || []).length; i++) {
    var c = data.categories[i];
    if (!c || !c.id || catIds[c.id]) continue;
    await dbPut('categories', c);
    stats.categories++;
  }
  var budIds = {};
  Object.keys(cache.budgets).forEach(function (k) { budIds[k] = true; });
  for (i = 0; i < (data.budgets || []).length; i++) {
    var b = data.budgets[i];
    if (!b || !b.id || budIds[b.id]) continue;
    await dbPut('budgets', b);
    stats.budgets++;
  }
  var rIds = {};
  cache.rules.forEach(function (r) { rIds[r.id] = true; });
  for (i = 0; i < (data.rules || []).length; i++) {
    var r = data.rules[i];
    if (!r || !r.id || rIds[r.id]) continue;
    await dbPut('rules', r);
    stats.rules++;
  }
  await loadAll();
  return stats;
}

/* ===========================================================
   数据自检
   =========================================================== */
function runSelfCheck() {
  var issues = [];
  var cats = {};
  cache.categories.forEach(function (c) { cats[c.id] = true; });

  cache.raw.forEach(function (e) {
    if (!Number.isInteger(e.amountCents) || e.amountCents <= 0) {
      issues.push({ lv: 'err', t: '金额异常：' + (e.date || '未知日期') + ' ' + (e.id || '') });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) {
      issues.push({ lv: 'err', t: '日期格式不对：' + (e.id || '') });
    }
    if (!cats[e.categoryId]) {
      issues.push({ lv: 'warn', t: '分类不存在：' + (e.date || '') + ' 的记录指向 ' + (e.categoryId || '空') + '，会显示成「未分类」' });
    }
    if (e.month && e.date && e.month !== e.date.slice(0, 7)) {
      issues.push({ lv: 'err', t: '月份与日期不一致：' + e.date + ' 记在 ' + e.month });
    }
    if (e.categoryId === 'monthly' && !e.channel && !e.deletedAt) {
      issues.push({ lv: 'warn', t: '月付记录没标渠道：' + e.date + ' ' + money(e.amountCents) + '，统计里会归到「未分渠道」' });
    }
  });

  var dup = {};
  cache.raw.filter(function (e) { return e.ruleId && !e.deletedAt; }).forEach(function (e) {
    var k = e.ruleId + '_' + e.month;
    dup[k] = (dup[k] || 0) + 1;
  });
  Object.keys(dup).forEach(function (k) {
    if (dup[k] > 1) issues.push({ lv: 'err', t: '固定支出重复生成：' + k + ' 共 ' + dup[k] + ' 笔' });
  });

  Object.keys(cache.budgets).forEach(function (k) {
    if (!(cache.budgets[k] > 0)) issues.push({ lv: 'warn', t: '预算值为空或负数：' + k });
  });

  var html;
  if (!issues.length) {
    html = '<div class="check-ok"><span class="ck-ico">✓</span>' + cache.expenses.length + ' 笔记录全部正常</div>';
  } else {
    html = '<div class="card" style="margin:0"><div class="card-head"><span class="card-title">发现 ' + issues.length + ' 个问题</span></div>' +
      issues.map(function (it) {
        return '<div class="check-item"><span class="ci-tag ' + (it.lv === 'err' ? 'err' : 'warn') + '">' +
          (it.lv === 'err' ? '错误' : '注意') + '</span><span>' + esc(it.t) + '</span></div>';
      }).join('') +
      '<div class="field-hint" style="margin-top:12px">错误项会直接算错月度合计，建议先导出备份再处理；注意项不影响统计。</div></div>';
  }
  openSheet('数据自检', html, {});
}

/* ---------- 清空 ---------- */
function openWipeSheet() {
  openSheet('清空全部数据',
    '<div class="field-hint" style="color:var(--red);font-size:13px">这个操作不可恢复：所有账目、分类、预算、规则都会被删掉。如果还没备份，先返回去导出一次。</div>' +
    '<div class="field" style="margin-top:14px"><div class="field-label">输入「确认清空」继续</div>' +
    '<input class="field-input" id="wipeInput" placeholder="确认清空"></div>' +
    '<button type="button" class="btn-danger" data-act="wipe">永久清空</button>',
    {
      wipe: async function () {
        if (($('#wipeInput').value || '').trim() !== '确认清空') { toast('输入不对，没有清空'); return; }
        await dbClear('expenses');
        await dbClear('budgets');
        await dbClear('rules');
        await dbClear('categories');
        await dbPut('meta', { key: 'settings', value: { theme: cache.settings.theme || 'auto', lastMethod: 'wechat', lastBackupAt: 0 } });
        await loadAll();
        await seedIfNeeded();
        await loadAll();
        state.month = mstr(new Date());
        state.draft.categoryId = null;
        renderAll();
        closeSheet();
        toast('已清空');
      }
    });
}

/* ===========================================================
   启动
   =========================================================== */
/* 只算系统键盘占掉的高度，写进 --kb 给弹层用。
   主界面（.app）是 position:fixed，高度恒为 100dvh，不参与键盘位移——
   否则 iOS 聚焦输入框时自己也会滚动页面，两个位移叠加会把界面顶出屏幕。 */
function syncViewport() {
  var vv = window.visualViewport;
  if (!vv) return;
  var gap = Math.round(window.innerHeight - vv.height - vv.offsetTop);
  var kb = gap > 90 ? gap : 0;
  document.documentElement.style.setProperty('--kb', kb + 'px');
}

function checkBackupReminder() {
  var last = cache.settings.lastBackupAt || 0;
  var bar = $('#backupBar');
  if (!cache.expenses.length) { bar.hidden = true; return; }
  var days = last ? Math.floor((Date.now() - last) / 86400000) : 9999;
  if (!last || days >= 30) {
    bar.hidden = false;
    $('#backupText').textContent = last
      ? '已经 ' + days + ' 天没备份了，数据只在这台手机上'
      : '还没备份过，换手机数据会丢';
  } else {
    bar.hidden = true;
  }
}

$('#backupNow').addEventListener('click', function () { exportBackup(); });

$('#backupBar').addEventListener('click', function (e) {
  if (e.target.id !== 'backupNow') setTab('settings');
});

/* 版本更新探测 */
async function checkVersion() {
  try {
    var r = await fetch('version.json?_=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    var j = await r.json();
    if (j && j.version && j.version !== APP_VERSION) $('#updateBar').hidden = false;
  } catch (err) { /* 离线时忽略 */ }
}

$('#updateBtn').addEventListener('click', function () { location.reload(); });

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch(function () { /* 不影响主流程 */ });
  navigator.serviceWorker.addEventListener('controllerchange', function () { /* 已接管 */ });
}

document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'visible') {
    checkVersion();
    checkBackupReminder();
  }
});

async function boot() {
  try {
    await openDB();
  } catch (err) {
    document.body.innerHTML = '<div style="padding:40px 24px;font-size:15px;line-height:1.7">' +
      '数据库打不开。<br><br>可能是隐私模式，或系统限制了网站数据。请换到 Safari 正常模式重试。</div>';
    return;
  }

  await loadAll();
  await seedIfNeeded();
  await loadAll();
  await migrate();
  await loadAll();
  await runRules();
  await loadAll();

  applyTheme();
  state.draft.method = cache.settings.lastMethod || 'wechat';
  state.draft.categoryId = null;

  renderAll();
  setTab('add');
  checkBackupReminder();
  checkVersion();
  registerSW();
  syncViewport();

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewport);
    window.visualViewport.addEventListener('scroll', syncViewport);
  }
  window.addEventListener('resize', syncViewport);
  window.addEventListener('orientationchange', function () { setTimeout(syncViewport, 240); });
}

/* 记住上次支付方式 */
async function rememberMethod() {
  var changed = false;
  if (cache.settings.lastMethod !== state.draft.method) {
    cache.settings.lastMethod = state.draft.method;
    changed = true;
  }
  if (state.draft.channel && cache.settings.lastChannel !== state.draft.channel) {
    cache.settings.lastChannel = state.draft.channel;
    changed = true;
  }
  if (changed) await saveSettings();
}

boot();
