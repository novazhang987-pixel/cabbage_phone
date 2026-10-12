/* Service Worker：把界面文件缓存下来，所以装到主屏幕之后，没网也能打开。
 *
 * 这个版本的数据本来就在手机里（localStorage），不依赖网络，
 * 所以「离线可用」是完整的：打开、增删改查、看报表，全都能用。
 *
 * 改了界面文件（style.css / app.js / localdb.js / parser.js / i18n.js）之后，
 * 记得把下面的 VERSION 加一，手机上才会拿到新版本。
 */

const VERSION = "food-keeper-phone-v1";
const SHELL = [
  "./",
  "index.html",
  "style.css",
  "i18n.js",
  "parser.js",
  "localdb.js",
  "app.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 先用缓存（离线可用），同时悄悄去网上取新的存起来
  event.respondWith(
    caches.match(request).then((cached) => {
      const fresh = fetch(request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached || caches.match("index.html"));
      return cached || fresh;
    })
  );
});
