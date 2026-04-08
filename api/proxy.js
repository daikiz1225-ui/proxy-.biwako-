export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).send("URLが必要です");

  try {
    const targetUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
    const proxyOrigin = `${req.headers["x-forwarded-proto"]}://${req.headers["host"]}`;

    const response = await fetch(targetUrl.href, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
      }
    });

    const contentType = response.headers.get("content-type") || "";
    res.setHeader("Content-Type", contentType);

    if (contentType.includes("text/html")) {
      let html = await response.text();

      // --- 1. <head>の直後にジャックスクリプトと<base>を挿入 ---
      const injection = `
<base href="${targetUrl.origin}/">
<script>
  // 1. fetchを乗っ取る
  const originalFetch = window.fetch;
  window.fetch = function() {
    let arg = arguments[0];
    if (typeof arg === 'string' && !arg.includes('${proxyOrigin}')) {
      arguments[0] = '${proxyOrigin}/proxy?url=' + encodeURIComponent(new URL(arg, location.href).href);
    }
    return originalFetch.apply(this, arguments);
  };

  // 2. XMLHttpRequest(古い通信方式)を乗っ取る
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function() {
    if (!arguments[1].includes('${proxyOrigin}')) {
      arguments[1] = '${proxyOrigin}/proxy?url=' + encodeURIComponent(new URL(arguments[1], location.href).href);
    }
    originalOpen.apply(this, arguments);
  };

  // 3. 画面遷移を監視して、無理やりプロキシを通す
  document.addEventListener('click', e => {
    const a = e.target.closest('a');
    if (a && a.href && !a.href.includes('${proxyOrigin}')) {
      e.preventDefault();
      window.location.href = '${proxyOrigin}/proxy?url=' + encodeURIComponent(a.href);
    }
  }, true);
</script>
`;
      html = html.replace('<head>', '<head>' + injection);

      // --- 2. HTML内の既存リンクを書き換え ---
      const proxyBase = `${proxyOrigin}/proxy?url=`;
      html = html.replace(/(href|src)="(https?:\/\/[^"]+)"/g, (match, p1, p2) => {
        if (p2.includes(req.headers["host"])) return match;
        return `${p1}="${proxyBase}${encodeURIComponent(p2)}"`;
      });

      return res.send(html);
    }

    // HTML以外はそのまま
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));

  } catch (error) {
    res.status(500).send("Proxy Error: " + error.message);
  }
}
