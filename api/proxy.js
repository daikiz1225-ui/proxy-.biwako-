export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).send("URL is required");

  try {
    const targetUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
    const proxyOrigin = `${req.headers["x-forwarded-proto"]}://${req.headers["host"]}`;

    const headers = new Headers();
    const skipHeaders = ['host', 'connection', 'referer', 'origin', 'x-vercel-id', 'x-forwarded-for'];
    Object.keys(req.headers).forEach(key => {
      if (!skipHeaders.includes(key.toLowerCase())) {
        headers.set(key, req.headers[key]);
      }
    });

    // YouTube用の偽装ヘッダー
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    headers.set("Referer", targetUrl.origin + "/");

    const response = await fetch(targetUrl.href, {
      method: req.method,
      headers: headers,
      redirect: 'manual'
    });

    res.status(response.status);

    // Cookieのリレー
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const modifiedCookies = setCookie.split(/,(?=[^;]+=[^;]+)/).map(cookie => 
        cookie.replace(/Domain=[^;]+;?/gi, '').replace(/Secure/gi, '').replace(/SameSite=(Lax|Strict)/gi, 'SameSite=None')
      );
      res.setHeader('Set-Cookie', modifiedCookies);
    }

    response.headers.forEach((value, key) => {
      if (!['content-encoding', 'content-length', 'x-frame-options', 'content-security-policy', 'set-cookie'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    res.setHeader("X-Frame-Options", "ALLOWALL");

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        const redirUrl = new URL(location, targetUrl.origin).href;
        return res.redirect(`/proxy?url=${encodeURIComponent(redirUrl)}`);
      }
    }

    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("text/html")) {
      let html = await response.text();

      const injection = `
<base href="${targetUrl.origin}/">
<script>
  (function() {
    const proxyPath = '${proxyOrigin}/proxy?url=';
    const targetOrigin = '${targetUrl.origin}';

    // プロキシURL作成関数
    function toProxyUrl(url) {
      if (!url || url.startsWith(window.location.origin) || url.startsWith('javascript:')) return url;
      const fullUrl = new URL(url, targetOrigin).href;
      return proxyPath + encodeURIComponent(fullUrl);
    }

    // 1. 履歴保存
    try {
      const history = JSON.parse(localStorage.getItem('proxy_history') || '[]');
      const newEntry = { title: document.title, url: window.location.href, time: Date.now() };
      if (history[0]?.url !== newEntry.url) {
        history.unshift(newEntry);
        localStorage.setItem('proxy_history', JSON.stringify(history.slice(0, 50)));
      }
    } catch(e) {}

    // 2. 脱出防止 (window.topの偽装)
    window.self = window.top;
    window.parent = window.self;

    // 3. クリック & フォーム送信ジャック (検索対策)
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

    // 4. 通信ジャック
    const originalFetch = window.fetch;
    window.fetch = function() {
      if (typeof arguments[0] === 'string') arguments[0] = toProxyUrl(arguments[0]);
      return originalFetch.apply(this, arguments);
    };
  })();
</script>
`;
      html = html.replace('<head>', '<head>' + injection);
      
      // 文字列置換は最小限にし、JSでの動的解決に任せる
      return res.send(html);
    }

    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));

  } catch (error) {
    res.status(500).send("Proxy Error: " + error.message);
  }
}
