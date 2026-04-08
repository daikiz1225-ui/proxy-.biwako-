export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).send("URLが必要です");

  try {
    const targetUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
    const proxyOrigin = `${req.headers["x-forwarded-proto"]}://${req.headers["host"]}`;

    const response = await fetch(targetUrl.href, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      }
    });

    let contentType = response.headers.get("content-type") || "";
    
    // 安全のためにヘッダーを掃除
    res.setHeader("Content-Type", contentType);
    res.setHeader("X-Frame-Options", "ALLOWALL"); // iframe拒否を解除
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (contentType.includes("text/html")) {
      let html = await response.text();

      // --- 1. インジェクトスクリプト（JSジャック & 脱出防止） ---
      const injection = `
<base href="${targetUrl.origin}/">
<script>
  // iframe脱出コード(window.top = window.self)の無効化
  window.self = window.top;
  window.parent = window.self;

  // fetchのジャック
  const originalFetch = window.fetch;
  window.fetch = function() {
    let arg = arguments[0];
    if (typeof arg === 'string' && !arg.includes(location.host)) {
      arguments[0] = '${proxyOrigin}/proxy?url=' + encodeURIComponent(new URL(arg, '${targetUrl.origin}').href);
    }
    return originalFetch.apply(this, arguments);
  };

  // リンククリックのジャック
  document.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (a && a.href && !a.href.includes(location.host)) {
      e.preventDefault();
      window.location.href = '${proxyOrigin}/proxy?url=' + encodeURIComponent(a.href);
    }
  }, true);
</script>
`;
      // <head>の直後に差し込む。同時にサイト側のiframe脱出コードを無効化。
      html = html.replace('<head>', '<head>' + injection);
      html = html.replace(/window\.top/g, 'window.self');
      html = html.replace(/top\.location/g, 'self.location');

      // --- 2. 既存のhref/srcを全置換 ---
      const proxyBase = `${proxyOrigin}/proxy?url=`;
      html = html.replace(/(href|src)="(https?:\/\/[^"]+)"/g, (match, p1, p2) => {
        if (p2.includes(req.headers["host"])) return match;
        return `${p1}="${proxyBase}${encodeURIComponent(p2)}"`;
      });

      return res.send(html);
    }

    // HTML以外はバイナリでそのまま返す
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));

  } catch (error) {
    res.status(500).send("Proxy Error: " + error.message);
  }
}
