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

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function now() { return Date.now(); }

  // ---------- 手势记录（照掌勺：用来证明「随机真的在生效」看 dur / curve 两列） ----------
  var GESTURES = [];
  function recordGesture(g) {
    g.t = now();
    GESTURES.push(g);
    if (GESTURES.length > 12) GESTURES.shift();
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
      v = Math.min(v, maxMs * 2.5);             // 但封顶，别把关卡拖到超时
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

  // ---------- 动作（全部拟人：时长/按压/弧度/抖动/帧间隔/缓动/松手延迟都随机） ----------
  function click(n) {
    var p = randPointInRect(n, 0.2);
    p.x += rand(-2.2, 2.2); p.y += rand(-2.2, 2.2);           // 点击位置偏 ±2.2px
    emit(n, cc.Node.EventType.TOUCH_START, p.x, p.y);
    var hold = rand(50, 180);                                  // 按下 50~180ms
    return sleep(hold).then(function () {
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
        var gap = rand(80, 350);                               // 组内连点 80~350ms
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
      var a = randPointInRect(n, 0.12);                         // 起点：内缩 12% 随机
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

      var pressMs = mode ? rand(30, 150) : rand(40, 180);       // 按下停顿
      var vx0 = b.x - a.x, vy0 = b.y - a.y;
      var dist0 = Math.sqrt(vx0 * vx0 + vy0 * vy0) || 1;
      var tgtW = 0;
      try { var tb = target ? boxOf(target) : null; tgtW = tb ? Math.min(tb.w, tb.h) : 0; } catch (e) {}
      // 时长 = Fitts 定律（距离/目标宽度），乘一个 0.85~1.15 的个体差
      var dur = mode
        ? Math.min(700, Math.max(240, fittsDur(dist0, tgtW || 100) * 0.8))
        : fittsDur(dist0, tgtW || 80) * (0.85 + Math.random() * 0.3);
      dur = clamp(dur, 240, 1500);
      var nx = -vy0 / dist0, ny = vx0 / dist0;
      var curveAmp = mode ? 0.05 : 0.12;
      var curve = rand(-curveAmp, curveAmp) * Math.min(dist0, 260);
      var jitter = rand(0.4, 2.2), freq = rand(2, 4.5), phase = rand(0, 6.28);
      var ease = makeEase();
      var cur = { x: a.x, y: a.y };
      var fixRound = 0;

      emit(n, cc.Node.EventType.TOUCH_START, a.x, a.y);

      function travel(from, to, ms, onDone) {
        var t0 = now();
        var ddx = to.x - from.x, ddy = to.y - from.y;
        var d2 = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
        var pnx = setN(-ddy / d2), pny = setN(ddx / d2);
        (function step() {
          var t = Math.min(1, (now() - t0) / ms);
          var e = ease(t), arc = Math.sin(Math.PI * t);
          var wob = Math.sin(Math.PI * t * freq + phase) * arc;
          var x = from.x + ddx * e + pnx * (curve * arc + jitter * wob);
          var y = from.y + ddy * e + pny * (curve * arc + jitter * wob);
          cur = { x: x, y: y };
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
            curve: Math.round(curve), round: fixRound
          });
          resolve(pressMs + dur + rel);                          // 返回动作总时长
        }, rand(0, 120));
      }
    });
  }

  function longPress(n, hold) {
    var p = randPointInRect(n, 0.2);
    var real = Math.max(300, hold || 800) + rand(100, 600);      // 多按一点，卡底线容易失败
    emit(n, cc.Node.EventType.TOUCH_START, p.x, p.y);
    var t0 = now();
    // 按住期间每 120~260ms 微动一次（±3px）：真人按住手指不会完全静止（照掌勺）
    (function jitter() {
      if (now() - t0 >= real) return;
      emit(n, cc.Node.EventType.TOUCH_MOVE, p.x + rand(-3, 3), p.y + rand(-3, 3));
      setTimeout(jitter, rand(120, 260));
    })();
    return sleep(real).then(function () {
      emit(n, cc.Node.EventType.TOUCH_END, p.x, p.y);
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
  function longPress(n, hold) {
    var p = randPt(n);
    emit(n, cc.Node.EventType.TOUCH_START, p.x, p.y);
    return sleep(Math.max(300, hold || 800)).then(function () {
      emit(n, cc.Node.EventType.TOUCH_END, p.x, p.y);
      return true;
    });
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
      guide: g ? { steps: (g._steps || []).length, cur: g._currentStep, done: (g.tiptrue || []).slice() } : null,
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
  // 剩余时间见底就点「加时」（走游戏自己的按钮 → btn_addTime → setCountdown(+120)）
  function maybeAddTime() {
    try {
      var t = state().timer;
      if (t == null) return false;
      if (t > 100 || t < 10) return false;   // 剩余 <100 秒就加时（远山：可以一直加，别怕）
      if (now() - lastAddAt < 3000) return false;
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
      log('add-time', t);
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
        // 再预取资源（图片/音频）：按 config 自己拼 URL 用 fetch 拉，SW 会缓存
        prefetchBundleAssets(bundle, name);
      });
    } catch (e) { log('preload-err', String(e).slice(0, 80)); }
  }

  function popShown(name) {
    var found = null;
    (function walk(n) {
      if (found || !n) return;
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
        lastGesture: GESTURES.length ? GESTURES[GESTURES.length - 1] : null
      };
    },
    stop: function () { STOP = true; },
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
          return waitFor(function () { return g.tiptrue[i] || !!popShown('PopVictory') || !!popShown('PopFail'); }, maxStepMs || 6000, 100);
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
        var v = false;
        try { v = fn(); } catch (e) { v = false; }
        if (v) return resolve({ ok: true, ms: now() - t0 });
        if (now() - t0 > (timeout || 8000)) return resolve({ ok: false, ms: now() - t0 });
        setTimeout(tick, poll || 120);
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
    if (type === 4) return longPress(a, typeof b === 'number' ? b : 800);
    if (type === 5) return multiClick(a, typeof b === 'number' ? b : 3);
    return Promise.resolve(false);
  }

  function playLevel(opts) {
    opts = opts || {};
    var maxStepMs = opts.maxStepMs || 12000;
    var retries = opts.retries || 4;
    var deadline = opts.deadlineMs || 600000;
    var t0 = now();
    var reason = 'unknown';

    return waitReady(240000).then(function (r) {   // 公网首次加载关卡要几百个请求，给 4 分钟
      if (!r.ok) { reason = 'not-ready'; return null; }
      // 本关资源已就绪 → 放开预缓存闸门（公网版：先保游戏能玩，再后台缓存整包）
      try { window.__dkgbhPrecacheGo = true; } catch (e) {}
      var g = Guide();
      if (!g || !g._steps || !g._steps.length) { reason = 'no-steps'; return null; }
      var steps = g._steps;
      log('steps=' + steps.length);
      hideDebugHud();
      var lv0 = levelComp();
      hookSceneMethods(lv0);
      installMiniLv(lv0);                    // 装上 currentMiniLv（运行时字段）
      // 用「开局观察」的空窗预加载下一关（不抢当前关的加载带宽）
      if (opts.nextIdx != null) {
        setTimeout(function () { preloadLevelBundle(opts.nextIdx); }, rand(3000, 5000));
      }
      // 开局观察 3~5 秒（照掌勺 beginIntro：刚进关立刻拖会读到未渲染完的位置，也不像人）
      var introMs = opts.introMs != null ? opts.introMs : (3000 + Math.random() * 2000);
      var tReady = now();
      log('intro-start', 'readyAfter=' + Math.round((tReady - t0) / 1000) + 's', 'intro=' + Math.round(introMs) + 'ms');
      return sleep(introMs).then(function () {
        log('intro-end', 'total=' + Math.round((now() - t0) / 1000) + 's');
        var i = 0, actMs = 0, lastRepeat = false;
        var lastMini = null, lastStep = -1, lastGroup = null, useFieldMode = true;
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
          if (popShown('PopVictory')) { reason = 'win'; return null; }
          if (popShown('PopFail')) { reason = 'lose'; return null; }
          maybeAddTime();
          while (i < steps.length && g.tiptrue[i]) i++;
          if (i >= steps.length) {
            // 全部完成：等收尾演出 + GameWin（末步演出可能 10 秒以上，例：第 2 关盖章 8.1s）
            return waitFor(function () { return !!popShown('PopVictory') || !!popShown('PopFail'); }, 30000, 200).then(function () {
              reason = popShown('PopVictory') ? 'win' : (popShown('PopFail') ? 'lose' : 'alltips-no-victory');
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
          var isRepeat = (lastRepeat && stepNow === lastStep);
          var gap;
          // 四档间隔全部用「对数正态」（真人节奏：大量中等间隔 + 少数长停顿）
          if (isRepeat) gap = humanGap(160, 80, 420, 0.02);
          else if (sameGroup) gap = humanGap(520, 250, 1100, 0.03);
          else if (miniChanged) gap = humanGap(4200, 2600, 9000, 0.03);   // 换画面段：中位 4.2s，偶尔看十几秒
          else gap = humanGap(1800, 900, 4200, 0.05);                      // 同段换步骤：中位 1.8s
          var prevMini = lastMini;                 // 留给日志用（更新前的值）
          if (miniNow !== null && miniNow >= 0) lastMini = miniNow;
          lastGroup = grp;
          lastStep = stepNow;
          var pre = Promise.resolve();
          if (gap > 1200) {
            log('gap', 'mini=' + miniNow + '(prev=' + prevMini + ')', 'step=' + stepNow, Math.round(gap) + 'ms');
            pre = sleep(gap);
          }
          var tries = 0;
          var t2 = Number(step[0]);
          var waitMs = (t2 === 3) ? 1500 : (t2 === 2 ? 1500 : (t2 === 1 ? 1200 : maxStepMs));
          var maxTry = (t2 === 3) ? 10 : (t2 === 2 ? 16 : (t2 === 1 ? 8 : retries));
          // （不再因时间紧收敛重试次数：时间不够就加时）

          function attempt() {
            if (STOP) { reason = 'stopped'; return null; }
            if (now() - t0 > deadline) { reason = 'timeout'; return null; }
            if (popShown('PopVictory')) { reason = 'win'; return null; }
            if (!node || !node.isValid) { i++; return next(); }
            tries++;
            // 发动作前先对齐到已知状态：关卡的 eventLock（演出/动画期间）关掉再动手
            return waitFor(function () {
              var lv = levelComp();
              return !(lv && lv.eventLock && lv.eventLock.active);
            }, 10000, 80).then(function () {
              return execStep(step, tries - 1).then(function (d) { actMs = d || 0; if (tries === 1) hideDebugHud(); });
            }).then(function () {
              return waitFor(function () { return g.tiptrue[i] || !!popShown('PopVictory') || !!popShown('PopFail'); }, waitMs, 120);
            }).then(function (r2) {
              if (r2.ok) {
                // 节奏：换组 1000~3000ms，同组 250~900ms；下限不许抢在动画前面
                // 照掌勺：等 = max(动画时长 + 650 + rand(0,350), 下一拍的 gap)
                // （下一拍的 gap 已在 next() 入口按 sameGroup/换段算好，这里只做安全余量）
                var tail = Math.max((actMs || 0) + 650 + Math.random() * 350, 0);
                actMs = 0;
                i++;
                return sleep(tail).then(next);
              }
              if (tries >= maxTry) {
                log('step-stuck', i, 'type', step[0], node && node.name);
                i++;
                return next();
              }
              return waitFor(function () {
                var lv = levelComp();
                return !(lv && lv.eventLock && lv.eventLock.active);
              }, 8000, 120).then(attempt);
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
    });
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
          if (popShown('PopVictory')) { try { app().manager.ui.hide({ name: 'PopVictory' }); } catch (e) {} }
          if (popShown('PopFail')) { try { app().manager.ui.hide({ name: 'PopFail' }); } catch (e) {} }
          return sleep(rand(287, 913));
        })
        .then(function () { return root.__AUTO.enter(idx, opts.mode); })
        .then(function () { return sleep(rand(800, 1800)); })
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
            return sleep(rand(1931, 3617))
              .then(function () { return root.__AUTO.enter(idx, opts.mode); })
              .then(function () { return sleep(rand(2411, 4087)); })
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
          log('LEVEL', idx, r0.reason, r0.tips);
          k++;
          return sleep(rand(2137, 3929));   // 打完看结算的自然停顿
        })
        .then(one);
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
            return sleep(rand(1931, 3617))
              .then(function () { return root.__AUTO.enter(idx, opts.mode); })
              .then(function () { return sleep(rand(2411, 4087)); })
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
          log('LEVEL', idx, r0.reason, r0.tips);
          idx++;
          return sleep(rand(2137, 3929));   // 打完看结算的自然停顿
        })
        .then(one);
    }
    return one();
  }
})(window);
