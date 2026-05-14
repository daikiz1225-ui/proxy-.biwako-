export default async function handler(req, res) {
  const { url } = req.query;

  // URLがない場合はエラーを返すが、空文字などで落ちないようガード
  if (!url || typeof url !== 'string') {
    return res.status(400).send("URL parameter is required. Example: /proxy?url=https://google.com");
  }

  try {
    // 1. ターゲットURLの整形
    const rawUrl = url.startsWith('http') ? url : `https://${url}`;
    const targetUrl = new URL(rawUrl);
    const proxyOrigin = `${req.headers["x-forwarded-proto"] || 'https'}://${req.headers["host"]}`;
    const proxyBase = `${proxyOrigin}/proxy?url=`;

    // 2. リクエストヘッダーの完全偽装
    const headers = new Headers();
    const skipHeaders = [
      'host', 'connection', 'referer', 'origin', 
      'x-vercel-id', 'x-forwarded-for', 'accept-encoding',
      'content-length'
    ];
    
    Object.keys(req.headers).forEach(key => {
      if (!skipHeaders.includes(key.toLowerCase())) {
        headers.set(key, req.headers[key]);
      }
    });

    // 標準的なブラウザに見せかける
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8");
    headers.set("Referer", targetUrl.origin + "/");
    headers.set("Origin", targetUrl.origin);

    // 3. ターゲットサイトへリクエスト
    const response = await fetch(targetUrl.href, {
      method: req.method,
      headers: headers,
      body: (req.method !== 'GET' && req.method !== 'HEAD') ? JSON.stringify(req.body) : undefined,
      redirect: 'manual' // リダイレクトを自分で制御
    });

    // 4. リダイレクト(301/302)の処理
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        const redirUrl = new URL(location, targetUrl.origin).href;
        return res.redirect(`${proxyBase}${encodeURIComponent(redirUrl)}`);
      }
    }

    // 5. レスポンスヘッダーの整理（セキュリティ解除）
    const blockHeaders = [
      'content-encoding', 'content-length', 'x-frame-options', 
      'content-security-policy', 'strict-transport-security', 
      'set-cookie', 'cross-origin-opener-policy'
    ];

    response.headers.forEach((value, key) => {
      if (!blockHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    // iframe内での動作を許可
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader("Access-Control-Allow-Origin", "*");

    // Cookieのドメイン制限解除
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const modifiedCookies = setCookie.split(/,(?=[^;]+=[^;]+)/).map(cookie => 
        cookie.replace(/Domain=[^;]+;?/gi, '')
              .replace(/Secure;?/gi, '')
              .replace(/SameSite=(Lax|Strict)/gi, 'SameSite=None')
      );
      res.setHeader('Set-Cookie', modifiedCookies);
    }

    const contentType = response.headers.get("content-type") || "";

    // 6. HTMLコンテンツの書き換え（インジェクション）
    if (contentType.includes("text/html")) {
      let html = await response.text();

      // ブラウザ側で動作する最強のプロキシ維持スクリプト
      const injection = `
<base href="${targetUrl.origin}/">
<script>
  (function() {
    const P_BASE = '${proxyBase}';
    const T_ORIGIN = '${targetUrl.origin}';

    function wrap(url) {
      if (!url || typeof url !== 'string' || url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('#')) return url;
      try {
        const abs = new URL(url, T_ORIGIN).href;
        return P_BASE + encodeURIComponent(abs);
      } catch(e) { return url; }
    }

    // A. フォーム送信(検索)ジャック
    window.addEventListener('submit', function(e) {
      const f = e.target;
      if (f.method.toUpperCase() === 'GET') {
        e.preventDefault();
        const fd = new FormData(f);
        const sp = new URLSearchParams();
        for (let [k, v] of fd.entries()) sp.append(k, v);
        const act = f.getAttribute('action') || '';
        const target = new URL(act, T_ORIGIN);
        const final = target.origin + target.pathname + '?' + sp.toString();
        window.location.href = wrap(final);
      }
    }, true);

    // B. 全クリックジャック
    window.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (a && a.href && !a.href.startsWith('javascript:') && !a.getAttribute('href').startsWith('#')) {
        e.preventDefault();
        window.location.href = wrap(a.href);
      }
    }, true);

    // C. History API監視 (SPA遷移対策)
    const ops = history.pushState;
    history.pushState = function() {
      if (arguments[2]) arguments[2] = wrap(arguments[2]);
      return ops.apply(this, arguments);
    };

    // D. 通信API監視
    const of = window.fetch;
    window.fetch = function() {
      if (typeof arguments[0] === 'string') arguments[0] = wrap(arguments[0]);
      return of.apply(this, arguments);
    };

    // E. 履歴保存エンジン
    try {
      const log = JSON.parse(localStorage.getItem('proxy_history') || '[]');
      const cur = new URL(window.location.href).searchParams.get('url');
      if (cur && (!log[0] || log[0].url !== cur)) {
        log.unshift({ t: document.title, url: cur, d: Date.now() });
        localStorage.setItem('proxy_history', JSON.stringify(log.slice(0, 50)));
      }
    } catch(e) {}
  })();
</script>
`;
      // <head>の直後にスクリプトを挿入
      html = html.replace(/<head>/i, '<head>' + injection);

      // 静的なタグのhref/srcを置換
      html = html.replace(/(src|href|action)=(['"])(?!data:|javascript:|#)(.*?)\2/gi, (m, attr, q, path) => {
        try {
          const abs = new URL(path, targetUrl.href).href;
          return attr + '=' + q + proxyBase + encodeURIComponent(abs) + q;
        } catch(e) { return m; }
      });

      return res.send(html);
    }

    // 7. CSSのURL書き換え
    if (contentType.includes("text/css")) {
      let css = await response.text();
      css = css.replace(/url\((?!['"]?(?:data:))(['"]?)([^'")]+)\1\)/g, (m, q, p) => {
        try {
          const abs = new URL(p, targetUrl.href).href;
          return 'url(' + q + proxyBase + encodeURIComponent(abs) + q + ')';
        } catch(e) { return m; }
      });
      return res.send(css);
    }

    // 8. その他のバイナリデータ（画像・JSなど）
    const buffer = await response.arrayBuffer();
    res.setHeader('Content-Type', contentType);
    res.send(Buffer.from(buffer));

  } catch (err) {
    console.error("PROXY_ERROR:", err);
    res.status(500).send("Proxy Critical Error: " + err.message);
  }
}
