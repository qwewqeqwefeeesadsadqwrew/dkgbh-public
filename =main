// RED/GREEN regression: Level3 victory closes but UIMgrShade stays active.
// A shade is valid only while a popup panel (PopVictory/PopFail/PopLoad/...) is active.
// If shade stays active with zero active Pop* panel for >3s -> FAIL.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const cdp = require('C:/Users/User/.codex/skills/game-autoplay/scripts/cdp-session.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REPO = path.resolve(__dirname, '..');
const TEST_DIR = 'C:/Users/User/AppData/Local/Temp/dkgbh-shade-test';
const PROFILE = 'C:/Users/User/AppData/Local/Temp/edge-shade-test-9397';
const PORT = 9396, DBG = 9397;
const RED_LOG = TEST_DIR + '/red.log';
const LEVELS = process.env.DKGBH_LEVELS || '4';
const SOAK_MS = Math.max(0, Number(process.env.DKGBH_SOAK_MS) || 0);
const MIN_RESULTS = Math.max(1, Number(process.env.DKGBH_MIN_RESULTS) || 2);
const SMOKE = process.env.DKGBH_SMOKE === '1';
const ONLINE_URL = process.env.DKGBH_ONLINE_URL || '';
const TARGET_LEVELS = LEVELS.split(',').map(function (x) { return Number(x) - 1; })
  .filter(function (x) { return x >= 0 && x < 40; });
process.on('unhandledRejection', e => console.error('UNHANDLED', e && e.stack || e));

function prep() {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR + '/autoplay', { recursive: true });
  for (const f of ['index.html', 'sw.js', 'autoplay/boot.js', 'autoplay/dkgbh-autoplay.js']) {
    fs.mkdirSync(path.dirname(TEST_DIR + '/' + f), { recursive: true });
    fs.copyFileSync(path.join(REPO, f), TEST_DIR + '/' + f);
  }
  let idx = fs.readFileSync(TEST_DIR + '/index.html', 'utf8');
  idx = idx.split('https://qwewqeqwefeeesadsadqwrew.github.io/dkgbh-public/sw.js').join('http://127.0.0.1:' + PORT + '/sw.js');
  idx = idx.split("scope: 'https://qwewqeqwefeeesadsadqwrew.github.io/dkgbh-public/'").join("scope: 'http://127.0.0.1:" + PORT + "/'");
  idx = idx.split('https://qwewqeqwefeeesadsadqwrew.github.io/dkgbh-public/autoplay/boot.js?v=42').join('http://127.0.0.1:' + PORT + '/autoplay/boot.js?v=42test');
  fs.writeFileSync(TEST_DIR + '/index.html', idx);
  const d = fs.readFileSync(TEST_DIR + '/autoplay/dkgbh-autoplay.js', 'utf8');
  if (!d.includes("parent.name === 'Pop'")) throw new Error('driver v42 marker missing');
  return { page: 'http://127.0.0.1:' + PORT + '/index.html?levels=' + encodeURIComponent(LEVELS) + '&refresh=0&shade=' + Date.now() };
}

function serve() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };
  const server = http.createServer((req, res) => {
    try {
      let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.resolve(TEST_DIR + p);
      if (!f.startsWith(path.resolve(TEST_DIR))) { res.writeHead(403); res.end('forbidden'); return; }
      fs.readFile(f, (e, buf) => {
        if (e) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': types[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(buf);
      });
    } catch (e) { res.writeHead(500); res.end('err'); }
  });
  return new Promise((resolve, reject) => server.listen(PORT, '127.0.0.1', () => resolve(server)).on('error', reject));
}

const CHECK = `(function(){
  var scene=null; try{scene=cc.director.getScene();}catch(e){}
  if(!scene) return JSON.stringify({err:'no-scene'});
  var pop=null;
  (function w(n){if(!n)return;if(n.name==='Pop'&&n.activeInHierarchy&&!pop){pop=n;return;}(n.children||[]).forEach(w);})(scene);
  if(!pop) return JSON.stringify({pop:false});
  function pathOf(n){var p=[];while(n){p.unshift(n.name);n=n.parent;}return '/'+p.join('/');}
  var shade=null, panels=[];
  (pop.children||[]).forEach(function(c){
    if(!c||!c.isValid) return;
    if(c.name==='UIMgrShade') shade=c;
    if(c.activeInHierarchy&&/^Pop/.test(c.name)&&c.name!=='Pop') panels.push({name:c.name,path:pathOf(c)});
  });
  var shadeActive=!!(shade&&shade.activeInHierarchy);
  var opacity=null; if(shade){try{var u=shade.getComponent('cc.UIOpacity');if(u)opacity=u.opacity;}catch(e){}}
  var demo=null; try{demo=window.__dkgbhDemo.status();}catch(e){}
  return JSON.stringify({pop:true,shade:{active:shadeActive,opacity:opacity,path:shade?pathOf(shade):null},panels:panels,demo:demo});
})()`;

(async () => {
  let child = null, s = null, server = null;
  try {
    let page;
    if (ONLINE_URL) {
      page = ONLINE_URL;
      console.log('ONLINE ' + page);
    } else {
      ({ page } = prep());
      server = await serve();
      console.log('SERVER ' + page);
    }
    const exe = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(f => { try { return fs.existsSync(f); } catch (e) { return false; } });
    child = spawn(exe, ['--headless=new', '--remote-debugging-port=' + DBG, '--user-data-dir=' + PROFILE, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=414,896', '--hide-scrollbars', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-gpu', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { detached: true, stdio: 'ignore', windowsHide: true });
    let ok = false; for (let i = 0; i < 80; i++) { try { const r = await fetch('http://127.0.0.1:' + DBG + '/json/version'); if (r.ok) { ok = true; break; } } catch (e) {} await sleep(500); }
    if (!ok) throw new Error('debug not ready');
    s = await cdp.attach({ port: DBG, match: 'about:blank', timeoutMs: 20000 });
    await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('Log.enable');
    await s.send('Page.navigate', { url: page });
    let ready = false; for (let i = 0; i < 180; i++) { try { const v = await s.eval('!!(window.__AUTO&&window.__dkgbhDemo&&cc.director.getScene()&&document.querySelector("canvas"))'); if (v === true || v === 'true') { ready = true; break; } } catch (e) {} await sleep(1000); }
    if (!ready) throw new Error('page not ready');
    try { await s.send('Page.bringToFront'); } catch (e) {}
    console.log('READY');
    if (SMOKE) {
      const smoke = await s.eval('JSON.stringify({auto:typeof window.__AUTO.runList,demo:window.__dkgbhDemo.status()})');
      console.log('SMOKE_PASS ' + smoke);
      process.exitCode = 0;
      return;
    }
    let staleSince = 0, last = null, sawWin = false, greenChecks = 0;
    const t0 = Date.now();
    const maxLoops = SOAK_MS > 0 ? Math.ceil(SOAK_MS / 1000) + 180 : 540;
    for (let i = 0; i < maxLoops; i++) {
      await sleep(1000);
      let c = null;
      try { c = JSON.parse(await s.eval(CHECK)); } catch (e) { continue; }
      if (!c || !c.pop) continue;
      last = c;
      if (c.demo && (c.demo.results || []).length >= 1) sawWin = true;
      const shade = !!(c.shade && c.shade.active);
      const panels = c.panels || [];
      if (shade && panels.length === 0) {
        if (!staleSince) { staleSince = Date.now(); console.log('STALE_START ' + JSON.stringify({ at: Date.now() - t0, shade: c.shade, demo: c.demo && { wins: c.demo.wins, results: c.demo.results } })); }
        if (Date.now() - staleSince > 3000) {
          const fail = { at: Date.now() - t0, reason: 'UIMgrShade active with zero active Pop* panels', shade: c.shade, panels, demo: c.demo, last };
          const shot = await s.send('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(TEST_DIR + '/fail-' + Date.now() + '.png', Buffer.from(shot.data, 'base64'));
          fs.writeFileSync(RED_LOG, JSON.stringify(fail, null, 2));
          console.log('RED_STALE_SHADE ' + JSON.stringify(fail));
          console.log('REGRESSION_FAIL');
          process.exitCode = 1;
          return;
        }
      } else {
        staleSince = 0;
      }
      const victoryClosed = !!(sawWin && c.demo && (c.demo.results || []).length >= 2 && !panels.some(p => p.name === 'PopVictory' || p.name === 'PopFail'));
      if (SOAK_MS > 0) {
        if (Date.now() - t0 >= SOAK_MS) {
          const seen = (c.demo && c.demo.results || []).map(function (r) { return r.level; });
          const missing = TARGET_LEVELS.filter(function (x) { return seen.indexOf(x) < 0; });
          const ok = !missing.length && seen.length >= MIN_RESULTS && !(shade && panels.length === 0);
          const report = { at: Date.now() - t0, levels: LEVELS, seen: seen.slice(-20), missing: missing, minResults: MIN_RESULTS, shade: c.shade, panels: panels.map(p => p.name) };
          console.log((ok ? 'SOAK_PASS ' : 'SOAK_FAIL ') + JSON.stringify(report));
          process.exitCode = ok ? 0 : 1;
          return;
        }
      } else if (victoryClosed && !(shade && panels.length === 0)) {
        greenChecks++;
        if (greenChecks >= 5) {
          fs.writeFileSync(TEST_DIR + '/green.json', JSON.stringify({ at: Date.now() - t0, wins: c.demo.wins, shade: c.shade, panels, demo: c.demo }, null, 2));
          console.log('GREEN_NO_STALE_SHADE ' + JSON.stringify({ at: Date.now() - t0, results: (c.demo.results||[]).length, wins: c.demo.wins, shade: c.shade, panels }));
          console.log('REGRESSION_PASS');
          process.exitCode = 0;
          return;
        }
      } else {
        greenChecks = 0;
      }
      if (i % 30 === 0) console.log('WAIT ' + JSON.stringify({ at: Date.now() - t0, results: c.demo && (c.demo.results||[]).length, wins: c.demo && c.demo.wins, level: c.demo && c.demo.level, shade: c.shade, panels: panels.map(p => p.name) }));
    }
    console.log('TEST_TIMEOUT');
    process.exitCode = 2;
  } catch (e) {
    console.error('TEST_ERROR', e && e.stack || e);
    process.exitCode = 2;
  } finally {
    try { if (s) await s.close(); } catch (e) {}
    try { if (server) server.close(); } catch (e) {}
    try { spawnSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*remote-debugging-port=" + DBG + "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"], { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
    console.log('CLEANED_' + DBG);
    setTimeout(() => process.exit(process.exitCode || 0), 500);
  }
})();
