export default async function handler(req, res) {
  const { url } = req.query;

  if (!url) {
    return res.status(400).send("URLパラメータ (?url=...) が必要です。");
  }

  try {
    const targetUrl = url.startsWith('http') ? url : `https://${url}`;

    // ターゲットサイトへリクエストを送信
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "*/*"
      }
    });

    // レスポンスヘッダーをコピー
    const contentType = response.headers.get("content-type");
    res.setHeader("Content-Type", contentType);

    // データをストリーム形式でブラウザに流し込む（動画対応）
    const reader = response.body.getReader();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }

    res.end();
  } catch (error) {
    res.status(500).send("エラーが発生しました: " + error.message);
  }
}
