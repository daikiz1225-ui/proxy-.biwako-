export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).send("URLが必要です");

  try {
    const targetUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
    const proxyOrigin = `${req.headers["x-forwarded-proto"]}://${req.headers["host"]}`;

    // 1. リクエストヘッダーの偽装
    const headers = new Headers();
    const forbiddenHeaders = ['host', 'connection', 'referer', 'origin'];
    
    Object.keys(req.headers).forEach(key => {
      if (!forbiddenHeaders.includes(key.toLowerCase())) {
        headers.set(key, req.headers[key]);
      }
    });

    // YouTubeが拒否しないように正規のヘッダーをセット
    headers.set("Referer", targetUrl.origin + "/");
    headers.set("Origin", targetUrl.origin);
    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
　　headers.set("sec-ch-ua", '"Not A;Brand";v="99", "Chromium";v="120", "Google Chrome";v="120"');
headers.set("sec-ch-ua-mobile", "?0");
headers.set("sec-ch-ua-platform", '"Windows"');

    // 2. ターゲットへリクエスト
    const response = await fetch(targetUrl.href, {
      method: req.method,
      headers: headers,
      redirect: 'manual' // リダイレクトを自分で処理してプロキシを通すため
    });

    // 3. レスポンスヘッダーの処理
    res.status(response.status);
    
    // 全ヘッダーをコピー
    response.headers.forEach((value, key) => {
      // セキュリティ制限を外す
      if (!['content-encoding', 'content-length', 'x-frame-options', 'content-security-policy'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader("Access-Control-Allow-Origin", "*");

    // 4. Cookieの中継と書き換え
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const modifiedCookies = setCookie.split(/,(?=[^;]+=[^;]+)/).map(cookie => 
        cookie.replace(/Domain=[^;]+;?/gi, '') // ドメイン制限解除
              .replace(/Secure/gi, '')        // HTTPでも通るように
              .replace(/SameSite=(Lax|Strict)/gi, 'SameSite=None')
      );
      res.setHeader('Set-Cookie', modifiedCookies);
    }

    // 5. リダイレクト対応
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        const redirUrl = new URL(location, targetUrl.origin).href;
        return res.redirect(`/proxy?url=${encodeURIComponent(redirUrl)}`);
      }
    }

    const contentType = response.headers.get("content-type") || "";

    // HTMLの書き換えロジック
    if (contentType.includes("text/html")) {
      let html = await response.text();

      // JSインジェクション
      const injection = `
<base href="${targetUrl.origin}/">
<script>
  window.self = window.top;
  window.parent = window.self;
  const orgFetch = window.fetch;
  window.fetch = function() {
    if (typeof arguments[0] === 'string' && !arguments[0].includes(location.host)) {
      arguments[0] = '${proxyOrigin}/proxy?url=' + encodeURIComponent(new URL(arguments[0], '${targetUrl.origin}').href);
    }
    return orgFetch.apply(this, arguments);
  };
</script>
`;
      html = html.replace('<head>', '<head>' + injection);

      // 強力なURL置換
      const proxyBase = `${proxyOrigin}/proxy?url=`;
      html = html.replace(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g, (match) => {
        if (match.includes(req.headers["host"]) || match.includes('gstatic.com')) return match;
        return `${proxyBase}${encodeURIComponent(match)}`;
      });

      return res.send(html);
    }

    // バイナリデータ（画像・動画）の転送
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));

  } catch (error) {
    res.status(500).send("Proxy Error: " + error.message);
  }
}
