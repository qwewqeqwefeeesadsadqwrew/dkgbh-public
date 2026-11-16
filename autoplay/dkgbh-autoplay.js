/* dkgbh-autoplay.js —— 《变个花样玩》页内自动玩内核
 *
 * 思路：不猜图形、不写死坐标。每关的关卡脚本在 start() 里调
 *   GuideManager.instance.setSteps([[type, node, target], ...])
 * 把「这一关要做的每一手」交给游戏自己的引导系统（type: 1 点击 / 2 拖拽 /
 * 3 滑动 / 4 长按 / 5 连点）。我们读这张表，按表出动作，再用
 * 游戏自己的完成标记 tiptrue[i] 验收（关卡里做完一步会调 completeOneTip(i)）。
 *
 * 界内：只对游戏自己的节点发 touch 事件（走它自己的监听、判定、动画），
 * 不修改任何游戏文件、不置任何完成标志。
 */
(function (root) {
  'use strict';
  var cc = root.cc;
  var LOG = [];
  var LEVEL_GEN = 0;
  var WIN_LATCHED = null, FAIL_LATCHED = null;
  var VDBG = { gen: 0, latches: [], rejected: [], sets: [], early: [], resets: [], panels: [], levels: [], samples: [] };
  try { root.__VDBG = VDBG; } catch (e) {}
  function countDone(g) {
    g = g || Guide();
    if (!g || !g._steps) return 0;
    var n = g._steps.length, d = 0;
    for (var i = 0; i < n; i++) if (g.tiptrue && g.tiptrue[i]) d++;
    return d;
  }
  function panelPath(n) {
    var p = [];
    while (n) { p.unshift(n.name); n = n.parent; }
    return '/' + p.join('/');
  }
  function activePanelNodes(name) {
    var out = [];
    (function walk(n) {
      if (!n) return;
      if (n.name === name && n.activeInHierarchy) {
        out.push({ path: panelPath(n), name: n.name, parent: n.parent ? n.parent.name : null, active: !!n.activeInHierarchy });
        return;
      }
      var ch = n.children || [];
      for (var k = 0; k < ch.length; k++) walk(ch[k]);
    })(cc.director.getScene());
    return out;
  }
  function vdbgSnap() {
    try {
      var g = Guide(), lv = levelComp(), pg = pageGame();
      var steps = g && g._steps ? g._steps.length : 0;
      var done = countDone(g);
      return { gen: LEVEL_GEN, done: done, steps: steps, level: lv && lv.node ? lv.node.name : null, timer: pg ? pg.countdownNum : null };
    } catch (e) { return { gen: LEVEL_GEN, err: String(e) }; }
  }
  function vdbgPush(arr, o) { try { arr.push(o); if (arr.length > 500) arr.shift(); } catch (e) {} }
  function allTipsDone(g) {
    g = g || Guide();
    var n = g && g._steps ? g._steps.length : 0;
    return n > 0 && countDone(g) === n;
  }
  function winLatched() { return !!(WIN_LATCHED && WIN_LATCHED.gen === LEVEL_GEN); }
  function failLatched() { return !!(FAIL_LATCHED && FAIL_LATCHED.gen === LEVEL_GEN); }
  function sampleLatches(src) {
    try {
      var g = Guide(), lv = levelComp(), pg = pageGame();
      var steps = g && g._steps ? g._steps.length : 0;
      var done = countDone(g);
      var all = steps > 0 && done === steps;
      var levelName = lv && lv.node ? lv.node.name : null;
      var pvNode = popShown('PopVictory');
      var pfNode = popShown('PopFail');
      var vOk = pvNode ? { path: panelPath(pvNode), name: pvNode.name, parent: pvNode.parent ? pvNode.parent.name : null, active: !!pvNode.activeInHierarchy } : null;
      var fOk = pfNode ? { path: panelPath(pfNode), name: pfNode.name, parent: pfNode.parent ? pfNode.parent.name : null, active: !!pfNode.activeInHierarchy } : null;

      // 接受/拒绝都记录 path/name/parent/active/gen/done/steps
      var vNodes = activePanelNodes('PopVictory');
      for (var i = 0; i < vNodes.length; i++) {
        var vn = vNodes[i], okV = vn.parent === 'Pop';
        if (VDBG.samples.length < 500) vdbgPush(VDBG.samples, { t: Date.now(), gen: LEVEL_GEN, src: src, name: vn.name, path: vn.path, parent: vn.parent, active: vn.active, done: done, steps: steps, all: all, accepted: okV, level: levelName, timer: pg ? pg.countdownNum : null });
        if (!okV && VDBG.rejected.length < 500) {
          vdbgPush(VDBG.rejected, { t: Date.now(), gen: LEVEL_GEN, done: done, steps: steps, name: vn.name, path: vn.path, parent: vn.parent, active: vn.active, reason: 'wrong-parent', src: src });
          log('WIN_REJECTED', 'wrong-parent', vn.path, 'gen=' + LEVEL_GEN, 'done=' + done + '/' + steps);
        }
      }
      var fNodes = activePanelNodes('PopFail');
      for (var j = 0; j < fNodes.length; j++) {
        var fn = fNodes[j], okF = fn.parent === 'Pop';
        if (VDBG.samples.length < 500) vdbgPush(VDBG.samples, { t: Date.now(), gen: LEVEL_GEN, src: src, name: fn.name, path: fn.path, parent: fn.parent, active: fn.active, done: done, steps: steps, all: all, accepted: okF, level: levelName, timer: pg ? pg.countdownNum : null });
        if (!okF && VDBG.rejected.length < 500) {
          vdbgPush(VDBG.rejected, { t: Date.now(), gen: LEVEL_GEN, done: done, steps: steps, name: fn.name, path: fn.path, parent: fn.parent, active: fn.active, reason: 'fail-wrong-parent', src: src });
          log('FAIL_REJECTED', 'wrong-parent', fn.path, 'gen=' + LEVEL_GEN, 'done=' + done + '/' + steps);
        }
      }

      // 只在本关代次 + 全部 tips 完成后，首次采到真 PopVictory 就锁存
      if (vOk && all && !winLatched()) {
        WIN_LATCHED = { t: Date.now(), gen: LEVEL_GEN, done: done, steps: steps, name: vOk.name, path: vOk.path, parent: vOk.parent, active: vOk.active, level: levelName };
        vdbgPush(VDBG.latches, { ev: 'win', t: WIN_LATCHED.t, gen: LEVEL_GEN, done: done, steps: steps, name: vOk.name, path: vOk.path, parent: vOk.parent, active: vOk.active, level: levelName, src: src });
        log('WIN_LATCHED', 'gen=' + LEVEL_GEN, 'done=' + done + '/' + steps, 'path=' + vOk.path, 'src=' + src);
      }
      if (vOk && !all && VDBG.rejected.length < 500) {
        vdbgPush(VDBG.rejected, { t: Date.now(), gen: LEVEL_GEN, done: done, steps: steps, name: vOk.name, path: vOk.path, parent: vOk.parent, active: vOk.active, reason: 'not-all-tips', src: src });
        log('WIN_REJECTED', 'not-all-tips', vOk.path, 'gen=' + LEVEL_GEN, 'done=' + done + '/' + steps);
      }
      // PopFail 独立锁存，绝不与胜利共用
      if (fOk && !failLatched()) {
        FAIL_LATCHED = { t: Date.now(), gen: LEVEL_GEN, done: done, steps: steps, name: fOk.name, path: fOk.path, parent: fOk.parent, active: fOk.active, level: levelName };
        vdbgPush(VDBG.latches, { ev: 'fail', t: FAIL_LATCHED.t, gen: LEVEL_GEN, done: done, steps: steps, name: fOk.name, path: fOk.path, parent: fOk.parent, active: fOk.active, level: levelName, src: src });
        log('FAIL_LATCHED', 'gen=' + LEVEL_GEN, 'done=' + done + '/' + steps, 'path=' + fOk.path, 'src=' + src);
      }
    } catch (e) {}
  }
  function log() {
    var args = Array.prototype.slice.call(arguments);
    var line = args.join(' ');
    LOG.push([Date.now(), line]);
    if (LOG.length > 400) LOG.shift();
    try { console.log('[auto]', line); } catch (e) {}
  }

  function M() { return root.System; }
  function mod(id) { try { return M().get(id); } catch (e) { return null; } }
  function app() { var m = mod('chunks:///_virtual/app.ts'); return m && m.app; }
  function Guide() { var m = mod('chunks:///_virtual/GuideManager.ts'); return m && m.GuideManager && m.GuideManager.instance; }

  // ===== 2026-11-15 远山反馈：跑几小时后每关都出现一个橙色转圈 =====
  // 定位：那是游戏全局加载圈 UIMgrLoading（app.manager.ui.loading）。
  //   正常一加载完就关；长时间运行后 showLoadingMap 里残留计数，导致它永远不关。
  // 兜底：纯视觉关闭，不动游戏逻辑 ——
  //   · 计数为 0 却还亮着 → 立刻关（不可能有加载在进行）
  //   · 计数 > 0 但 45 秒不变 → 视为卡死，关掉
  var __loadingWatch = { size: -1, at: 0 };
  function killStuckLoading() {
    try {
      var a = app();
      var ui = a && a.manager && a.manager.ui;
      var node = ui && ui.loading;
      if (!node) return;
      if (!node.active) { __loadingWatch.size = -1; __loadingWatch.at = 0; return; }
      var sz = -1;
      try {
        var m = ui.showLoadingMap;
        if (m) sz = (typeof m.size === 'number') ? m.size : Object.keys(m).length;
      } catch (e) {}
      if (sz === 0) { node.active = false; __loadingWatch.size = -1; __loadingWatch.at = 0; log('loading-stuck-killed', 'size=0'); return; }
      if (sz !== __loadingWatch.size) { __loadingWatch.size = sz; __loadingWatch.at = now(); return; }
      if (!__loadingWatch.at) __loadingWatch.at = now();
      if (now() - __loadingWatch.at > 45000) {
        node.active = false;
        log('loading-stuck-killed', 'size=' + sz, Math.round((now() - __loadingWatch.at) / 1000) + 's');
        __loadingWatch.size = -1; __loadingWatch.at = 0;
      }
    } catch (e) {}
  }

  // ---------- 触摸事件 ----------
  function evt(x, y, target) {
    var e = new (cc.Event.EventTouch)([], true);
    e.touch = new (cc.Touch)(x, y);
    e.target = target;
    e.getLocation = function () { return cc.v2(x, y); };
    e.getUILocation = function () { return cc.v2(x, y); };
    e.getLocationX = function () { return x; };
    e.getLocationY = function () { return y; };
    e.getUILocationX = function () { return x; };
    e.getUILocationY = function () { return y; };
    e.getDelta = function () { return cc.v2(0, 0); };
    e.getDeltaX = function () { return 0; };
    e.getDeltaY = function () { return 0; };
    e.touchID = 0;
    return e;
  }
  function emit(n, type, x, y) { if (!n || !n.isValid) return false; n.emit(type, evt(x, y, n)); return true; }

  function size(n) {
    try { var t = n.getComponent('cc.UITransform'); return t ? [t.width, t.height] : [0, 0]; } catch (e) { return [0, 0]; }
  }
  // 世界包围盒（必须用字符串取 UITransform：实测 getComponent(cc.UITransform) 返回 null）
  function boxOf(n) {
    try {
      var t = n.getComponent('cc.UITransform');
      if (!t || !t.getBoundingBoxToWorld) return null;
      var b = t.getBoundingBoxToWorld();
      if (!b || !(b.width > 0)) return null;
      return { x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
    } catch (e) { return null; }
  }
  // 落点候选：被拖节点的「判定体」可能不是它自己，而是某个子节点
  // （实测 Level2 第 25 手：判的是 diajijiandao.children[2]，本地偏移 101px）
  function dropCandidates(node, target) {
    var tb = boxOf(target);
    var out = [];
    var w = node.worldPosition;
    if (!tb) { out.push({ x: w.x, y: w.y }); return out; }
    // 候选 0：被拖节点自己对准目标中心
    out.push({ x: w.x + (tb.cx - (boxOf(node) ? boxOf(node).cx : w.x)), y: w.y + (tb.cy - (boxOf(node) ? boxOf(node).cy : w.y)) });
    // 其余候选：每个 active 子节点对准目标中心（面积从小到大）
    var kids = (node.children || []).filter(function (c) { return c.activeInHierarchy; })
      .map(function (c) { return { n: c, b: boxOf(c) }; })
      .filter(function (o) { return !!o.b; });
    kids.sort(function (a, b) { return a.b.w * a.b.h - b.b.w * b.b.h; });
    for (var i = 0; i < kids.length && i < 4; i++) {
      var k = kids[i];
      out.push({ x: w.x + (tb.cx - k.b.cx), y: w.y + (tb.cy - k.b.cy) });
    }
    // 去重
    var uniq = [];
    out.forEach(function (p) {
      for (var i = 0; i < uniq.length; i++) { if (Math.abs(uniq[i].x - p.x) < 2 && Math.abs(uniq[i].y - p.y) < 2) return; }
      uniq.push(p);
    });
    return uniq;
  }
  function worldPt(n, rx, ry) {
    var s = size(n), w = n.worldPosition;
    return { x: w.x + (rx || 0) * s[0], y: w.y + (ry || 0) * s[1] };
  }
  // 矩形内偏向内部的随机落点（不点正中也点到有效区）
  function randPt(n) {
    var r = function () { return (Math.random() * 2 - 1) * 0.26; };
    return worldPt(n, r(), r());
  }
  function active(n) {
    return !!(n && n.isValid && n.activeInHierarchy && size(n)[0] > 0);
  }

  // ---------- 监听归属：谁真的挂了 touch 监听，动作就发给谁 ----------
  // 实测：Level2 的「道绒排」步骤把监听挂在 jianhaoderongpaida 的每个子节点上，
  // 发给父节点等于白打（note: notes/level2-diag）
  function listens(n) {
    try {
      if (typeof n.hasEventListener === 'function') {
        return n.hasEventListener(cc.Node.EventType.TOUCH_END) ||
               n.hasEventListener(cc.Node.EventType.TOUCH_MOVE) ||
               n.hasEventListener(cc.Node.EventType.TOUCH_START);
      }
    } catch (e) {}
    return false;
  }
  function dist2(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }
  // 画面指纹：关卡根（Level\d）→ back 容器下每个子节点的 active + 位置（按 20px 分桶）
  // 用来捕捉「背景层平移/显隐」这种不换节点、只挪画面的切镜（例：Level0 的 qieJingyi）
  function sceneSig() {
    try {
      var root = null;
      (function walk(n) {
        if (root || !n) return;
        if (/^Level\d+$/i.test(n.name)) { root = n; return; }
        var ch = n.children || [];
        for (var i = 0; i < ch.length; i++) walk(ch[i]);
      })(cc.director.getScene());
      if (!root) return '';
      var back = null;
      for (var i = 0; i < (root.children || []).length; i++) {
        var c = root.children[i];
        if (c.name === 'back' || c.name === 'GameContent') { back = c; break; }
      }
      if (!back) back = root.children[0];
      if (!back) return '';
      var out = [];
      for (var j = 0; j < (back.children || []).length; j++) {
        var k = back.children[j];
        out.push(k.name + (k.activeInHierarchy ? '1' : '0') + Math.round(k.position.x / 20) + ',' + Math.round(k.position.y / 20));
      }
      return out.join('|');
    } catch (e) { return ''; }
  }

  // 分组口径照游戏自己的结构：源节点最近的名字形如 bj1/bj2… 的祖先段
  function groupKey(n) {
    try {
      // 主判据：关卡根 Level<n> → back 容器 → 段（cj1/cj2/bj1…），这是「画面段」的真实结构
      var chain = [], p = n;
      while (p && p.parent) { chain.unshift(p); p = p.parent; }
      var li = -1;
      for (var i = 0; i < chain.length; i++) {
        if (/^Level\d+$/i.test(chain[i].name)) { li = i; break; }
      }
      if (li >= 0 && li + 2 < chain.length) return chain[li + 2].name;
      if (li >= 0 && li + 1 < chain.length) return chain[li + 1].name;
      // 退路：最近的 bj/cj 段祖先
      p = n;
      for (var j = 0; j < 8 && p; j++) {
        if (/^(bj|cj)\d+$/i.test(p.name)) return p.name;
        p = p.parent;
      }
    } catch (e) {}
    return '';
  }

  function resolveNode(n, target) {
    if (!n || !n.isValid) return n;
    if (listens(n)) return n;
    var kids = (n.children || []).filter(function (c) { return c.activeInHierarchy && listens(c); });
    if (!kids.length) return n;
    if (target && target.worldPosition) {
      var tw = target.worldPosition;
      kids.sort(function (a, b) { return dist2(a.worldPosition, tw) - dist2(b.worldPosition, tw); });
    }
    return kids[0];
  }

  var WATCH_VICTORY = false;
  function sleep(ms) {
    return new Promise(function (resolve) {
      var t0 = now();
      (function tick() {
        if (WATCH_VICTORY && (winLatched() || failLatched())) {
          var vs = vdbgSnap(); vs.t = Date.now(); vs.fn = 'sleep'; vs.ms = ms; vs.win = winLatched(); vs.fail = failLatched(); vs.stack = (new Error()).stack;
          vdbgPush(VDBG.early, vs);
          return resolve();
        }
        if (now() - t0 >= ms) return resolve();
        setTimeout(tick, 100);
      })();
    });
  }

  function now() { return Date.now(); }

  // ---------- 试验：随机多段拖动路径（?pathTest=1 开启，默认关闭，不影响交付） ----------
  // 动机：原来的单峰 sin 侧弯 ±0.12×min(dist,260)（最多 ±31px），对 300~400px 的拖动
  // 只剩约 8% 侧偏，看起来接近直线。这里改成 2~3 段随机钟形控制点叠加，
  // 幅度上限 18% 位移，首尾用 sin 归零，每次拖动形状都不同。
  // 默认开启（远山 2026-11-13 定稿）；需要回到直线模式用 ?pathTest=0
  var PATH_TEST = (function () {
    try {
      if (/[?&]pathTest=0(&|$)/.test(String(location.search || ''))) return false;
      return true;
    } catch (e) { return true; }
  })();
  function makePathPts() {
    var pts = [];
    for (var attempt = 0; attempt < 20; attempt++) {
      var n = 2 + Math.floor(Math.random() * 2);          // 2~3 个控制点
      pts = [];
      for (var i = 1; i <= n; i++) {
        var s = i / (n + 1) + rand(-0.07, 0.07);
        s = Math.min(0.88, Math.max(0.12, s));
        pts.push({
          s: s,
          a: rand(0.16, 0.26) * (Math.random() < 0.5 ? -1 : 1),
          w: rand(0.16, 0.26)
        });
      }
      // 峰值不足 20% 就重抽：多个控制点可能互相抵消，不能让变回直线（远山定 20%+）
      // 注意要乘 sin(πt) 再比：实际轨迹两端会被 arc 衰减，不乘就会高估
      var peak = 0;
      for (var k = 1; k < 20; k++) {
        var t = k / 20, arc = Math.sin(Math.PI * t), v = 0;
        for (var j = 0; j < pts.length; j++) {
          var d = (t - pts[j].s) / pts[j].w;
          v += pts[j].a * Math.exp(-d * d);
        }
        v = Math.abs(v * arc);
        if (v > peak) peak = v;
      }
      if (peak >= 0.20) return pts;
    }
    return pts;                                           // 20 次都不到 20%：用最后一次，不无限循环
  }
  function pathOffset(t, pts) {
    var o = 0;
    for (var i = 0; i < pts.length; i++) {
      var d = (t - pts[i].s) / pts[i].w;
      o += pts[i].a * Math.exp(-d * d);
    }
    return Math.max(-0.30, Math.min(0.30, o));         // 总侧偏封顶 30% 位移（远山 2026-11-13 定：20% 以上）
  }

  // ---------- 手势记录（照掌勺：用来证明「随机真的在生效」看 dur / curve 两列） ----------
  var GESTURES = [];
  function recordGesture(g) {
    g.t = now();
    GESTURES.push(g);
    if (GESTURES.length > 12) GESTURES.shift();
  }

  // 2026-11-15：延迟释放上一关的 bundle（防内存线性增长）。
  //   enter 时只记名字，等 playLevel 里新关完全就绪后再释放 —— 避开 onEnable/
  //   渲染队列还在用旧 SpriteFrame、材质的窗口（早释放会产生 updateUVs 等报错）。
  // 声明必须放在 enter（930 行附近）之前：严格模式下后面的 var 提升后仍是 undefined，
  //   在 enter 里赋值会抛 ReferenceError 被 catch 吞掉（实测释放从来不生效）。
  var pendingReleaseBundle = null;
  function releasePrevLevel() {
    if (!pendingReleaseBundle) return;
    // 关键：只有确认「已经切到下一关」才释放（GameConfig.levelInfo.bundle 变了）。
    // 否则旧节点还在显示/渲染，提前释放会 getGFXTexture 报错刷屏。
    try {
      var gcM0 = mod('chunks:///_virtual/GameConfig.ts');
      var gc0 = gcM0 && gcM0.GameConfig;
      if (gc0 && gc0.levelInfo && gc0.levelInfo.bundle === pendingReleaseBundle) {
        setTimeout(function () { try { releasePrevLevel(); } catch (e9) {} }, 2000);
        return;
      }
    } catch (e8) {}
    var bn = pendingReleaseBundle;
    pendingReleaseBundle = null;
    try {
      var b = cc.assetManager.getBundle(bn);
      if (b) {
        b.releaseAll();
        cc.assetManager.removeBundle(b);
        log('release-prev', bn);
      }
    } catch (e) { log('release-prev-err', String(e).slice(0, 60)); }
  }

  // ---------- 拟人参数（照《我来掌勺》human-pacing.md 实测表） ----------
  // 目的不是「像人」本身，是不给风控留可识别的固定节律；每一次动作的时长/按下/弧度/
  // 抖动/帧间隔/松手延迟都独立随机，缓动曲线每次混不同幂函数。
  function rand(a, b) { return a + Math.random() * (b - a); }

  // ---------- 统计分布工具（真人的节奏不是均匀分布，这是最容易被检测的地方） ----------
  // Box-Muller 标准正态
  function gauss() {
    var u1 = Math.random() || 1e-9, u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  // 人类操作间隔 = 对数正态（大量 1~3 秒 + 少数长停顿），不是均匀分布
  // medMs: 中位数；sigma 越大尾巴越长。5% 概率叠加「思考停顿」放大 3~5 倍。
  function humanGap(medMs, minMs, maxMs, pauseRate) {
    var sigma = 0.42;
    var v = Math.exp(Math.log(medMs) + sigma * gauss());
    v = clamp(v, minMs, maxMs);
    if (Math.random() < (pauseRate == null ? 0.04 : pauseRate)) {
      v = v * (2 + Math.random() * 1.5);        // 思考停顿：2~3.5 倍（真人会接电话/看提示）
      v = Math.min(v, maxMs);             // 但封顶，别把关卡拖到超时
    }
    return v;
  }

  // Fitts 定律：移动到目标的时间 ∝ log2(距离/目标宽度 + 1)
  // 参考 ghost-cursor: fitts = 2 * log2(d/w + 1)；这里换成毫秒尺度并夹到人手合理区间
  function fittsDur(dist, width) {
    var id = Math.log2(dist / Math.max(width || 60, 8) + 1);
    return clamp(110 + 205 * id, 240, 1400);
  }

  // 目标框内的「正态落点」：真人偏中心，不是均匀撒满
  function gaussPointInRect(node, spread) {
    var b = boxOf(node);
    if (!b || !b.w) { var w = node && node.isValid ? node.worldPosition : null; return w ? { x: w.x, y: w.y } : { x: 0, y: 0 }; }
    var sx = (spread || 0.28) * (b.w / 2), sy = (spread || 0.28) * (b.h / 2);
    return {
      x: clamp(b.cx + gauss() * sx, b.x + b.w * 0.06, b.x + b.w * 0.94),
      y: clamp(b.cy + gauss() * sy, b.y + b.h * 0.06, b.y + b.h * 0.94)
    };
  }

  // 矩形内缩 inset 的随机点（内缩 12% 起点 / 24% 落点，同掌勺口径）
  function randPointInRect(node, inset) {
    var b = boxOf(node);
    inset = inset || 0;
    if (!b || !b.w) {
      // 节点可能刚被销毁 / 父节点已摘：worldPosition 会是 null，别让整轮崩掉
      var w = node && node.isValid ? node.worldPosition : null;
      return w ? { x: w.x, y: w.y } : { x: 0, y: 0 };
    }
    var iw = b.w * (1 - 2 * inset), ih = b.h * (1 - 2 * inset);
    return { x: b.x + b.w * inset + Math.random() * Math.max(iw, 0), y: b.y + b.h * inset + Math.random() * Math.max(ih, 0) };
  }

  // 缓动：每次混合不同的平滑曲线与幂函数
  function makeEase() {
    var mix = rand(0.45, 0.85), pow = rand(1.35, 2.6);
    return function (t) { var s = t * t * (3 - 2 * t); return mix * s + (1 - mix) * Math.pow(t, pow); };
  }

  // ---------- 起点/落点：正态偏中心 + 遮挡过滤（技能清单第 6 条） ----------
  // 老内核只有「矩形内均匀撒点」，没有遮挡过滤；这里按 human-pacing 模板补齐：
  // 24 个正态点 + 8 个均匀点，洗牌后取第一个不压住别的可触摸节点矩形的点。
  function isRelated(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    var p = a; while (p) { if (p === b) return true; p = p.parent; }
    p = b; while (p) { if (p === a) return true; p = p.parent; }
    return false;
  }
  function blockersFor(node, target) {
    var root = (levelComp() || {}).node || cc.director.getScene();
    var out = [];
    (function walk(n) {
      if (!n || !n.isValid || !n.activeInHierarchy) return;
      if (n !== node && n !== target && !isRelated(n, node) && !isRelated(n, target) && listens(n)) {
        var b = boxOf(n);
        if (b) out.push(b);
      }
      var ch = n.children || [];
      for (var i = 0; i < ch.length; i++) walk(ch[i]);
    })(root);
    return out;
  }
  function pointBlocked(x, y, boxes) {
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return true;
    }
    return false;
  }
  function pickPoint(n, spread, inset, target) {
    if (!n) return { x: 0, y: 0 };
    var boxes = blockersFor(n, target || null);
    var cands = [];
    for (var i = 0; i < 24; i++) {
      var p = gaussPointInRect(n, spread == null ? 0.28 : spread);
      if (p && !pointBlocked(p.x, p.y, boxes)) cands.push(p);
    }
    for (var j = 0; j < 8; j++) {
      var q = randPointInRect(n, inset == null ? 0.12 : inset);
      if (q && !pointBlocked(q.x, q.y, boxes)) cands.push(q);
    }
    for (var k = cands.length - 1; k > 0; k--) {
      var r = Math.floor(Math.random() * (k + 1));
      var t = cands[k]; cands[k] = cands[r]; cands[r] = t;
    }
    if (cands.length) return cands[0];
    return gaussPointInRect(n, spread == null ? 0.28 : spread);   // 全被挡：退回正态点，别卡死
  }

  // ---------- 动作（全部拟人：时长/按压/弧度/抖动/帧间隔/缓动/松手延迟都随机） ----------
  function click(n) {
    var p = pickPoint(n, 0.30, 0.12, null);                   // 正态偏中心 + 遮挡过滤
    p.x += rand(-1.6, 1.6); p.y += rand(-1.6, 1.6);           // 点击位置再偏 ±1.6px
    emit(n, cc.Node.EventType.TOUCH_START, p.x, p.y);
    var hold = rand(60, 160);                                  // 按下 60~160ms（技能参数表）
    return sleep(Math.round(hold * 0.35)).then(function () {
      // 70% 概率中途发一次 TOUCH_MOVE（±2.2px，小于常见 8px 拖拽阈值）
      if (Math.random() < 0.7) {
        emit(n, cc.Node.EventType.TOUCH_MOVE, p.x + rand(-2.2, 2.2), p.y + rand(-2.2, 2.2));
      }
      return sleep(Math.round(hold * 0.65));
    }).then(function () {
      emit(n, cc.Node.EventType.TOUCH_END, p.x, p.y);
      recordGesture({ type: 'tap', node: n.name, from: [Math.round(p.x), Math.round(p.y)], to: [Math.round(p.x), Math.round(p.y)], dur: Math.round(hold), press: Math.round(hold), curve: 0 });
      return hold;                                             // 返回动作时长给节奏用
    });
  }
  function multiClick(n, times) {
    var i = 0, total = 0;
    function step() {
      if (i++ >= times) return Promise.resolve(total);
      return click(n).then(function (d) {
        total += d;
        var gap = humanGap(160, 80, 350, 0.02);                // 连击间隔 80~350ms（技能口径）
        total += gap;
        return sleep(gap).then(step);
      });
    }
    return step();
  }

  // 拟人拖拽：贝塞尔弧度 + 正弦抖动 + 随机缓动 + 随机帧间隔 + 松手延迟
  // plan.fit 非空时在到达后再做闭环对齐（判 children[i]/祖先 的关卡需要）
  function drag(n, target, mode, plan) {
    plan = plan || {};
    return new Promise(function (resolve) {
      var a = pickPoint(n, 0.28, 0.12, target);                 // 起点：24 正态 + 8 均匀，避开遮挡
      var b;
      if (mode === 'up' || mode === 'down' || mode === 'left' || mode === 'right') {
        var baseLen = plan.len || 120;
        var len = baseLen + rand(8, 60);                        // 滑动长度 +8~60px
        var ang = rand(-0.06, 0.06);                            // 角度 ±3.4°
        var dx = (mode === 'left' ? -1 : mode === 'right' ? 1 : 0);
        var dy = (mode === 'down' ? -1 : mode === 'up' ? 1 : 0);
        var rx = dx * Math.cos(ang) - dy * Math.sin(ang);
        var ry = dx * Math.sin(ang) + dy * Math.cos(ang);
        b = { x: a.x + rx * len, y: a.y + ry * len };
      } else if (plan.pt) {
        b = { x: plan.pt.x + rand(-5, 5), y: plan.pt.y + rand(-5, 5) };
      } else if (target) {
        b = gaussPointInRect(target, 0.24);                     // 落点：正态偏中心
      } else {
        b = a;
      }

      var pressMs = mode ? rand(40, 140) : rand(80, 240);       // 按下停顿（滑动 40~140 / 拖拽 80~240，技能口径）
      var vx0 = b.x - a.x, vy0 = b.y - a.y;
      var dist0 = Math.sqrt(vx0 * vx0 + vy0 * vy0) || 1;
      var tgtW = 0;
      try { var tb = target ? boxOf(target) : null; tgtW = tb ? Math.min(tb.w, tb.h) : 0; } catch (e) {}
      // 时长 = Fitts 定律（距离/目标宽度），乘一个 0.85~1.15 的个体差
      var dur = mode
        ? Math.min(600, Math.max(300, fittsDur(dist0, tgtW || 100) * 0.8))
        : fittsDur(dist0, tgtW || 80) * (0.85 + Math.random() * 0.3);
      if (mode) {
        dur = clamp(dur, 300, 600);              // 技能：滑动 300~600ms
      } else {
        dur = (dist0 / rand(400, 600)) * 1000 * (0.9 + Math.random() * 0.2);
        dur = clamp(dur, 500, 1500);             // 技能：拖拽 500~1500ms（按距离折算，2026-11-16）
      }
      var nx = -vy0 / dist0, ny = vx0 / dist0;
      var curveAmp = mode ? 0.05 : 0.12;
      var curve = rand(-curveAmp, curveAmp) * Math.min(dist0, 260);
      var jitter = rand(0.4, 2.2), freq = rand(2, 4.5), phase = rand(0, 6.28);
      var ease = makeEase();
      var cur = { x: a.x, y: a.y };
      var track = [];                                     // 试验：拖动轨迹采样（每 ~8% 一点）
      var lastSample = -1;
      var fixRound = 0;

      emit(n, cc.Node.EventType.TOUCH_START, a.x, a.y);

      function travel(from, to, ms, onDone) {
        var t0 = now();
        var ddx = to.x - from.x, ddy = to.y - from.y;
        var d2 = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
        var pnx = setN(-ddy / d2), pny = setN(ddx / d2);
        var pts = PATH_TEST ? makePathPts() : null;      // 试验：本次拖动的随机路径形状
        (function step() {
          var t = Math.min(1, (now() - t0) / ms);
          var e = ease(t), arc = Math.sin(Math.PI * t);
          var wob = Math.sin(Math.PI * t * freq + phase) * arc;
          // 只有拖拽（mode 为空）用随机曲线；滑动保持原来的小弧度——滑动可能被游戏按方向/直线度判定
          var lat = (pts && !mode) ? (pathOffset(t, pts) * dist0 * arc) : (curve * arc);
          var x = from.x + ddx * e + pnx * (lat + jitter * wob);
          var y = from.y + ddy * e + pny * (lat + jitter * wob);
          cur = { x: x, y: y };
          if (PATH_TEST) {
            var si = Math.floor(t * 8);
            if (si !== lastSample) { lastSample = si; track.push([Math.round(x), Math.round(y)]); }
          }
          emit(n, cc.Node.EventType.TOUCH_MOVE, x, y);
          if (t < 1) return setTimeout(step, rand(12, 22));      // 帧间隔 12~22ms
          onDone();
        })();
        function setN(v) { return v; }
      }

      // 过冲：远处拖动时先冲过目标 20~60px，再折回（真人手会"刹不住"）
      var osAmount = (dist0 > 400 && Math.random() < 0.7) ? rand(20, 60) : 0;
      var osPoint = osAmount ? {
        x: b.x + (vx0 / dist0) * osAmount,
        y: b.y + (vy0 / dist0) * osAmount
      } : null;

      setTimeout(function () {
        travel(a, osPoint || b, dur, function () {
          // ① 若安排了过冲，先把手指再往目标外侧送一点（真人「刹不住」）
          if (osPoint) {
            // 已经冲到过冲点 → 折回目标（80~160ms 的短修正，真人"回手"）
            osPoint = null;
            travel({ x: cur.x, y: cur.y }, b, rand(80, 160), fixOnce);
          } else {
            fixOnce();
          }
          // ③ 闭环微调（判定体是子节点/祖先的关卡需要）：最多 3 轮
          function fixOnce() {
            (function fix() {
              if (!plan.fit || !target || !target.worldPosition) return finish();
              var off = null;
              try { off = bestOffset(n, target, plan.fit); } catch (e) { off = null; }
              if (!off || (Math.abs(off.dx) < 2 && Math.abs(off.dy) < 2)) return finish();
              if (++fixRound > 3) return finish();
              var f2 = { x: cur.x, y: cur.y };
              var t2 = { x: cur.x + off.dx, y: cur.y + off.dy };
              travel(f2, t2, rand(60, 140), fix);                // 微调也用随机时长
            })();
          }
        });
      }, pressMs);

      function finish() {
        setTimeout(function () {
          emit(n, cc.Node.EventType.TOUCH_END, cur.x, cur.y);
          var rel = rand(0, 120);                                // 松手延迟 0~120ms
          recordGesture({
            type: mode ? 'swipe' : 'drag',
            node: n.name,
            target: (target && target.name) || (mode || ''),
            from: [Math.round(a.x), Math.round(a.y)],
            to: [Math.round(cur.x), Math.round(cur.y)],
            dur: Math.round(dur), press: Math.round(pressMs),
            curve: Math.round(curve), round: fixRound,
            path: PATH_TEST ? track.slice() : undefined
          });
          resolve(pressMs + dur + rel);                          // 返回动作总时长
        }, rand(0, 120));
      }
    });
  }

  function longPress(n, hold) {
    var p = randPointInRect(n, 0.2);
    var real = Math.max(300, hold || 800) + rand(150, 500);      // 长按余量 +150~500ms（技能口径）
    emit(n, cc.Node.EventType.TOUCH_START, p.x, p.y);
    // 本作长按判定会被 TOUCH_MOVE 打断（Level39 第 27 手实测）：这里不发微动，
    // 只保留随机按住时长；技能里的「手指微抖」在这款游戏属于会破坏判定的动作。
    return sleep(real).then(function () {
      emit(n, cc.Node.EventType.TOUCH_END, p.x, p.y);
      recordGesture({ type: 'hold', node: n.name, from: [Math.round(p.x), Math.round(p.y)], dur: Math.round(real), press: Math.round(real), curve: 0 });
      return real;
    });
  }

  // 来回擦（照掌勺 rub）：振幅 14~42、周期 30~60、方向 50% 随机、时长 = 要求 + 400~900ms
  function rub(n, seconds) {
    var p = randPointInRect(n, 0.2);
    var amp = rand(14, 42), vertical = Math.random() < 0.5, period = rand(30, 60);
    var until = now() + Math.max(800, (Number(seconds) || 1) * 1000 + rand(400, 900));
    var dir = 1, frames = 0;
    emit(n, cc.Node.EventType.TOUCH_START, p.x, p.y);
    return new Promise(function (resolve) {
      (function tick() {
        if (now() >= until) {
          emit(n, cc.Node.EventType.TOUCH_END, p.x, p.y);
          recordGesture({ type: 'rub', node: n.name, dur: Math.round(until - (until - 1000)), press: 0, curve: 0, orientation: vertical ? 'v' : 'h', points: frames });
          return resolve(until - (until - 1000));
        }
        var off = dir * amp;
        emit(n, cc.Node.EventType.TOUCH_MOVE, vertical ? p.x + rand(-2, 2) : p.x + off, vertical ? p.y + off : p.y + rand(-2, 2));
        dir = -dir; frames++;
        setTimeout(tick, period + rand(0, 12));
      })();
    });
  }

  // 区域擦除（照掌勺）：矩形内蛇形扫，inset 18~28 / 行距 36~52 / stepMs 16~34 / 方向随机
  function wipe(n, area) {
    var b = area && area.worldPos ? null : boxOf(n);
    if (!b) return Promise.resolve(0);
    var inset = rand(18, 28), gap = rand(36, 52);
    var vertical = Math.random() < 0.5, stepMs = rand(16, 34);
    var x0 = b.x + inset, x1 = b.x + b.w - inset, y0 = b.y + inset, y1 = b.y + b.h - inset;
    var pts = [], cur = y0, dir = 1;
    while (cur <= y1) { pts.push(dir > 0 ? [x0, cur] : [x1, cur]); dir = -dir; cur += gap; }
    var t0 = now();
    emit(n, cc.Node.EventType.TOUCH_START, pts[0][0], pts[0][1]);
    return new Promise(function (resolve) {
      var i = 1;
      (function step() {
        if (i >= pts.length) {
          emit(n, cc.Node.EventType.TOUCH_END, pts[pts.length - 1][0], pts[pts.length - 1][1]);
          recordGesture({ type: 'wipe', node: n.name, dur: Math.round(now() - t0), press: 0, curve: 0, orientation: vertical ? 'v' : 'h', points: pts.length, gap: Math.round(gap), stepMs: Math.round(stepMs) });
          return resolve(now() - t0);
        }
        emit(n, cc.Node.EventType.TOUCH_MOVE, pts[i][0], pts[i][1]);
        i++;
        setTimeout(step, stepMs);
      })();
    });
  }

  // ---------- 第 14 条：拿错道具（每关 1~3 次，(步骤,道具) 去重） ----------
  // 依据：h5-autoplay-pipeline/references/human-pacing-full.md 阶段 4.6；
  // 实现改写自 wlzs120/zlzs-autoplay-120.js 的 tryWrongPick（已实测 5 关 6 次、同一关 3 轮不重样）。
  // 本作没有 currentSceneConfig，候选直接取 GuideManager._steps 里「当前步以后第 3 步起」的拖拽源。
  var WKEY = 'dkgbhWrongHist';
  var WRONG = { on: true, lv: null, hist: [], done: 0, max: 0, ticks: 0, cycles: 0, last: null };
  function loadJ(k) { try { var o = JSON.parse(localStorage.getItem(k) || '{}'); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; } }
  function saveJ(k, o) { try { localStorage.setItem(k, JSON.stringify(o)); } catch (e) {} }
  function loadHist(lv) { var o = loadJ(WKEY), a = o[lv]; return Array.isArray(a) ? a : []; }
  function saveHist(lv, arr) { if (arr.length > 600) arr.splice(0, arr.length - 600); var o = loadJ(WKEY); o[lv] = arr; saveJ(WKEY, o); }
  function nodeKey(n) { try { return n && n.uuid ? n.uuid : (n && n.name) || ''; } catch (e) { return (n && n.name) || ''; } }
  function wrongEnter(lvName) {
    WRONG.lv = lvName || '?';
    WRONG.hist = loadHist(WRONG.lv);
    WRONG.done = 0;
    WRONG.max = 1 + Math.floor(Math.random() * 3);          // 每关 1~3 次（平均 2 次）
    WRONG.ticks = 2 + Math.floor(Math.random() * 4);        // 先做 2~5 个正常动作再错
    WRONG.cycles = 0;
    WRONG.last = null;
    log('wrong-level', WRONG.lv, 'max=' + WRONG.max, 'ticks=' + WRONG.ticks, 'histN=' + WRONG.hist.length);
  }
  function wrongCandidates(steps, curI) {
    var out = [];
    if (!steps || curI < 0 || curI >= steps.length) return out;
    var cur = steps[curI];
    var curSrc = resolveNode(cur[1], cur[2] && cur[2].worldPosition ? cur[2] : null);
    var curTgt = cur[2];
    var grp = groupKey(curTgt || curSrc);
    var used = {};
    // 关键：避开当前步与后两步，防止「提前做了」推进 step（wlzs 实测 1/5 会推进）
    for (var k = curI; k < Math.min(steps.length, curI + 3); k++) {
      var s0 = steps[k]; if (!s0) continue;
      if (s0[1]) used[nodeKey(s0[1])] = 1;
      if (s0[2]) used[nodeKey(s0[2])] = 1;
    }
    for (var j = curI + 3; j < steps.length; j++) {
      var s = steps[j]; if (!s) continue;
      if (Number(s[0]) !== 2) continue;                     // 只拿可拖道具，点击/滑动不制造「拿错」
      var n = resolveNode(s[1], s[2] && s[2].worldPosition ? s[2] : null);
      if (!n || !n.isValid || !n.activeInHierarchy || n === curSrc || n === curTgt) continue;
      if (used[nodeKey(n)]) continue;
      if (!listens(n) || !boxOf(n)) continue;
      if (grp && groupKey(n) !== grp) continue;             // 同一画面段，别拿别的段的道具
      if (/^(back|bj|cj|pic|Page|UI|Btn|button|addTime|next|close|skip|Pop)/i.test(n.name)) continue;
      var dup = false;
      for (var q = 0; q < out.length; q++) if (out[q].node === n) { dup = true; break; }
      if (!dup) out.push({ name: n.name, node: n });
    }
    return out;
  }
  function wrongDropPoint(ref, node) {
    var rb = boxOf(ref) || boxOf(node);
    if (!rb) return { x: 0, y: 0 };
    var boxes = blockersFor(node, ref);
    for (var i = 0; i < 16; i++) {
      var ang = Math.random() * Math.PI * 2, dist = rand(100, 240);
      var p = { x: rb.cx + Math.cos(ang) * dist, y: rb.cy + Math.sin(ang) * dist };
      if (p.x < 30 || p.x > 720 || p.y < 100 || p.y > 1500) continue;
      if (!pointBlocked(p.x, p.y, boxes)) return p;
    }
    return { x: rb.cx, y: rb.cy - 160 };                     // 全被挡：拖到目标上方空地
  }
  function tryWrongPick(steps, curI) {
    if (!WRONG.on) return false;
    if (curI < 2) return false;                            // 前 2 步不碰
    if (!steps || curI >= steps.length) return false;
    if (Number(steps[curI][0]) !== 2) return false;        // 只对拖拽步拿错
    if (WRONG.done >= WRONG.max) return false;
    if (WRONG.ticks > 0) { WRONG.ticks--; return false; }
    var cands = wrongCandidates(steps, curI);
    if (!cands.length) { WRONG.ticks = 1; return false; }  // 这会儿没有可错道具，下次再试
    var stepNo = curI + 1;
    var fresh = cands.filter(function (c) { return WRONG.hist.indexOf(stepNo + ':' + c.name) < 0; });
    var pool2;
    if (fresh.length) pool2 = fresh;
    else {
      WRONG.cycles++;
      if (WRONG.cycles < 6) { WRONG.ticks = 1; return false; }   // 先等，别直接清历史（清了就重复）
      WRONG.hist.length = 0;
      saveHist(WRONG.lv, WRONG.hist);
      WRONG.cycles = 0;
      pool2 = cands;
    }
    var pick = pool2[Math.floor(Math.random() * pool2.length)];
    var target = steps[curI][2];
    if (!target || !target.worldPosition) return false;
    WRONG.hist.push(stepNo + ':' + pick.name);
    saveHist(WRONG.lv, WRONG.hist);
    WRONG.done++;
    WRONG.cycles = 0;                                      // 错成功也清零，不能带入下一关
    WRONG.ticks = 2 + Math.floor(Math.random() * 4);
    WRONG.last = { step: stepNo, node: pick.name, at: now() };
    var dest = wrongDropPoint(target, pick.node);
    log('WRONGPICK', pick.name, 'step' + stepNo, 'lv' + WRONG.lv, 'done=' + WRONG.done + '/' + WRONG.max, 'to=' + Math.round(dest.x) + ',' + Math.round(dest.y));
    return drag(pick.node, target, null, { pt: dest, fit: null });   // 拖到空地，不占当前目标位
  }

  // ---------- 读关卡状态 ----------
  function levelComp() {
    var out = null;
    (function walk(n) {
      if (out || !n) return;
      for (var i = 0; i < (n._components || []).length; i++) {
        var c = n._components[i];
        if (c && typeof c.completeOneTip === 'function' && typeof c.start === 'function') { out = c; return; }
      }
      var ch = n.children || [];
      for (var k = 0; k < ch.length; k++) walk(ch[k]);
    })(cc.director.getScene());
    return out;
  }

  function pageGame() {
    var out = null;
    (function walk(n) {
      if (out || !n) return;
      for (var i = 0; i < (n._components || []).length; i++) {
        var c = n._components[i];
        if (c && typeof c.onTipPass === 'function' && typeof c.initGameData === 'function') { out = c; return; }
      }
      var ch = n.children || [];
      for (var k = 0; k < ch.length; k++) walk(ch[k]);
    })(cc.director.getScene());
    return out;
  }

  function state() {
    var g = Guide(), pg = pageGame(), lv = levelComp();
    return {
      guide: g ? { steps: (g._steps || []).length, cur: g._currentStep, done: (g.tiptrue || []).slice(0, (g._steps || []).length) } : null,
      tips: pg ? { state: (pg.nowlevelTipState || []).slice(), cur: pg.currentTipIndex, loaded: !!pg.isGameLoaded, paused: !!(app() && app().store ? false : false) } : null,
      level: lv ? { name: lv.node.name, locked: !!(lv.eventLock && lv.eventLock.active) } : null,
      timer: pg ? pg.countdownNum : null
    };
  }

  // 隐藏游戏自带的调试信息条（「非遗手作→第12页→关卡名」那条）与游玩提示摇杆
  // 依据：PageGame.setLevelPosShow() 会按 GameConfig.showIndexAndName 点亮 levelPos；演示不需要
  function hideDebugHud() {
    try {
      var names = { levelPos: 1, yaogan: 1 };
      (function walk(n) {
        if (!n) return;
        if (names[n.name] && n.active) { n.active = false; }
        var ch = n.children || [];
        for (var i = 0; i < ch.length; i++) walk(ch[i]);
      })(cc.director.getScene());
    } catch (e) {}
  }

  // ---------- 换画面信号（照掌勺思路：读游戏真值，不猜节点结构） ----------
  // 玩法关卡通常会提供自己的「换画面」动作（本作是 qieJingyi / qieJinger / qieJingsan）。
  // 它一被调用就是真换画面 → 下一步动手前停 3~5 秒；段内的小变化（画笔淡入、零件位移）不算。
  var pendingScene = false;
  var sceneHooks = [];
  var lastHookTarget = null;

  // 画面段索引 = 关卡 pic[] 里「位置最靠近屏幕中间」的那个段
  // 依据（读 Level0 源码 + 实测）：切镜就是 tween(pic[a]).to(-1200) + tween(pic[b]).to(0)，
  // 没有任何阶段字段；所以「谁的 x≈0」就是当前段 —— 等价于掌勺的 currentMiniLv。
  // 实测（Level0）：#0-5 段0 → #6 段1 → #11 段2，整关只 2 次换段。
  // ===== 等价于掌勺的 p.currentMiniLv（运行时装字段；游戏文件不改一个字节）=====
  // 掌勺那款游戏由程序维护「当前小关号」；本作没有这个字段（切镜是纯补间动画），
  // 所以在关卡组件上装一个同名语义的字段，由本层负责刷新；驱动只读字段。
  function installMiniLv(lv) {
    if (!lv || lv.__miniLvInstalled) return false;
    try { lv.__miniLvInstalled = true; } catch (e) { return false; }
    lv.currentMiniLv = -1;
    var now0 = segIndex(lv, true);   // 取基线时允许未移动的层（常驻层索引更大，argmin 仍落在真段上）
    if (now0 >= 0) lv.currentMiniLv = now0;      // 立刻刷一次，基线不留 -1
    var timer = setInterval(function () {
      if (!lv || !lv.isValid) { clearInterval(timer); return; }
      var k = segIndex(lv);
      if (k >= 0) lv.currentMiniLv = k;
    }, 120);
    return true;
  }

  function segIndex(lv, allowUnmoved) {
    try {
      if (!lv || !Array.isArray(lv.pic) || !lv.pic.length) return null;
      var best = -1, bestAbs = 1e9;
      for (var k = 0; k < lv.pic.length; k++) {
        var nd = lv.pic[k];
        if (!nd || !nd.isValid) continue;
        var x = nd.position.x;
        // 记录「这一层动过没有」：常驻 UI 层永远不动，不能当画面段（曾把它误判成第 6 段）
        if (nd.__lastX === undefined) nd.__lastX = x;
        else if (Math.abs(nd.__lastX - x) > 2) { nd.__moved = true; nd.__lastX = x; }
        if (!nd.__moved && !allowUnmoved) continue;   // 还没动过的层先不当段候选（取基线时例外）
        var abs = Math.abs(x);
        if (abs < bestAbs) { bestAbs = abs; best = k; }
      }
      // 补间过程中可能所有段都不在 0（正在滑），此时返回 -1（不判换段），等稳定再说
      return bestAbs < 300 ? best : -1;
    } catch (e) { return null; }
  }
  var SCENE_RE = /qieJing|cutScene|changeScene|nextScene|switchScene|goNextScene|playCut/i;

  function hookSceneMethods(lv) {
    if (!lv) return;
    if (lv !== lastHookTarget) { sceneHooks = []; lastHookTarget = lv; }   // 换关重置，别跨关累积
    if (lv.__sceneHooked) return;
    try { lv.__sceneHooked = true; } catch (e) { return; }
    var names = [];
    var proto = Object.getPrototypeOf(lv), guard = 0;
    while (proto && proto !== Object.prototype && guard++ < 8) {
      Object.getOwnPropertyNames(proto).forEach(function (n) { names.push(n); });
      proto = Object.getPrototypeOf(proto);
    }
    Object.keys(lv).forEach(function (n) { names.push(n); });
    names.filter(function (n, i) { return names.indexOf(n) === i; })
      .forEach(function (fn) {
        if (!SCENE_RE.test(fn) || typeof lv[fn] !== 'function') return;
        var orig = lv[fn];
        lv[fn] = function () {
          pendingScene = true;
          log('scene-hook', fn);
          return orig.apply(this, arguments);
        };
        sceneHooks.push(fn);
      });
    log('scene-hooks', sceneHooks.length ? sceneHooks.join(',') : '无（退回段名判据）');
  }

  var lastAddAt = 0;
  var addTimeAt = 0;      // 本关加时触发点：10~50 秒随机（每次加时后重抽，次数不清零）
  var addTimeTimes = 0;   // 本关已加时次数（技能第 15 条：每关最多 3 次）
  var ADD_TIME_MAX = 3;
  // 剩余时间见底就点「加时」（走游戏自己的按钮 → btn_addTime → setCountdown(+120)）
  function maybeAddTime() {
    try {
      var t = state().timer;
      if (t == null) return false;
      if (!addTimeAt) {
        addTimeAt = 10 + Math.random() * 40;                 // 10~50 秒随机，不是固定 100
        log('addtime-plan@' + addTimeAt.toFixed(1) + 's');
      }
      if (addTimeTimes >= ADD_TIME_MAX) return false;        // 每关最多 3 次
      if (t > addTimeAt || t < 10) return false;             // 只剩不到 10 秒就不加了（死线保护）
      if (now() - lastAddAt < 3000) return false;            // 3 秒内不重复点
      var btn = findByName('addTimeBtn');
      if (!btn) return false;
      lastAddAt = now();
      // 走 Button 的 clickEvents（等同玩家点一下）
      var b = btn.getComponent(cc.Button);
      if (b && b.clickEvents && b.clickEvents.length) {
        for (var i = 0; i < b.clickEvents.length; i++) {
          var e = b.clickEvents[i], tn = e.target || btn, cp = null;
          if (e.component) cp = tn.getComponent(e.component);
          if (!cp) { for (var j = 0; j < (tn._components || []).length; j++) { if (typeof tn._components[j][e.handler] === 'function') { cp = tn._components[j]; break; } } }
          if (cp) { cp[e.handler](e.customEventData); break; }
        }
      } else {
        var pg = pageGame();
        if (pg && typeof pg.btn_addTime === 'function') pg.btn_addTime();
      }
      addTimeTimes++;
      log('addtime@plan' + addTimeAt.toFixed(1), 'left' + t, '(' + addTimeTimes + '/' + ADD_TIME_MAX + ')');
      addTimeAt = 10 + Math.random() * 40;                   // 加完重抽：下一次又落在一个新的点
      log('addtime-plan@' + addTimeAt.toFixed(1) + 's');
      return true;
    } catch (err) { return false; }
  }

  // ===== 预加载下一关（把「关卡加载」的等待藏进当前关的拟人停顿里）=====
  // 依据：Cocos 3.8 的 bundle 缓存；PageGame.onHide 只 removeBundle(当前关)，预载的下一关不会被清掉。
  var preloaded = {};
  // 预载 bundle 内资源：用官方 bundle.preload(路径数组)
  // 依据（读引擎源码）：preload → preloadAny({__requestType__: PATH, bundle})，按 assetInfo 走，
  // 打包（pack）里的资源会从 pack 读；而 preloadDir 用 DIR 枚举文件，pack 资源没有独立文件 → 必然 404。
  var prefetched = {};
  function prefetchBundleAssets(bundle, name) {
    try {
      if (prefetched[name]) return;
      prefetched[name] = true;
      var cfg = bundle && bundle._config;
      if (!cfg || !cfg.paths || !cfg.paths._map) { log('prefetch-nocfg', name); return; }
      var paths = [];
      Object.keys(cfg.paths._map).forEach(function (key) { paths.push(key); });
      log('prefetch-start', name, paths.length + ' 个资源路径');
      var t0 = now();
      bundle.preload(paths, function (err) {
        if (err) log('prefetch-partial', name, String(err).slice(0, 60), Math.round(now() - t0) + 'ms');
        else log('prefetch-ok', name, Math.round(now() - t0) + 'ms');
      });
    } catch (e) { log('prefetch-err', String(e).slice(0, 80)); }
  }

  function preloadLevelBundle(idx) {
    try {
      if (idx == null) return;
      if (preloaded[idx]) return;
      preloaded[idx] = true;
      var mc = mod('chunks:///_virtual/modeConfig.ts');
      var list = mc && mc.cl_modeConfig && mc.cl_modeConfig.modeToLevelList.get('文字');
      var info = list && list[idx];
      if (!info || !info.bundle) return;
      var name = info.bundle;
      if (cc.assetManager.bundles.has(name)) { log('preload-skip', name, '已在内存'); return; }
      log('preload-start', name);
      var t0 = now();
      cc.assetManager.loadBundle(name, function (err, bundle) {
        if (err || !bundle) { log('preload-fail', name, String(err).slice(0, 60)); preloaded[idx] = false; return; }
        log('preload-bundle-ok', name, Math.round(now() - t0) + 'ms');
        // 关键：只 loadBundle 不够（110ms 就完了），关卡资源还得单独 preload
        // 技能实测：不 preload → readyAfter 7~12s；preload → 接近 0
        try {
          var P = (bundle._config && bundle._config.paths && bundle._config.paths._map) || null;
          var paths = P ? Object.keys(P) : null;
          if (paths && paths.length) {
            var t1 = now();
            bundle.preload(paths, function (e2) {
              // 有报错是常态（部分资源按需加载），不当失败
              log('preload-assets-ok', name, paths.length + ' paths', Math.round(now() - t1) + 'ms', e2 ? ('err=' + String(e2).slice(0, 40)) : '');
            });
          } else {
            prefetchBundleAssets(bundle, name);   // 拿不到路径表时退回自己拼 URL
          }
        } catch (e2) { log('preload-assets-err', String(e2).slice(0, 60)); }
      });
    } catch (e) { log('preload-err', String(e).slice(0, 80)); }
  }

  function popShown(name) {
    var found = null;
    (function walk(n) {
      if (found || !n) return;
      // 2026-11-16 远山按历史 Pi 实测恢复严格父节点校验：
      // 真实路径 /UIRoot/Root2D/UserInterface/Pop/PopVictory；
      // 名字对、激活、且 parent.name==='Pop' 才算数。
      if (n.name === name && n.activeInHierarchy && n.parent && n.parent.name === 'Pop') { found = n; return; }
      var ch = n.children || [];
      for (var k = 0; k < ch.length; k++) walk(ch[k]);
    })(cc.director.getScene());
    return found;
  }

  // ---------- 主流程：打完一关 ----------
  var STOP = false;
  root.__AUTO = {
    log: LOG,
    state: state,
    groupKey: groupKey,
    status: function () {
      var st = state();
      return {
        level: st.level, timer: st.timer, tips: st.tips,
        gestures: GESTURES.slice(),
        lastGesture: GESTURES.length ? GESTURES[GESTURES.length - 1] : null,
        wrong: { done: WRONG.done, max: WRONG.max, ticks: WRONG.ticks, lv: WRONG.lv, histN: WRONG.hist.length, last: WRONG.last },
        addTime: { at: addTimeAt, times: addTimeTimes, max: ADD_TIME_MAX }
      };
    },
    stop: function () { STOP = true; },
    addTime: function () { return { addTimeAt: addTimeAt, lastAddAt: lastAddAt, times: addTimeTimes, max: ADD_TIME_MAX }; },
    levelComp: levelComp,
    pressNode: function (name) {
      var n = findByName(name);
      if (!n) return 'NO-NODE';
      return pressButton(n);
    },
    // 进入第 idx 关（mode 默认 '文字'）
    enter: function (idx, mode) {
      var a = app();
      if (!a) return 'NO-APP';
      // 2026-11-14 修复内存线性增长（跑几小时浏览器崩溃的真因）：
      //   实测 40 关 38 个关卡包、19000+ 资源、进程 4.5GB；单关 bundle 直接
      //   releaseAll() 实测 583→195 个资源（释放 67%），说明引擎能释放，
      //   只是游戏切关流程从没调用到（PageGame.onHide 的 removeBundle 时机/数据不对）。
      // 2026-11-15：只记录上一关的 bundle 名，真正释放推迟到 playLevel 里「新关已就绪」之后
      //   （见 releasePrevLevel）。在 enter 时释放会把渲染队列/onEnable 要用的
      //   SpriteFrame/材质一起销毁 → updateUVs / getSharedMaterial 报错刷屏。
      try {
        var gcM = mod('chunks:///_virtual/GameConfig.ts');
        var gc = gcM && gcM.GameConfig;
        if (gc && gc.levelInfo && gc.levelInfo.bundle) pendingReleaseBundle = gc.levelInfo.bundle;
      } catch (e) { log('release-pending-err', String(e).slice(0, 60)); }
      a.manager.ui.show({ name: 'PopLoad', data: { mode: mode || '文字', index: idx } });
      return 'ok';
    },
    // 单步诊断（带重试），返回 {before, after, tries}
    debugStep: function (i, retries, maxStepMs) {
      var g = Guide();
      if (!g || !g._steps || !g._steps[i]) return Promise.resolve({ before: null, after: null, tries: 0, err: 'no-step' });
      var s = g._steps[i];
      var before = !!g.tiptrue[i];
      var tries = 0;
      var maxTry = (Number(s[0]) === 3) ? 8 : (Number(s[0]) === 2 ? 12 : 4);
      function attempt() {
        tries++;
        return execStep(s, tries - 1).then(function () {
          return waitFor(function () { return g.tiptrue[i] || winLatched() || failLatched(); }, maxStepMs || 6000, 100);
        }).then(function (r) {
          if (r.ok || tries >= maxTry) return { before: before, after: !!g.tiptrue[i], tries: tries, ms: r.ms, resolved: (function () { try { var t = resolveNode(s[1], (s[2] && s[2].worldPosition) ? s[2] : null); return t && t.name; } catch (e) { return null; } })() };
          return waitFor(function () {
            var lv = levelComp();
            return !(lv && lv.eventLock && lv.eventLock.active);
          }, 6000, 100).then(attempt);
        });
      }
      return attempt();
    },
    // 打完当前关；返回收工原因
    playLevel: playLevel,
    // 按任意顺序连打（洗牌用）
    runList: runList,
    // 打完当前关 + 点下一关
    run: run
  };

  // 每 2 秒兜底清一次卡住的加载圈（远山 2026-11-15 反馈的橙色转圈）
  try { setInterval(killStuckLoading, 2000); } catch (e) {}

  function findByName(name) {
    var out = null;
    (function walk(n) {
      if (out || !n) return;
      if (n.name === name && n.activeInHierarchy) { out = n; return; }
      var ch = n.children || [];
      for (var k = 0; k < ch.length; k++) walk(ch[k]);
    })(cc.director.getScene());
    return out;
  }
  function pressButton(node) {
    var b = node.getComponent(cc.Button);
    if (!b) return 'NO-BUTTON';
    var evs = b.clickEvents || [];
    if (!evs.length) return 'NO-CLICK';
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i], t = e.target || node, comp = null;
      if (e.component) comp = t.getComponent(e.component);
      if (!comp) {
        for (var j = 0; j < (t._components || []).length; j++) {
          if (typeof t._components[j][e.handler] === 'function') { comp = t._components[j]; break; }
        }
      }
      if (comp) { try { comp[e.handler](e.customEventData); return 'ok:' + e.handler; } catch (err) { return 'ERR:' + err; } }
    }
    return 'NO-HANDLER';
  }

  // 等某个条件成立（带死线与稳定计数）
  function waitFor(fn, timeout, poll) {
    var t0 = now();
    return new Promise(function (resolve) {
      (function tick() {
        if (WATCH_VICTORY && (winLatched() || failLatched())) {
          var vw = vdbgSnap(); vw.t = Date.now(); vw.fn = 'waitFor'; vw.timeout = timeout; vw.win = winLatched(); vw.fail = failLatched(); vw.stack = (new Error()).stack;
          vdbgPush(VDBG.early, vw);
          return resolve({ ok: true, ms: now() - t0, victory: winLatched(), fail: failLatched() });
        }
        var v = false;
        try { v = fn(); } catch (e) { v = false; }
        if (v) return resolve({ ok: true, ms: now() - t0 });
        if (now() - t0 > (timeout || 8000)) return resolve({ ok: false, ms: now() - t0 });
        setTimeout(tick, poll || 120);
      })();
    });
  }

  // 终局等待：只等本关锁存；面板闪一下也算数，不要求稳定可见
  function waitForFinal(fn, timeout, poll) {
    var t0 = now();
    return new Promise(function (resolve) {
      (function tick() {
        sampleLatches('final-wait');
        var v = false;
        try { v = fn(); } catch (e) { v = false; }
        if (v) return resolve({ ok: true, ms: now() - t0 });
        if (now() - t0 > (timeout || 30000)) return resolve({ ok: false, ms: now() - t0 });
        setTimeout(tick, poll || 200);
      })();
    });
  }

  // 等关卡真的活了（组件在、事件锁解开）
  function waitReady(timeout) {
    return waitFor(function () {
      var lv = levelComp();
      if (!lv) return false;
      if (lv.eventLock && lv.eventLock.active) return false;
      var pg = pageGame();
      return !!(pg && pg.isGameLoaded);
    }, timeout || 30000, 150);
  }

  // 滑动候选：步骤表的节点/方向不一定对（实测 Level6 第 27 手：表里写 shanghua+right，
  // 真判定却挂在 youhua 上）。所以按「原样 → 同父兄弟 → 其他方向」轮，用 tiptrue 验收。
  function swipeCandidates(node, dir) {
    var all = ['right', 'left', 'up', 'down'];
    var others = all.filter(function (d) { return d !== dir; });
    var out = [{ n: node, d: dir }];
    var sibs = [];
    try {
      sibs = ((node.parent && node.parent.children) || [])
        .filter(function (c) { return c !== node && c.activeInHierarchy && listens(c); });
      var w = node.worldPosition;
      sibs.sort(function (a, b) { return dist2(a.worldPosition, w) - dist2(b.worldPosition, w); });
    } catch (e) { sibs = []; }
    for (var i = 0; i < sibs.length && i < 4; i++) out.push({ n: sibs[i], d: dir });
    for (var j = 0; j < others.length; j++) out.push({ n: node, d: others[j] });
    for (var k = 0; k < sibs.length && k < 4; k++) {
      for (var m = 0; m < others.length; m++) out.push({ n: sibs[k], d: others[m] });
    }
    return out;
  }

  // 源节点候选：步骤表给的节点可能根本不该拖（实测 Level7 第 15 手：表里是关着的 anbandaijiLi，
  // 真判定挂在同父的 qiekaideli 上）→ 原节点优先，然后同父 active 且挂监听的兄弟（按离目标近→远）
  function dragSources(node, target) {
    var out = [];
    if (node && node.isValid && node.activeInHierarchy) out.push(node);
    var sibs = [];
    try {
      sibs = ((node && node.parent && node.parent.children) || [])
        .filter(function (c) { return c !== node && c.activeInHierarchy && listens(c); });
      var tw = target && target.worldPosition;
      if (tw) sibs.sort(function (a, b) { return dist2(a.worldPosition, tw) - dist2(b.worldPosition, tw); });
    } catch (e) { sibs = []; }
    for (var i = 0; i < sibs.length && i < 8; i++) out.push(sibs[i]);
    if (!out.length && node) out.push(node);
    return out;
  }

  // 落点计划列表：关卡判定体可能是 target 自己、target 的祖先（实测 Level7 第 33 手：
  // 判定用 datieguo.contains，而步骤表给的 target 是锅的子节点蒸笼），也可能是被拖节点的某个子节点
  // 顺序：target 中心 → target 祖先 → 对齐源节点子件 → 对齐源节点自己
  // 量残差：把指定的「判定体」对准目标中心还差多少
  function bestOffset(node, target, fit) {
    var tb = boxOf(target);
    if (!tb) return null;
    var b = fit ? boxOf(fit) : boxOf(node);
    if (!b) return null;
    return { dx: tb.cx - b.cx, dy: tb.cy - b.cy };
  }

  function planList(node, target) {
    var out = [];
    var tb = boxOf(target);
    var w = node.worldPosition;
    if (!tb) return [{ pt: { x: w.x, y: w.y }, fit: null }];
    out.push({ pt: { x: tb.cx, y: tb.cy }, fit: null });
    var anc = target.parent, lvl = 0;
    while (anc && lvl < 2) {
      var ab = boxOf(anc);
      if (ab && (Math.abs(ab.cx - tb.cx) > 2 || Math.abs(ab.cy - tb.cy) > 2)) out.push({ pt: { x: ab.cx, y: ab.cy }, fit: null });
      anc = anc.parent; lvl++;
    }
    var kids = (node.children || []).filter(function (c) { return c.activeInHierarchy; })
      .map(function (c) { return { n: c, b: boxOf(c) }; }).filter(function (o) { return !!o.b; });
    kids.sort(function (a, b) { return a.b.w * a.b.h - b.b.w * b.b.h; });
    if (kids.length) out.push({ pt: { x: tb.cx, y: tb.cy }, fit: kids[0].n });
    if (boxOf(node)) out.push({ pt: { x: tb.cx, y: tb.cy }, fit: node });
    // 再补 3 个矩形内随机点（内缩 24%）：单点失手时换点，不换目标
    for (var r = 0; r < 3; r++) {
      var rp = randPointInRect(target, 0.24);
      out.push({ pt: rp, fit: null });
    }
    return out;
  }

  // 点击候选：步骤表节点可能是错的（实测 Level10 第 9 手：表写 yuankuang，真监听到 dianYuanKuang 上）
  function clickCandidates(node) {
    var out = [node];
    var sibs = [];
    try {
      sibs = ((node && node.parent && node.parent.children) || [])
        .filter(function (c) { return c !== node && c.activeInHierarchy && listens(c); });
      var w = node.worldPosition;
      sibs.sort(function (a, b) { return dist2(a.worldPosition, w) - dist2(b.worldPosition, w); });
    } catch (e) { sibs = []; }
    for (var i = 0; i < sibs.length && i < 6; i++) out.push(sibs[i]);
    return out;
  }

  function execStep(step, tryIdx) {
    var type = Number(step[0]);
    var raw = step[1], b = step[2], c = step[3];
    var a = resolveNode(raw, (b && b.worldPosition) ? b : null);
    if (type === 1) {
      var cc1 = clickCandidates(a);
      return click(cc1[(tryIdx || 0) % cc1.length]);
    }
    if (type === 6) return rub(a, 1);                     // 预留：来回擦
    if (type === 7) return wipe(a);                        // 预留：区域擦除
    if (type === 2) {
      if (!(b && b.worldPosition)) return drag(a, b, null, { pt: null, fit: null });
      var k = tryIdx || 0;
      var srcActive = !!(a && a.isValid && a.activeInHierarchy);
      if (srcActive) {
        // 源可用：只调落点（target 中心 → 祖先 → 子件对齐 → 自身对齐）
        var plans = planList(a, b);
        var plan = plans[k % plans.length];
        return drag(a, b, null, plan);
      }
      // 源被关（步骤表指错了）：换同父 active 且挂监听的兄弟，落点用 target 中心
      var srcs = dragSources(a, b);
      var src = srcs[k % srcs.length];
      var tb = boxOf(b);
      var pt = tb ? { x: tb.cx, y: tb.cy } : null;
      return drag(src, b, null, { pt: pt, fit: null });
    }
    if (type === 3) {
      var cands = swipeCandidates(a, typeof b === 'string' ? b : 'up');
      var pick = cands[Math.min(tryIdx || 0, cands.length - 1)];
      return drag(pick.n, null, pick.d);
    }
    if (type === 4) return longPress(a, (typeof b === 'number' ? b : 800) + (tryIdx || 0) * 600);
                                                          // 长按卡住就一次比一次按得久（Level39 第 27 手 800 不够、1200 成功）
    if (type === 5) return multiClick(a, typeof b === 'number' ? b : 3);
    return Promise.resolve(false);
  }

  function playLevel(opts) {
    opts = opts || {};
    addTimeAt = 0;                        // 新一关：加时触发点重新随机
    addTimeTimes = 0;                     // 新一关：加时次数清零（技能第 15 条）
    var maxStepMs = opts.maxStepMs || 12000;
    var retries = opts.retries || 4;
    var deadline = opts.deadlineMs || 600000;
    var t0 = now();
    var reason = 'unknown';
    var vWatch = null, pWatch = null;
    LEVEL_GEN++; VDBG.gen = LEVEL_GEN;
    vdbgPush(VDBG.levels, { t: Date.now(), gen: LEVEL_GEN, ev: 'start' });
    WIN_LATCHED = null; FAIL_LATCHED = null;
    WATCH_VICTORY = true;
    vdbgPush(VDBG.resets, { t: Date.now(), gen: LEVEL_GEN, ev: 'start' });
    var lastPv = false, lastPf = false;
    pWatch = setInterval(function () {
      try {
        var pv = !!popShown('PopVictory'), pf = !!popShown('PopFail');
        if (pv !== lastPv) { vdbgPush(VDBG.panels, { t: Date.now(), gen: LEVEL_GEN, name: 'PopVictory', on: pv }); lastPv = pv; }
        if (pf !== lastPf) { vdbgPush(VDBG.panels, { t: Date.now(), gen: LEVEL_GEN, name: 'PopFail', on: pf }); lastPf = pf; }
      } catch (e) {}
      sampleLatches('panel-watch');
    }, 80);
    vWatch = setInterval(function () {
      if (!WATCH_VICTORY) return;
      sampleLatches('victory-watch');
    }, 150);

    return waitReady(240000).then(function (r) {   // 公网首次加载关卡要几百个请求，给 4 分钟
      if (!r.ok) { reason = 'not-ready'; return null; }
      // 本关资源已就绪 → 放开预缓存闸门（公网版：先保游戏能玩，再后台缓存整包）
      try { window.__dkgbhPrecacheGo = true; } catch (e) {}
      // 2026-11-15：新关已就绪（节点和资源都换好了）→ 这时才释放上一关的 bundle。
      //   早一帧释放会把 onEnable/渲染队列要用的 SpriteFrame、材质一起销毁，
      //   产生 updateUVs / getSharedMaterial 报错（实测 5000+）。
      releasePrevLevel();
      var g = Guide();
      if (!g || !g._steps || !g._steps.length) { reason = 'no-steps'; return null; }
      var steps = g._steps;
      log('steps=' + steps.length);
      hideDebugHud();
      var lv0 = levelComp();
      hookSceneMethods(lv0);
      installMiniLv(lv0);                    // 装上 currentMiniLv（运行时字段）
      var lvName = lv0 && lv0.node ? lv0.node.name : (opts.levelName || '');
      wrongEnter(lvName || '?');   // 每关 1~3 次拿错道具
      // 用「开局观察」的空窗预加载下一关（不抢当前关的加载带宽）
      if (opts.nextIdx != null) {
        setTimeout(function () { preloadLevelBundle(opts.nextIdx); }, rand(3000, 5000));
      }
      // 开局观察：对数正态 4.2s 中位（2.6~9s），不是均匀 3~5 秒
      var introMs = opts.introMs != null ? opts.introMs : humanGap(4200, 2600, 9000, 0.03);
      var tReady = now();
      log('intro-start', 'readyAfter=' + Math.round((tReady - t0) / 1000) + 's', 'intro=' + Math.round(introMs) + 'ms');
      return sleep(introMs).then(function () {
        log('intro-end', 'total=' + Math.round((now() - t0) / 1000) + 's');
        var i = 0, actMs = 0, carryTail = 0;
        var lastMini = null, lastStep = -1, lastGroup = null, useFieldMode = true;
        var lastProgressAt = now(), lastSeenI = -1, lastSeenDone = -1;
        function trackProgress() {
          var doneNow = 0;
          try { doneNow = countDone(g); } catch (e) {}
          if (i !== lastSeenI || doneNow !== lastSeenDone) {
            lastSeenI = i; lastSeenDone = doneNow; lastProgressAt = now();
          }
        }
        // 进关基线：把「当前段」先标记成会动的层（否则第一次换段判不出来）
        (function markCurrentSeg() {
          try {
            var lv = levelComp();
            if (!lv || !Array.isArray(lv.pic)) return;
            for (var k = 0; k < lv.pic.length; k++) {
              var nd = lv.pic[k];
              if (!nd || !nd.isValid) continue;
              if (Math.abs(nd.position.x) < 300) { nd.__moved = true; nd.__lastX = nd.position.x; break; }
            }
          } catch (e) {}
        })();
        lastMini = (levelComp() || {}).currentMiniLv;   // 进关基线段号（读字段，出生就记一次）
        log('seg-base', lastMini);

        function next() {
          if (STOP) { reason = 'stopped'; return null; }
          if (now() - t0 > deadline) { reason = 'timeout'; return null; }
          if (winLatched()) { reason = 'win'; return null; }
          if (failLatched()) { reason = 'lose'; return null; }
          trackProgress();
          if (now() - lastProgressAt > 30000) {              // 技能第 24 条：30 秒无进度 → 换下一关
            log('stall-giveup', 'no-progress-30s', 'step=' + i);
            reason = 'stall-giveup';
            return null;
          }
          maybeAddTime();
          // Level25 幽灵步骤：步骤表 step52 是重复的 ShaoZi→jiePanZi，
          // 但 Level25.ts 的 ShaoZi 拖拽处理器只到 step51；step51 后游戏激活 ShaoZiYao，
          // 实际下一手是 step53（ShaoZiYao→GuanZi）。这条没有游戏处理器，直接跳过。
          if (lvName === 'Level25' && i === 52 && steps[52] && steps[53]) {
            var s52 = steps[52], s53 = steps[53];
            if (s52[1] && s52[1].name === 'ShaoZi' && s53[1] && s53[1].name === 'ShaoZiYao') {
              log('skip-phantom-step', 'Level25 step52 ShaoZi->jiePanZi', '→ step53 ShaoZiYao->GuanZi');
              try { g.tiptrue[52] = true; } catch (e) {}   // 只推进计数；游戏真值由 step53 的 completeOneTip 推动
              i++;
            }
          }
          while (i < steps.length && g.tiptrue[i]) i++;
          if (i >= steps.length) {
            // 全部完成：等收尾演出 + GameWin（末步演出可能 10 秒以上，例：第 2 关盖章 8.1s）
            log('final-wait-start');
            return waitForFinal(function () { return winLatched() || failLatched(); }, 30000, 200).then(function (r) {
              reason = winLatched() ? 'win' : (failLatched() ? 'lose' : 'alltips-no-victory');
              log('final-wait-end', 'ok=' + (r && r.ok), 'ms=' + (r && r.ms), 'winLatch=' + winLatched(), 'failLatch=' + failLatched(), 'done=' + allTipsDone());
              return null;
            });
          }
          var step = steps[i];
          var node = step[1];
          // —— 换段判断（照掌勺：用「要做的这一步」的组跟上次比，不同就先停再做）——
          // ===== 严格照《我来掌勺》wlzs-autoplay.js 的 tick() 骨架 =====
          //   var miniNow = p.currentMiniLv, stepNow = p.currentStepNum;
          //   var sameGroup = (miniNow === lastMini && stepNow === lastStep);
          //   repeat ? 80+rand*270 : sameGroup ? 250+rand*650 : 1000+rand*2000
          //   lastMini = miniNow; lastStep = stepNow;
          //   waitUntil = now + max(dur*1000 + 650 + rand(0,350), gap)
          var lvNow = levelComp();
          var miniNow = lvNow ? lvNow.currentMiniLv : null;   // == p.currentMiniLv（掌勺同一行）
          var grp = groupKey(node);                          // 结构兜底用
          var stepNow = i;                          // == currentStepNum
          // 换画面判据（字段优先、段名兜底，并做防抖）
          // 防抖原因：段名（源节点祖先）会比画面真的切完早 1~2 步；字段要等补间结束才变。
          // 不防抖时同一次换画面会停两遍（实测第 1 关 step3 段名、step4 字段各停一次）。
          var segChanged = (miniNow !== null && miniNow >= 0 && lastMini >= 0 && miniNow !== lastMini);
          var nameChanged = (lastGroup !== null && grp !== lastGroup);
          var miniChanged = false;
          if (useFieldMode) {
            if (segChanged) { miniChanged = true; log('seg-field', miniNow, 'prev=' + lastMini); }
            else if (nameChanged) {
              // 段名变了但段号字段没跟上 → 这关的字段不可信，永久切到结构兜底
              useFieldMode = false; miniChanged = true; log('seg-switch-name', grp);
            }
          } else {
            if (nameChanged) { miniChanged = true; log('seg-name', grp); }
          }
          var sameGroup = !miniChanged && (stepNow === lastStep);
          var gap;
          // 间隔全部用「对数正态」（真人节奏：大量中等间隔 + 少数长停顿）
          // 连击档在 multiClick() 里；同组重试档在 attempt() 的重试前。
          if (sameGroup) gap = humanGap(520, 250, 900, 0.03);
          else if (miniChanged) gap = humanGap(1800, 1000, 3000, 0.03);   // 换画面段（组间 1000~3000，技能口径）
          else gap = humanGap(1800, 1000, 3000, 0.05);                      // 同段换步骤（组间 1000~3000，技能口径）
          var prevMini = lastMini;                 // 留给日志用（更新前的值）
          if (miniNow !== null && miniNow >= 0) lastMini = miniNow;
          lastGroup = grp;
          lastStep = stepNow;
          var waitGap = Math.max(carryTail || 0, gap);     // 照掌勺：max(动画余量, 下一拍 gap)，不是相加
          carryTail = 0;
          var pre = Promise.resolve();
          if (waitGap > 1200) {
            log('gap', 'mini=' + miniNow + '(prev=' + prevMini + ')', 'step=' + stepNow, Math.round(waitGap) + 'ms');
            pre = sleep(waitGap);
          }
          var tries = 0;
          var t2 = Number(step[0]);
          var waitMs = (t2 === 3) ? 1500 : (t2 === 2 ? 1500 : (t2 === 1 ? 1200 : maxStepMs));
          var maxTry = (t2 === 3) ? 10 : (t2 === 2 ? 16 : (t2 === 1 ? 8 : retries));
          // （不再因时间紧收敛重试次数：时间不够就加时）

          function attempt() {
            if (STOP) { reason = 'stopped'; return null; }
            if (now() - t0 > deadline) { reason = 'timeout'; return null; }
            if (winLatched()) { reason = 'win'; return null; }
            if (failLatched()) { reason = 'lose'; return null; }
            trackProgress();
            if (now() - lastProgressAt > 30000) {              // 30 秒零进度 → 换下一关，绝不重进
              log('stall-giveup', 'no-progress-30s', 'step=' + i);
              reason = 'stall-giveup';
              return null;
            }
            if (!node || !node.isValid) { i++; return next(); }
            tries++;
            // 发动作前先对齐到已知状态：关卡的 eventLock（演出/动画期间）关掉再动手
            return waitFor(function () {
              var lv = levelComp();
              return !(lv && lv.eventLock && lv.eventLock.active);
            }, 10000, 80).then(function () {
              // 第 14 条：先看要不要拿错道具（只对拖拽步；错完等游戏弹回，再做正常步）
              var wp = false;
              try { wp = tryWrongPick(steps, i); } catch (e) { log('wrong-err', String(e).slice(0, 80)); }
              if (wp) {
                return wp.then(function () {
                  return sleep(humanGap(1800, 1000, 3000, 0.04));
                }).then(function () {
                  return next();
                }).then(function () {
                  return { stop: true };
                });
              }
              return execStep(step, tries - 1).then(function (d) {
                actMs = d || 0;
                if (tries === 1) hideDebugHud();
                return { stop: false };
              });
            }).then(function (wr) {
              if (wr && wr.stop) return null;
              return waitFor(function () { return g.tiptrue[i] || winLatched() || failLatched(); }, waitMs, 120);
            }).then(function (r2) {
              if (r2 && r2.ok) {
                // 照掌勺：下一拍等 = max(动画时长 + 650 + rand(0,350), 下一拍的 gap)
                carryTail = (actMs || 0) + 650 + Math.random() * 350;
                actMs = 0;
                i++;
                return next();
              }
              if (tries >= maxTry) {
                log('stall-giveup', 'step-stuck', 'step=' + i, 'type', step[0], node && node.name);
                reason = 'stall-giveup';                       // 技能第 24 条：跳下一关，不重进
                return null;
              }
              return waitFor(function () {
                var lv = levelComp();
                return !(lv && lv.eventLock && lv.eventLock.active);
              }, 8000, 120).then(function () {
                return sleep(humanGap(520, 250, 900, 0.03));  // 同组重试档
              }).then(attempt);
            });
          }
          return pre.then(function () { return attempt(); });
        }
        return next();
      });
    }).then(function () {
      var st = state();
      var total = st.guide ? st.guide.steps : 0;
      var done = st.guide ? st.guide.done.slice(0, total).filter(Boolean).length : 0;
      var out = { reason: reason, tips: done + '/' + total, ms: now() - t0, timer: st.timer };
      log('level-done', JSON.stringify(out));
      return out;
    }).then(function (out) {
      vdbgPush(VDBG.levels, { t: Date.now(), gen: LEVEL_GEN, ev: 'end', reason: out && out.reason, tips: out && out.tips, ms: out && out.ms });
      WATCH_VICTORY = false;
      vdbgPush(VDBG.resets, { t: Date.now(), gen: LEVEL_GEN, ev: 'end' });
      if (vWatch) { clearInterval(vWatch); vWatch = null; }
      if (pWatch) { clearInterval(pWatch); pWatch = null; }
      return out;
    }, function (err) {
      vdbgPush(VDBG.levels, { t: Date.now(), gen: LEVEL_GEN, ev: 'error', err: String(err) });
      WATCH_VICTORY = false;
      vdbgPush(VDBG.resets, { t: Date.now(), gen: LEVEL_GEN, ev: 'end-err' });
      if (vWatch) { clearInterval(vWatch); vWatch = null; }
      if (pWatch) { clearInterval(pWatch); pWatch = null; }
      throw err;
    });
  }

  // 换关前先关认识的弹窗（技能第 20 条）；胜利面板要等「看结算」停顿结束后再关
  // 第 17 条说明：本作结算面板的「下一关」按钮走游戏固定顺序，和洗牌队列冲突；
  // 按技能第 17 条的例外，改用 enter(idx) 指定关号，不点面板按钮。
  // 面板本身仍会先停留 1.2~3 秒（第 16 条），观众看得到结算。
  function closePopups() {
    var names = ['PopVictory', 'PopFail', 'PopLoad', 'PopAd', 'PopReward', 'PopSign', 'PopShare', 'PopTips'];
    for (var i = 0; i < names.length; i++) {
      var n = popShown(names[i]);
      if (n) {
        try { app().manager.ui.hide({ name: names[i] }); } catch (e) {}
        try { n.active = false; } catch (e) {}
      }
    }
  }

  // 按给定顺序列表连打（洗牌轮换用）
  function runList(list, opts) {
    opts = opts || {};
    var results = [];
    var k = 0;
    function one() {
      if (STOP || k >= list.length) return Promise.resolve(results);
      var idx = list[k];
      var r0;
      return Promise.resolve()
        .then(function () {
          closePopups();
          return sleep(humanGap(650, 350, 1200, 0.03));   // 收弹窗 0.35~1.2s（第 20 条）
        })
        .then(function () { return root.__AUTO.enter(idx, opts.mode); })
        .then(function () { return sleep(humanGap(900, 500, 1500, 0.03)); })   // 切关动画不动手（第 19 条）
        .then(function () {
          var o2 = {}; for (var kk in opts) o2[kk] = opts[kk];
          o2.nextIdx = (k + 1 < list.length) ? list[k + 1] : null;   // 预加载目标
          return playLevel(o2);
        })
        .then(function (r) {
          if (r && (r.reason === 'not-ready' || r.reason === 'no-steps')) {
            // 首次进关可能比引擎就绪还早：退回去重进一次（这是加载失败，不是卡关，允许一次）
            log('retry-enter', idx, r.reason);
            closePopups();
            return sleep(humanGap(2000, 1000, 3000, 0.03))
              .then(function () { return root.__AUTO.enter(idx, opts.mode); })
              .then(function () { return sleep(humanGap(1800, 1100, 3000, 0.03)); })
              .then(function () {
                var o2 = {}; for (var kk in opts) o2[kk] = opts[kk];
                o2.nextIdx = (k + 1 < list.length) ? list[k + 1] : null;
                return playLevel(o2);
              });
          }
          return r;
        })
        .then(function (r) {
          r0 = r || { reason: 'null' };
          r0.index = idx;
          results.push(r0);
          if (opts.onLevelResult) { try { opts.onLevelResult(r0); } catch (e) {} }
          log('LEVEL', idx, r0.reason, r0.tips);
          k++;
          // 第 16 条：胜利面板出现后先看 1.2~3 秒；非胜利也停 0.9~1.8 秒再切
          var pause = (r0.reason === 'win') ? humanGap(2800, 2500, 3000, 0.02) : humanGap(1200, 900, 1800, 0.03);
          log('level-pause', Math.round(pause) + 'ms', r0.reason);
          return sleep(pause).then(one);
        });
    }
    return one();
  }

  // 从关卡 from 连打 count 关（顺序模式）
  function run(from, count, opts) {
    var list = [];
    for (var i = from; i < from + count; i++) list.push(i);
    return runList(list, opts);
  }

  function run_legacy(from, count, opts) {
    opts = opts || {};
    var results = [];
    var idx = from;
    function one() {
      if (STOP) return Promise.resolve(results);
      if (idx >= from + count) return Promise.resolve(results);
      var r0;
      return Promise.resolve()
        .then(function () {
          // 清掉上一关的弹窗
          if (popShown('PopVictory')) { try { var a = app(); a.manager.ui.hide({ name: 'PopVictory' }); } catch (e) {} }
          if (popShown('PopFail')) { try { var a2 = app(); a2.manager.ui.hide({ name: 'PopFail' }); } catch (e) {} }
          return sleep(413 + Math.random() * 517);   // 收弹窗：413~930ms 随机
        })
        .then(function () { return root.__AUTO.enter(idx, opts.mode); })
        .then(function () { return sleep(877 + Math.random() * 803); })   // 等关卡起：877~1680ms 随机
        .then(function () {
          var o2 = {}; for (var kk in opts) o2[kk] = opts[kk];
          o2.nextIdx = (k + 1 < list.length) ? list[k + 1] : null;   // 预加载目标
          return playLevel(o2);
        })
        .then(function (r) {
          if (r && (r.reason === 'not-ready' || r.reason === 'no-steps')) {
            // 首次进关可能比引擎就绪还早：退回去重进一次
            log('retry-enter', idx, r.reason);
            if (popShown('PopLoad')) { try { app().manager.ui.hide({ name: 'PopLoad' }); } catch (e) {} }
            return sleep(rand(1500, 3000))
              .then(function () { return root.__AUTO.enter(idx, opts.mode); })
              .then(function () { return sleep(rand(1500, 3000)); })
              .then(function () {
          var o2 = {}; for (var kk in opts) o2[kk] = opts[kk];
          o2.nextIdx = (k + 1 < list.length) ? list[k + 1] : null;   // 预加载目标
          return playLevel(o2);
        });
          }
          return r;
        })
        .then(function (r) {
          r0 = r || { reason: 'null' };
          r0.index = idx;
          results.push(r0);
          if (opts.onLevelResult) { try { opts.onLevelResult(r0); } catch (e) {} }
          log('LEVEL', idx, r0.reason, r0.tips);
          idx++;
          return sleep(rand(1500, 3000));   // 打完看结算的自然停顿
        })
        .then(one);
    }
    return one();
  }
})(window);
