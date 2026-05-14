export default async function handler(req, res) {
  const { url } = req.query;

  if (!url || typeof url !== 'string') {
    return res.status(400).send("URL parameter is required.");
  }

  try {
    const rawUrl = url.startsWith('http') ? url : `https://${url}`;
    const targetUrl = new URL(rawUrl);
    const proxyOrigin = `${req.headers["x-forwarded-proto"] || 'https'}://${req.headers["host"]}`;
    const proxyBase = `${proxyOrigin}/proxy?url=`;

    // 1. リクエストヘッダーの高度な模倣
    const headers = new Headers();
    const skipHeaders = [
      'host', 'connection', 'referer', 'origin', 
      'x-vercel-id', 'x-forwarded-for', 'accept-encoding', 'content-length'
    ];
    
    Object.keys(req.headers).forEach(key => {
      if (!skipHeaders.includes(key.toLowerCase())) {
        headers.set(key, req.headers[key]);
      }
    });

    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
    headers.set("Accept-Language", "ja,en-US;q=0.9,en;q=0.8");
    headers.set("Referer", targetUrl.origin + "/");

    // 2. ターゲットへのフェッチ
    const response = await fetch(targetUrl.href, {
      method: req.method,
      headers: headers,
      body: (req.method !== 'GET' && req.method !== 'HEAD') ? JSON.stringify(req.body) : undefined,
      redirect: 'manual'
    });

    // 3. リダイレクトの完全追跡
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        const redirUrl = new URL(location, targetUrl.origin).href;
        return res.redirect(`${proxyBase}${encodeURIComponent(redirUrl)}`);
      }
    }

    // 4. レスポンスヘッダーのクリーニング
    const blockHeaders = [
      'content-encoding', 'content-length', 'x-frame-options', 
      'content-security-policy', 'strict-transport-security', 
      'set-cookie', 'cross-origin-opener-policy', 'report-to'
    ];

    response.headers.forEach((value, key) => {
      if (!blockHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader("Access-Control-Allow-Origin", "*");

    // 5. Cookieの調整
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const cookies = setCookie.split(/,(?=[^;]+=[^;]+)/).map(c => 
        c.replace(/Domain=[^;]+;?/gi, '').replace(/Secure;?/gi, '').replace(/SameSite=(Lax|Strict)/gi, 'SameSite=None')
      );
      res.setHeader('Set-Cookie', cookies);
    }

    const contentType = response.headers.get("content-type") || "";

    // --- HTML/CSS書き換えロジック ---
    if (contentType.includes("text/html") || contentType.includes("text/css")) {
      let content = await response.text();

      if (contentType.includes("text/html")) {
        // フロントエンドに注入する最強のJSエンジン
        const injection = `
<base href="${targetUrl.origin}/">
<script>
  (function() {
    const P_BASE = '${proxyBase}';
    const T_ORIGIN = '${targetUrl.origin}';

    function p(u) {
      if (!u || typeof u !== 'string' || u.startsWith('data:') || u.startsWith('javascript:') || u.startsWith('#')) return u;
      try {
        const a = new URL(u, T_ORIGIN).href;
        return P_BASE + encodeURIComponent(a);
      } catch(e) { return u; }
    }

    // A. 検索フォーム・すべてのフォームの横取り
    window.addEventListener('submit', function(e) {
      const f = e.target;
      if (f.method.toUpperCase() === 'GET') {
        e.preventDefault();
        const fd = new FormData(f);
        const q = new URLSearchParams();
        for (let [k, v] of fd.entries()) q.append(k, v);
        const act = f.getAttribute('action') || '';
        const target = new URL(act, T_ORIGIN);
        window.location.href = p(target.origin + target.pathname + '?' + q.toString());
      }
    }, true);

    // B. 動的要素（画像・スクリプト）の監視と修正
    const obs = new MutationObserver(ms => {
      ms.forEach(m => m.addedNodes.forEach(n => {
        if (n.nodeType === 1) {
          if (n.src) n.src = p(n.src);
          if (n.href && n.tagName !== 'A') n.href = p(n.href);
          n.querySelectorAll && n.querySelectorAll('[src], [href]').forEach(el => {
            if (el.src) el.src = p(el.src);
            if (el.href && el.tagName !== 'A') el.href = p(el.href);
          });
        }
      }));
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });

    // C. クリックジャック
    window.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (a && a.href && !a.href.startsWith('javascript:') && !a.getAttribute('href').startsWith('#')) {
        e.preventDefault();
        window.location.href = p(a.href);
      }
    }, true);

    // D. 通信・History APIの全ジャック
    const { pushState, replaceState } = history;
    history.pushState = function() { if(arguments[2]) arguments[2] = p(arguments[2]); return pushState.apply(this, arguments); };
    history.replaceState = function() { if(arguments[2]) arguments[2] = p(arguments[2]); return replaceState.apply(this, arguments); };

    const originalFetch = window.fetch;
    window.fetch = function() { if(typeof arguments[0] === 'string') arguments[0] = p(arguments[0]); return originalFetch.apply(this, arguments); };

    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function() { if(arguments[1]) arguments[1] = p(arguments[1]); return open.apply(this, arguments); };

    // E. 履歴保存
    try {
      const log = JSON.parse(localStorage.getItem('proxy_history') || '[]');
      const cur = new URL(window.location.href).searchParams.get('url');
      if (cur && (!log[0] || log[0].url !== cur)) {
        log.unshift({ title: document.title, url: cur, time: Date.now() });
        localStorage.setItem('proxy_history', JSON.stringify(log.slice(0, 50)));
      }
    } catch(e) {}
  })();
</script>
`;
        content = content.replace(/<head[^>]*>/i, '$&' + injection);

        // サーバー側での強固なパス置換（正規表現）
        content = content.replace(/(src|href|action|poster|data-src)=(['"])(?!data:|javascript:|#)(.*?)\2/gi, (m, attr, q, p) => {
          try {
            const abs = new URL(p, targetUrl.href).href;
            return `${attr}=${q}${proxyBase}${encodeURIComponent(abs)}${q}`;
          } catch(e) { return m; }
        });

        // インラインCSS内のurl()置換
        content = content.replace(/url\((?!['"]?(?:data:))(['"]?)([^'")]+)\1\)/g, (m, q, p) => {
          try {
            const abs = new URL(p, targetUrl.href).href;
            return `url(${q}${proxyBase}${encodeURIComponent(abs)}${q})`;
          } catch(e) { return m; }
        });
      } else if (contentType.includes("text/css")) {
        // 外部CSSファイル内のurl()置換
        content = content.replace(/url\((?!['"]?(?:data:))(['"]?)([^'")]+)\1\)/g, (m, q, p) => {
          try {
            const abs = new URL(p, targetUrl.href).href;
            return `url(${q}${proxyBase}${encodeURIComponent(abs)}${q})`;
          } catch(e) { return m; }
        });
      }

      res.status(response.status);
      return res.send(content);
    }

    // 6. 画像・フォント・JSなどのバイナリデータ
    const buffer = await response.arrayBuffer();
    res.status(response.status);
    res.setHeader('Content-Type', contentType);
    res.send(Buffer.from(buffer));

  } catch (err) {
    console.error("PROXY_CRITICAL_ERROR:", err);
    res.status(500).send("Critical Error: " + err.message);
  }
}
