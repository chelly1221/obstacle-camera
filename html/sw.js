/* 토지이용 AR — service worker
 *
 * 목적: 앱 셸을 캐시해 오프라인/약전계에서도 화면이 즉시 뜨게 한다.
 *   ※ 참고: Chrome 108(모바일)/112(데스크톱)부터는 PWA 설치에 서비스 워커가
 *     더 이상 필수가 아니다(매니페스트만으로 설치 가능). 이 파일은 설치 '요건'이
 *     아니라 오프라인 캐시를 위해 존재하므로, 설치를 이 파일에 의존시키지 말 것.
 *
 * 캐시 정책
 *  - 네비게이션(HTML): network-first → 실패 시 캐시된 index.html (오프라인 셸).
 *  - 앱 코어(같은 출처 + Leaflet/Pretendard CDN): cache-first, 백그라운드 갱신.
 *  - 지도 타일(OSM·VWorld)·기타: 건드리지 않고 항상 네트워크(캐시 오염 방지).
 *
 * CACHE 버전을 올리면 activate에서 옛 캐시를 정리한다.
 */
'use strict';

var CACHE = 'arcam-v10-2026-07-19';

// 오프라인 시작에 반드시 필요한 같은 출처 리소스 (하나라도 실패하면 install 실패).
var CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png?v=2',
  './icons/icon-512.png?v=2',
  './icons/apple-touch-icon.png?v=2'
];

// 있으면 좋은 외부 리소스 (실패해도 install은 계속 진행).
var EXTRA = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // CORE는 반드시 캐시 (reload로 HTTP 캐시 우회 → 항상 최신 셸).
      return c.addAll(CORE.map(function (u) { return new Request(u, { cache: 'reload' }); }))
        .then(function () {
          // EXTRA는 개별적으로, 실패는 무시.
          return Promise.all(EXTRA.map(function (u) {
            return c.add(new Request(u, { cache: 'reload', mode: 'cors' })).catch(function () {});
          }));
        });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

// 앱에서 skipWaiting을 요청할 수 있게 (업데이트 즉시 반영 옵션).
self.addEventListener('message', function (e) {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

function isMapTile(url) {
  // OSM 타일, VWorld 프록시/캐시 등은 캐시하지 않는다.
  // search까지 포함해야 map.vworld.kr/proxy.do?url=...2DCache... 같은 프록시도 잡힌다.
  return /(^|\.)tile\.openstreetmap\.org|vworld\.kr|2dcache/i.test(url.host + url.pathname + url.search);
}

function isApi(url) {
  // 공유 건물/그룹 API(/api/*)는 절대 캐시하지 않는다. 캐시하면 서버 공유 상태가 낡아
  // 남의 변경이 안 보이고 내가 방금 저장한 것도 잠시 사라진 것처럼 보인다(ETag/폴링 무력화).
  return url.origin === self.location.origin && url.pathname.indexOf('/api/') === 0;
}

function isCacheableAsset(url) {
  if (url.origin === self.location.origin) return true;
  return /unpkg\.com|cdn\.jsdelivr\.net/i.test(url.host);
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (isMapTile(url)) return; // 네트워크에 맡김
  if (isApi(url)) return;     // 공유 API는 항상 네트워크(서버가 진실)

  // 페이지 이동: network-first, 오프라인이면 캐시된 셸.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(function (res) {
        // 정상(2xx, 같은 출처) 응답만 셸로 저장한다. 배포 중 순간적인 5xx/에러
        // 페이지가 캐시된 오프라인 셸을 덮어쓰지 못하게 한다.
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put('./index.html', copy); }).catch(function () {});
        }
        return res;
      }).catch(function () {
        return caches.match('./index.html').then(function (r) { return r || caches.match('./'); });
      })
    );
    return;
  }

  if (!isCacheableAsset(url)) return;

  // 정적 자원: cache-first + 백그라운드 갱신.
  e.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req).then(function (res) {
        // 성공을 확인할 수 있는 응답(2xx, 같은 출처 또는 CORS)만 캐시한다.
        // opaque(no-cors 교차출처) 응답은 404/5xx여도 성공과 구분이 안 돼 캐시하지 않는다.
        // 교차출처 CDN(Leaflet·Pretendard)은 install 시 EXTRA로 CORS 프리캐시된다.
        if (res && res.ok && res.type !== 'opaque') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
