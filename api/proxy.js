export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).send("URL is required");

  try {
    const targetUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
    const proxyOrigin = `${req.headers["x-forwarded-proto"]}://${req.headers["host"]}`;

    // 1. リクエストヘッダーの構築（徹底的な偽装）
    const headers = new Headers();
    
    // ブラウザから送られてきたヘッダーをコピー（ただし危険なものは除外）
    const skipHeaders = ['host', 'connection', 'referer', 'origin', 'x-vercel-id', 'x-forwarded-for'];
    Object.keys(req.headers).forEach(key => {
      if (!skipHeaders.includes(key.toLowerCase())) {
        headers.set(key, req.headers[key]);
      }
    });

    // YouTube用の完璧ななりすましヘッダー
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7");
    headers.set("Accept-Language", "ja,en-US;q=0.9,en;q=0.8");
    headers.set("Referer", targetUrl.origin + "/");
    headers.set("Origin", targetUrl.origin);
    
    // Client Hints (これが無いと最近のGoogle系はbot判定しやすい)
    headers.set("sec-ch-ua", '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"');
    headers.set("sec-ch-ua-mobile", "?0");
    headers.set("sec-ch-ua-platform", '"Windows"');
    headers.set("sec-fetch-dest", "document");
    headers.set("sec-fetch-mode", "navigate");
    headers.set("sec-fetch-site", "cross-site");
    headers.set("sec-fetch-user", "?1");

    // 2. ターゲットサイトへアクセス
    const response = await fetch(targetUrl.href, {
      method: req.method,
      headers: headers,
      redirect: 'manual'
    });

    // 3. レスポンスステータスの処理
    res.status(response.status);

    // 4. Cookieのリレー（YouTube -> ブラウザ）
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const modifiedCookies = setCookie.split(/,(?=[^;]+=[^;]+)/).map(cookie => 
        cookie.replace(/Domain=[^;]+;?/gi, '') // ドメイン制限を削除
              .replace(/Secure/gi, '')        // HTTPでも動作可能に
              .replace(/SameSite=(Lax|Strict)/gi, 'SameSite=None')
      );
      res.setHeader('Set-Cookie', modifiedCookies);
    }

    // 5. その他のヘッダー設定
    response.headers.forEach((value, key) => {
      if (!['content-encoding', 'content-length', 'x-frame-options', 'content-security-policy', 'set-cookie'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader("Access-Control-Allow-Origin", "*");

    // 6. リダイレクト対応
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        const redirUrl = new URL(location, targetUrl.origin).href;
        return res.redirect(`/proxy?url=${encodeURIComponent(redirUrl)}`);
      }
    }

    const contentType = response.headers.get("content-type") || "";

    // 7. HTMLの書き換えロジック
    if (contentType.includes("text/html")) {
      let html = await response.text();

      // JSインジェクション: 通信の横取りとiframe脱出防止
      const injection = `
<base href="${targetUrl.origin}/">
<script>
  (function() {
    // 脱出防止
    window.self = window.top;
    window.parent = window.self;

    const proxyPath = '${proxyOrigin}/proxy?url=';
    const targetOrigin = '${targetUrl.origin}';

    // Fetchジャック
    const originalFetch = window.fetch;
    window.fetch = function() {
      if (typeof arguments[0] === 'string' && !arguments[0].startsWith(window.location.origin)) {
        arguments[0] = proxyPath + encodeURIComponent(new URL(arguments[0], targetOrigin).href);
      }
      return originalFetch.apply(this, arguments);
    };

    // XMLHttpRequestジャック
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function() {
      if (typeof arguments[1] === 'string' && !arguments[1].startsWith(window.location.origin)) {
        arguments[1] = proxyPath + encodeURIComponent(new URL(arguments[1], targetOrigin).href);
      }
      return originalOpen.apply(this, arguments);
    };

    // クリックジャック
    document.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (a && a.href && !a.href.startsWith(window.location.origin)) {
        e.preventDefault();
        window.location.href = proxyPath + encodeURIComponent(a.href);
      }
    }, true);
  })();
</script>
`;
      html = html.replace('<head>', '<head>' + injection);

      // 強引なURL一括置換
      const proxyBase = `${proxyOrigin}/proxy?url=`;
      html = html.replace(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g, (match) => {
        // 自分のドメインや特定の重要ドメインは除外
        if (match.includes(req.headers["host"]) || match.includes('fonts.googleapis.com')) return match;
        return `${proxyBase}${encodeURIComponent(match)}`;
      });

      // iframe脱出用コードの無効化
      html = html.replace(/top\.location/g, 'self.location').replace(/window\.top/g, 'window.self');

      return res.send(html);
    }

    // 8. バイナリ（動画・画像）のストリーミング転送
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));

  } catch (error) {
    console.error(error);
    res.status(500).send("Proxy Error: " + error.message);
  }
}
