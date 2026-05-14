export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).send("URL is required");

  try {
    const targetUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
    const proxyOrigin = `${req.headers["x-forwarded-proto"] || 'https'}://${req.headers["host"]}`;
    const proxyBase = `${proxyOrigin}/proxy?url=`;

    // 1. 究極のヘッダー偽装
    const headers = new Headers();
    const skipHeaders = ['host', 'connection', 'referer', 'origin', 'x-vercel-id', 'x-forwarded-for', 'accept-encoding'];
    
    Object.keys(req.headers).forEach(key => {
      if (!skipHeaders.includes(key.toLowerCase())) {
        headers.set(key, req.headers[key]);
      }
    });

    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    headers.set("Referer", targetUrl.origin + "/");
    headers.set("Origin", targetUrl.origin);
    headers.set("sec-ch-ua", '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"');
    headers.set("sec-ch-ua-mobile", "?0");
    headers.set("sec-ch-ua-platform", '"Windows"');
    headers.set("sec-fetch-site", "same-origin");

    const response = await fetch(targetUrl.href, {
      method: req.method,
      headers: headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      redirect: 'manual'
    });

    res.status(response.status);

    // 2. セキュリティヘッダーの無力化とCookieの改造
    const blockHeaders = ['content-encoding', 'content-length', 'x-frame-options', 'content-security-policy', 'strict-transport-security', 'set-cookie', 'cross-origin-opener-policy'];
    response.headers.forEach((value, key) => {
      if (!blockHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader("Access-Control-Allow-Origin", "*");

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const modifiedCookies = setCookie.split(/,(?=[^;]+=[^;]+)/).map(cookie => 
        cookie.replace(/Domain=[^;]+;?/gi, '')
              .replace(/Secure;?/gi, '')
              .replace(/SameSite=(Lax|Strict)/gi, 'SameSite=None')
      );
      res.setHeader('Set-Cookie', modifiedCookies);
    }

    // リダイレクトの追跡
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        const redirUrl = new URL(location, targetUrl.origin).href;
        return res.redirect(`${proxyBase}${encodeURIComponent(redirUrl)}`);
      }
    }

    const contentType = response.headers.get("content-type") || "";

    // 3. CSSのURL書き換え（背景画像・フォント対策）
    if (contentType.includes("text/css")) {
      let css = await response.text();
      css = css.replace(/url\((?!['"]?(?:data:|about:|javascript:))(['"]?)([^'")]+)\1\)/g, (match, quote, path) => {
        try {
          const absoluteUrl = new URL(path, targetUrl.href).href;
          return `url(${quote}${proxyBase}${encodeURIComponent(absoluteUrl)}${quote})`;
        } catch (e) { return match; }
      });
      return res.send(css);
    }

    // 4. HTMLの書き換えと最強のJSフック注入
    if (contentType.includes("text/html")) {
      let html = await response.text();

      // 究極のクライアントサイド・ハイジャック・スクリプト
      const injection = `
<base href="${targetUrl.origin}/">
<script>
  (function() {
    const proxyBase = '${proxyBase}';
    const targetOrigin = '${targetUrl.origin}';

    function toProxyUrl(url) {
      if (!url || typeof url !== 'string') return url;
      if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('about:')) return url;
      if (url.startsWith(window.location.origin)) return url;
      try {
        const fullUrl = new URL(url, targetOrigin).href;
        return proxyBase + encodeURIComponent(fullUrl);
      } catch(e) { return url; }
    }

    // 1. History API のジャック (SPAの画面遷移対策)
    const _pushState = history.pushState;
    const _replaceState = history.replaceState;
    history.pushState = function(state, title, url) {
      if (url) arguments[2] = toProxyUrl(url);
      return _pushState.apply(this, arguments);
    };
    history.replaceState = function(state, title, url) {
      if (url) arguments[2] = toProxyUrl(url);
      return _replaceState.apply(this, arguments);
    };

    // 2. 通信APIのジャック (fetch / XHR)
    const _fetch = window.fetch;
    window.fetch = function() {
      if (arguments[0]) arguments[0] = toProxyUrl(arguments[0]);
      return _fetch.apply(this, arguments);
    };

    const _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function() {
      if (arguments[1]) arguments[1] = toProxyUrl(arguments[1]);
      return _open.apply(this, arguments);
    };

    // 3. Service Worker の封殺 (バイパス防止)
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = function() {
        return Promise.reject(new Error("Service Worker is blocked by proxy."));
      };
    }

    // 4. 動的DOM生成の監視 (画像やスクリプトが追加された瞬間に書き換える)
    const observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === 1) { // Element node
            if (node.src) node.src = toProxyUrl(node.src);
            if (node.href) node.href = toProxyUrl(node.href);
            if (node.action) node.action = toProxyUrl(node.action);
            
            // 子要素も一斉チェック
            const elements = node.querySelectorAll ? node.querySelectorAll('[src], [href], [action]') : [];
            elements.forEach(el => {
              if (el.src) el.src = toProxyUrl(el.src);
              if (el.href && el.tagName !== 'A') el.href = toProxyUrl(el.href); // Aタグはクリック時に処理
              if (el.action) el.action = toProxyUrl(el.action);
            });
          }
        });
      });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // 5. リンククリックとフォーム送信のジャック
    document.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (a && a.href) {
        e.preventDefault();
        window.location.href = toProxyUrl(a.href);
      }
    }, true);

    document.addEventListener('submit', e => {
      const form = e.target;
      if (form.action) {
        e.preventDefault();
        const url = new URL(form.action, targetOrigin);
        const params = new FormData(form);
        const qs = new URLSearchParams(params).toString();
        window.location.href = toProxyUrl(url.origin + url.pathname + '?' + qs);
      }
    }, true);

    // 6. 脱出防止
    window.self = window.top;
    window.parent = window.self;

    // 7. 履歴保存エンジン
    try {
      const history = JSON.parse(localStorage.getItem('proxy_history') || '[]');
      const currentRealUrl = new URL(window.location.href).searchParams.get('url');
      if (currentRealUrl && history[0]?.url !== currentRealUrl) {
        history.unshift({ title: document.title || currentRealUrl, url: currentRealUrl, time: Date.now() });
        localStorage.setItem('proxy_history', JSON.stringify(history.slice(0, 50)));
      }
    } catch(e) {}

  })();
</script>
`;
      html = html.replace(/<head>/i, '<head>' + injection);

      // 静的なHTML内のURLも可能な限り置換
      html = html.replace(/(src|href|action)=(['"])(?!data:|about:|javascript:|#)(.*?)\2/gi, (match, attr, quote, path) => {
        try {
          const absoluteUrl = new URL(path, targetOrigin).href;
          return `${attr}=${quote}${proxyBase}${encodeURIComponent(absoluteUrl)}${quote}`;
        } catch (e) { return match; }
      });

      return res.send(html);
    }

    // 5. バイナリデータ（画像・動画等）のストリーミング
    const buffer = await response.arrayBuffer();
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
    res.send(Buffer.from(buffer));

  } catch (error) {
    console.error(error);
    res.status(500).send("Proxy Error: " + error.message);
  }
}
