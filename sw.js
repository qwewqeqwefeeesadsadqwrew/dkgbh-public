/* 运行时缓存 Service Worker（边玩边缓存）
 * 形态：第一次打开只下当前需要的，玩到哪缓存哪；之后每关读本地缓存。
 * 不用 ignoreSearch（Chrome 线性扫描 thousands 条会拖死主线程）——改成「去掉 query 后精确匹配」。
 * 入口页 / SW 本身 / 自动玩脚本永远走网络，保证改版能推出去。
 */
var CACHE = 'dkgbh-rt-v4';
var ALWAYS_NETWORK = /(?:^|\/)(?:index[^/]*\.html|precache\.(?:js|json)|sw\.js|[^/]*(?:boot|autoplay)[^/]*\.js)$/;
var CACHEABLE = /\.(js|mjs|json|css|png|jpe?g|webp|gif|mp3|ogg|wav|mp4|cconb|wasm|bin|ttf|otf|woff2?|atlas|plist)$/i;

function keyOf(url) {
  var u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.href;
}

self.addEventListener('install', function (e) {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil((function () {
    return caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);   // 清掉旧版本缓存（含之前全量预缓存的 253MB）
      }));
    });
  })().then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 2026-11-16：OSS 镜像缺件 → 本站 missing/ 镜像兜底（网络优先，只有 404 才回退）
  if (url.origin === 'https://wlzs-demo-2026.oss-cn-hangzhou.aliyuncs.com' && url.pathname.indexOf('/assets/') >= 0) {
    var rel = url.pathname.replace(/^\/dkgbh-oss\/web-mobile\//, '');
    e.respondWith(fetch(req).then(function (res) {
      if (res.status !== 404) return res;
      return fetch(new URL('missing/' + rel, self.registration.scope)).then(function (r2) {
        if (!r2.ok) return res;
        return r2.arrayBuffer().then(function (b) {
          return new Response(b, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' } });
        });
      }).catch(function () { return res; });
    }));
    return;
  }
  // 2026-11-16：跨域资源（官方 CDN）不拦——SW 缓存会拖死游戏加载；只缓存同源
  if (url.origin !== self.location.origin) return;

  // 入口页与自动玩脚本：永远走网络（不缓存），否则改版推不出去
  if (ALWAYS_NETWORK.test(url.pathname)) {
    e.respondWith(fetch(req).catch(function () { return caches.match(req); }));
    return;
  }

  // 其余静态资源：缓存优先，未命中再下载并写缓存（边玩边缓存）
  if (!CACHEABLE.test(url.pathname)) return;

  var key = keyOf(req.url);
  e.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(key).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          // 同源 200 或跨域 opaque/cors 都可缓存
          if (res && (res.status === 200 || res.type === 'opaque')) {
            var clone = res.clone();
            cache.put(key, clone).catch(function () {});
          }
          return res;
        });
      });
    })
  );
});
