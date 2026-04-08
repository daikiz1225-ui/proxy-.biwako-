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
    res.setHeader("Content-Type", contentType);
    res.setHeader("X-Frame-Options", "ALLOWALL"); // iframe拒否を潰す

    if (contentType.includes("text/html")) {
      let html = await response.text();

      // --- 1. インジェクトスクリプト（JSレベルの防御） ---
      const injection = `
<base href="${targetUrl.origin}/">
<script>
  // iframe脱出防止
  window.self = window.top;
  window.parent = window.self;

  // fetchをプロキシ経由に
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

      // --- 2. 【超強力】全ての絶対URLをプロキシ経由に置換 ---
      // サイト内のあらゆる "https://..." を "/proxy?url=https://..." に書き換える
      const proxyBase = `${proxyOrigin}/proxy?url=`;
      html = html.replace(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g, (match) => {
        // 自分のドメインや、一部の除外ドメイン（google等）は置換しない
        if (match.includes(req.headers["host"])) return match;
        return `${proxyBase}${encodeURIComponent(match)}`;
      });

      // iframe脱出用のJSコード（window.top.locationなど）を無力化
      html = html.replace(/top\.location/g, 'self.location');
      html = html.replace(/window\.top/g, 'window.self');

      return res.send(html);
    }

    // 画像やCSSはそのまま
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));

  } catch (error) {
    res.status(500).send("Proxy Error: " + error.message);
  }
}
