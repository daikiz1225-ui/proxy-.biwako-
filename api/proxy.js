export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).send("URLが必要です");

  try {
    const targetUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
    
    const response = await fetch(targetUrl.href, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });

    const contentType = response.headers.get("content-type") || "";
    res.setHeader("Content-Type", contentType);

    // HTMLの場合のみ、中身を書き換える
    if (contentType.includes("text/html")) {
      let html = await response.text();
      
      // 1. hrefとsrcの書き換え
      // 例: href="/about" -> href="/proxy?url=https://target.com/about"
      const proxyBase = `${req.headers["x-forwarded-proto"]}://${req.headers["host"]}/proxy?url=`;
      
      html = html.replace(/(href|src)="(?!http|\/\/)([^"]+)"/g, (match, p1, p2) => {
        const absoluteUrl = new URL(p2, targetUrl.origin).href;
        return `${p1}="${proxyBase}${encodeURIComponent(absoluteUrl)}"`;
      });

      // 2. http:// または https:// で始まるフルURLも書き換え
      html = html.replace(/(href|src)="(https?:\/\/[^"]+)"/g, (match, p1, p2) => {
        // 自分のドメイン宛てでなければプロキシを通す
        if (p2.includes(req.headers["host"])) return match;
        return `${p1}="${proxyBase}${encodeURIComponent(p2)}"`;
      });

      return res.send(html);
    }

    // HTML以外（画像、JS、CSSなど）はそのまま流す
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));

  } catch (error) {
    res.status(500).send("Proxy Error: " + error.message);
  }
}
