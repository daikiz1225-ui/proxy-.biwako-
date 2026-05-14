export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).send("URL is required");

  try {
    const targetUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
    const proxyOrigin = `${req.headers["x-forwarded-proto"] || 'https'}://${req.headers["host"]}`;
    const proxyBase = `${proxyOrigin}/proxy?url=`;

    // 1. ヘッダーの徹底偽装
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

    const response = await fetch(targetUrl.href, {
      method: req.method,
      headers: headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined,
      redirect: 'manual'
    });

    // リダイレクト処理 (301/302対策)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        const redirUrl = new URL(location, targetUrl.origin).href;
        return res.redirect(`${proxyBase}${encodeURIComponent(redirUrl)}`);
      }
    }

    res.status(response.status);

    // セキュリティ制限の解除とCookieの調整
    const blockHeaders = ['content-encoding', 'content-length', 'x-frame-options', 'content-security-policy', 'strict-transport-security', 'set-cookie'];
    response.headers.forEach((value, key) => {
      if (!blockHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    res.setHeader("X-Frame-Options", "ALLOWALL");

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const modifiedCookies = setCookie.split(/,(?=[^;]+=[^;]+)/).map(cookie => 
        cookie.replace(/Domain=[^;]+;?/gi, '').replace(/Secure;?/gi, '').replace(/SameSite=(Lax|Strict)/gi, 'SameSite=None')
      );
      res.setHeader('Set-Cookie', modifiedCookies);
    }

    const contentType = response.headers.get("content-type") || "";

    // --- HTML書き換えセクション ---
    if (contentType.includes("text/html")) {
      let html = await response.text();

      // 最強のフロントエンド・ハイジャック・スクリプト
      const injection = `
<base href="${targetUrl.origin}/">
<script>
  (function() {
    const proxyBase = '${proxyBase}';
    const targetOrigin = '${targetUrl.origin}';

    function toProxyUrl(url) {
      if (!url || typeof url !== 'string') return url;
      if (url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('#')) return url;
      try {
        const absoluteUrl = new URL(url, targetOrigin).href;
        return proxyBase + encodeURIComponent(absoluteUrl);
      } catch(e) { return url; }
    }

    // 1. フォーム送信(検索)の乗っ取り
    window.addEventListener('submit', function(e) {
      const form = e.target;
      const action = form.getAttribute('action') || '';
      const targetActionUrl = new URL(action, targetOrigin);
      
      if (form.method.toUpperCase() === 'GET') {
        e.preventDefault();
        const params = new URLSearchParams(new FormData(form));
        const finalUrl = targetActionUrl.origin + targetActionUrl.pathname + '?' + params.toString();
        window.location.href = toProxyUrl(finalUrl);
      }
    }, true);

    // 2. History API (URL書き換え) の監視
    const _pushState = history.pushState;
    history.pushState = function(state, title, url) {
      if (url) arguments[2] = toProxyUrl(url);
      return _pushState.apply(this, arguments);
    };

    // 3. クリックイベント
    window.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (a && a.href && !a.href.startsWith('javascript:')) {
        e.preventDefault();
        window.location.href = toProxyUrl(a.href);
      }
    }, true);

    // 4. 通信API(fetch/XHR)
    const _fetch = window.fetch;
    window.fetch = function() {
      if (arguments[0] && typeof arguments[0] === 'string') arguments[0] = toProxyUrl(arguments[0]);
      return _fetch.apply(this, arguments);
    };

    // 5. 履歴保存
    try {
      const historyLog = JSON.parse(localStorage.getItem('proxy_history') || '[]');
      const currentUrl = new URL(window.location.href).searchParams.get('url');
      if (currentUrl && historyLog[0]?.url !== currentUrl) {
        historyLog.unshift({ title: document.title, url: currentUrl, time: Date.now() });
        localStorage.setItem('proxy_history', JSON.stringify(historyLog.slice(0, 50)));
      }
    } catch(e) {}
  })();
</script>
`;
      // Headタグの直後に注入
      html = html.replace(/<head>/i, '<head>' + injection);

      // 静的な属性の書き換え (フォールバック)
      html = html.replace(/(src|href|action)=(['"])(?!data:|javascript:|#)(.*?)\2/gi, (match, attr, quote, path) => {
        try {
          const absoluteUrl = new URL(path, targetUrl.href).href;
          return \`\${attr}=\${quote}\${proxyBase}\${encodeURIComponent(absoluteUrl)}\${quote}\`;
        } catch (e) { return match; }
      });

      return res.send(html);
    }

    // CSS内のURL書き換え
    if (contentType.includes("text/css")) {
      let css = await response.text();
      css = css.replace(/url\((?!['"]?(?:data:))(['"]?)([^'")]+)\1\)/g, (match, quote, path) => {
        try {
          const absoluteUrl = new URL(path, targetUrl.href).href;
          return `url(${quote}${proxyBase}${encodeURIComponent(absoluteUrl)}${quote})`;
        } catch (e) { return match; }
      });
      return res.send(css);
    }

    // 画像などのバイナリデータ
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));

  } catch (error) {
    res.status(500).send("Proxy Error: " + error.message);
  }
}
