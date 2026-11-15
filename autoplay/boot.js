/* boot.js —— 页内自播引导（拟人版 + 20 关洗牌轮换）
 *
 * 规则照《我来掌勺》的技能文档：
 *   - 拟人节奏与动作参数在 dkgbh-autoplay.js 里（human-pacing.md 的实测表）
 *   - 洗牌三条约束（shuffle-impl.md）：轮内不重复 / 轮间不重复 / 新一轮首关 ≠ 上轮末关
 *
 * 不碰游戏文件；只调游戏自己的 UI 与关卡接口，动作走它自己的触摸监听。
 */
(function () {
  'use strict';

  // ---- 自动刷新保险（2026-11-14 黛西加，治「跑几小时浏览器崩溃」）----
  // 为什么：自动玩每关会预载下一关的整包资源；那一关没玩到（卡住/跳过）就留在内存里，
  //   加上浏览器自身长时间运行的累积，实测 15 分钟资源 243→1752、进程 873→1394MB，
  //   几小时后可能把浏览器撑崩。清理包会和自动玩的预载标记打架（实测 2.8 万个报错），
  //   所以先上这个零风险保险：到点整页刷新，所有累积清零。
  // 用法：?refresh=45（分钟，0=关闭，默认 45；上限 720）。
  //   刷新后自动玩会按历史去重继续洗牌，中断约 10 秒。
  (function autoRefreshGuard() {
    try {
      var qs = new URLSearchParams(location.search);
      var raw = qs.get('refresh');
      var n = raw == null ? 45 : Number(raw);
      if (!(n > 0)) return;
      n = Math.min(n, 720);
      setTimeout(function () {
        try { console.log('[boot] refresh-guard ' + n + ' 分钟到，刷新清零'); } catch (e) {}
        try { location.reload(); } catch (e) {}
      }, n * 60000);
    } catch (e) {}
  })();

  // 内存看护（技能坑册 383 / demo-runtime-playbook 4.1）：每 30 秒采一次堆，
  // 连续 4 点单调上涨且斜率 > 2MB/min → 提前刷新换代（比 45 分钟定时刷新更早兜住泄漏）。
  (function memGuard() {
    try {
      if (!window.performance || !performance.memory) return;
      var samples = [];
      setInterval(function () {
        try {
          var v = Math.round(performance.memory.usedJSHeapSize / 1048576);
          samples.push({ t: Date.now(), mb: v });
          if (samples.length > 6) samples.shift();
          if (samples.length >= 4) {
            var w = samples.slice(-4);
            var mono = true, i;
            for (i = 1; i < w.length; i++) if (w[i].mb < w[i - 1].mb) mono = false;
            var mins = (w[3].t - w[0].t) / 60000;
            var slope = mins > 0 ? (w[3].mb - w[0].mb) / mins : 0;
            if (mono && slope > 2) {
              try { console.log('[boot] mem-guard：heap ' + w[3].mb + 'MB / 斜率 ' + slope.toFixed(1) + ' MB/min → 刷新换代'); } catch (e) {}
              location.reload();
            }
          }
        } catch (e) {}
      }, 30000);
    } catch (e) {}
  })();

  var POOL = [];                       // 关卡索引池（0..39 = 前 40 关）
  for (var p = 0; p < 40; p++) POOL.push(p);
  var MODE = '文字';
  var LOOP = true;                     // 无终态，一直循环
  var running = false;
  // boot 自己的地址：本地测试 / GitHub Pages / 镜像站都能据此找到同目录驱动
  var SCRIPT_SRC = '';
  try { SCRIPT_SRC = (document.currentScript && document.currentScript.src) || ''; } catch (e) {}
  function driverSrc() {
    if (SCRIPT_SRC) return SCRIPT_SRC.replace(/boot\.js(\?.*)?$/, 'dkgbh-autoplay.js?v=28');
    var base = (location.pathname.indexOf('/dkgbh-public/') >= 0)
      ? location.origin + '/dkgbh-public/'
      : location.origin + '/';
    return base + 'autoplay/dkgbh-autoplay.js?v=28';
  }

  // ---------- 拟人节奏（与驱动同公式；只用于轮间停顿） ----------
  function gauss() {
    var u1 = Math.random() || 1e-9, u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  function humanGap(medMs, minMs, maxMs, pauseRate) {
    var v = Math.exp(Math.log(medMs) + 0.42 * gauss());
    v = Math.min(maxMs, Math.max(minMs, v));
    if (Math.random() < (pauseRate == null ? 0.04 : pauseRate)) {
      v = Math.min(v * (2 + Math.random() * 1.5), maxMs);
    }
    return v;
  }

  // ---------- 洗牌 ----------
  function shuffle(a) {
    var r = a.slice();
    for (var i = r.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = r[i]; r[i] = r[j]; r[j] = t;
    }
    return r;
  }

  var history = [];                    // 历史排列（字符串），轮间去重
  var KEY = 'dkgbhDemoHistory_' + POOL.join('_');

  function loadHistory() {
    try { history = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { history = []; }
    if (!Array.isArray(history)) history = [];
  }
  function saveHistory() {
    try { localStorage.setItem(KEY, JSON.stringify(history.slice(-2000))); } catch (e) {}
  }

  // 三条约束：轮内不重复（洗牌本身）／轮间不重复／首关 ≠ 上轮末关
  function newQueue(pool, prevLast) {
    for (var tries = 0; tries < 500; tries++) {
      var q = shuffle(pool);
      if (q.length > 1 && prevLast != null && q[0] === prevLast) continue;
      if (history.indexOf(q.join(',')) >= 0) continue;
      return q;
    }
    // 兜底：清历史再洗
    history.length = 0;
    return shuffle(pool);
  }

  // 洗出队列并立刻记账（刷新/换轮都留痕，便于验证「历史真的生效」）
  function makeQueue(prevLast) {
    var q = newQueue(POOL, prevLast);
    history.push(q.join(','));
    saveHistory();
    return q;
  }

  var DEMO = {
    queue: [],
    qi: 0,
    round: 0,
    lastFinished: null,
    state: 'idle',
    wins: 0,
    losses: 0
  };

  function log() {
    try { console.log.apply(console, ['[boot]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  // 对外状态（验收/调试用）
  window.__dkgbhDemo = {
    status: function () {
      return {
        queue: DEMO.queue.slice(),
        level: DEMO.queue[DEMO.qi],
        qi: DEMO.qi,
        round: DEMO.round,
        seenOrders: history.length,
        state: DEMO.state,
        wins: DEMO.wins,
        losses: DEMO.losses,
        pool: POOL.slice()
      };
    },
    history: function () { return history.slice(); },
    clearHistory: function () { history.length = 0; saveHistory(); return 'cleared'; }
  };

  function runtimeReady() {
    try {
      if (!window.cc || !window.cc.director || !window.cc.director.getScene()) return false;
      var app = window.System && window.System.get('chunks:///_virtual/app.ts');
      return !!(app && app.app && app.app.manager && app.app.manager.ui);
    } catch (e) { return false; }
  }

  // 首页真的显示出来了吗（避免抢在引擎初始化中间进关 → Cocos 反序列化报 _iN$t）
  function homeReady() {
    try {
      var scene = window.cc.director.getScene();
      if (!scene) return false;
      var found = false;
      (function walk(n) {
        if (found || !n) return;
        if (n.name === 'PageHome' && n.activeInHierarchy) { found = true; return; }
        var ch = n.children || [];
        for (var i = 0; i < ch.length; i++) walk(ch[i]);
      })(scene);
      return found;
    } catch (e) { return false; }
  }

  function waitHome(cb, timeoutMs) {
    var t0 = Date.now();
    (function tick() {
      if (homeReady()) return cb();
      if (Date.now() - t0 > (timeoutMs || 600000)) { log('首页等待超时，仍尝试开始'); return cb(); }
      setTimeout(tick, 250);
    })();
  }

  function waitRuntime(cb) {
    var t0 = Date.now();
    (function tick() {
      if (runtimeReady()) return cb();
      if (Date.now() - t0 > 600000) return log('运行时等待超时（10 分钟）');
      setTimeout(tick, 200);
    })();
  }

  // 打一轮（按洗好的队列）
  function playRound() {
    if (DEMO.qi >= DEMO.queue.length) {
      // 上一轮结束：记末关，洗新一轮
      DEMO.lastFinished = DEMO.queue[DEMO.queue.length - 1];
      DEMO.queue = makeQueue(DEMO.lastFinished);
      DEMO.qi = 0;
    }
    DEMO.round++;
    log('第 ' + DEMO.round + ' 轮开始，队列: ' + DEMO.queue.map(function (x) { return x + 1; }).join(' → '));
    DEMO.state = 'running';

    window.__AUTO.runList(DEMO.queue, { mode: MODE }).then(function (results) {
      var wins = (results || []).filter(function (r) { return r.reason === 'win'; }).length;
      var lost = (results || []).length - wins;
      DEMO.wins += wins; DEMO.losses += lost;
      DEMO.qi = 0;
      log('第 ' + DEMO.round + ' 轮结束：' + wins + '/' + (results ? results.length : 0) + ' 胜');
      DEMO.state = 'round-end';
      if (!LOOP) return log('不循环，停在此处');
      setTimeout(playRound, humanGap(5000, 3000, 8000, 0.1));   // 第 18 条：跨轮多停 3~8 秒
    })['catch'](function (e) {
      log('本轮异常：' + e);
      DEMO.state = 'error';
      if (LOOP) setTimeout(playRound, 5000);
    });
  }

  function start() {
    if (running) return;
    running = true;
    loadHistory();
    var qs = new URLSearchParams(location.search);
    // ?levels=1,3,5 调试池（只认正整数，按 1 起数，内部减 1）
    var lv = qs.get('levels');
    if (lv) {
      var pool = lv.split(',').map(function (x) { return parseInt(x, 10); })
        .filter(function (x) { return x > 0 && x <= 45; })
        .map(function (x) { return x - 1; });
      if (pool.length) {
        POOL = pool;
        KEY = 'dkgbhDemoHistory_' + POOL.join('_');
        loadHistory();
        log('调试池: ' + pool.map(function (x) { return x + 1; }).join(','));
      }
    }
    DEMO.queue = makeQueue(DEMO.lastFinished);
    log('历史里已有 ' + history.length + ' 轮排列');
    log('第 1 轮队列: ' + DEMO.queue.map(function (x) { return x + 1; }).join(' → '));
    setTimeout(playRound, 3500);   // 等首页/引擎完全就绪，别抢在第一帧
  }

  // ?from=9 单轮从第 9 关顺序打（调试/看单关用，不走洗牌）
  function startFrom() {
    var qs = new URLSearchParams(location.search);
    var from = Math.min(parseInt(qs.get('from'), 10) - 1, POOL.length - 1);
    if (!(from >= 0)) return false;
    var cnt = parseInt(qs.get('count'), 10) || (POOL.length - from);
    log('调试：从第 ' + (from + 1) + ' 关开始，打 ' + cnt + ' 关');
    window.__AUTO.run(from, cnt, { mode: MODE });
    return true;
  }

  function loadDriver(cb) {
    var sc = document.createElement('script');
    sc.src = driverSrc();
    sc.onload = function () { cb(); };
    sc.onerror = function () { log('驱动加载失败'); };
    document.body.appendChild(sc);
  }

  waitRuntime(function () {
    var go = function () {
      // ?boot=0 → 只加载引擎与首页，不自动开打（调试/探针用）
      if (/[?&]boot=0/.test(location.search)) { log('boot=0：不自播，等外部控制'); return; }
      waitHome(function () {
        DEMO.state = 'ready';
        setTimeout(function () {
          if (/[?&]from=/.test(location.search)) { startFrom(); return; }
          start();
        }, 1200 + Math.random() * 1200);
      });
    };
    if (window.__AUTO) return go();
    loadDriver(go);
  });
})();
