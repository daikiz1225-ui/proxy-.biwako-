export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).send("URLを指定してください");

  try {
    const targetUrl = url.startsWith('http') ? url : `https://${url}`;
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });

    const contentType = response.headers.get("content-type");
    let body;

    // 画像や動画などのバイナリデータと、HTMLテキストで処理を分ける
    if (contentType && (contentType.includes("text") || contentType.includes("javascript") || contentType.includes("json"))) {
      body = await response.text();
      // リンクをプロキシ経由に書き換える（簡易版）
      const origin = new URL(targetUrl).origin;
      body = body.replace(/(href|src)="\/(?!\/)/g, `$1="${origin}/`); 
    } else {
      body = Buffer.from(await response.arrayBuffer());
    }

    res.setHeader("Content-Type", contentType);
    res.status(200).send(body);
  } catch (e) {
    res.status(500).send("Error: " + e.message);
  }
}
