export default async function handler(req, res) {
  const { url, videoId } = req.query;

  // --- 【追加】videoIdが送られた場合：関連動画IDだけをスクレイピングして返す ---
  if (videoId) {
    try {
      const targetUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const headers = new Headers();
      headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
      headers.set("Accept-Language", "ja,en-US;q=0.9,en;q=0.8");
      if (req.headers.cookie) {
        headers.set("Cookie", req.headers.cookie);
      }

      const response = await fetch(targetUrl, { method: "GET", headers: headers });
      const html = await response.text();

      // ytInitialData から関連動画リストを抽出
      const jsonMatch = html.match(/var ytInitialData = (\{.*?\});/);
      if (jsonMatch) {
        const rawData = JSON.parse(jsonMatch[1]);
        const results = rawData.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results || [];
        
        // IDだけを配列にする
        const relatedIds = results
          .map(item => item.compactVideoRenderer?.videoId || item.autoplayVideoRenderer?.config?.autoplayVideo?.compactVideoRenderer?.videoId)
          .filter(id => id !== undefined);

        res.setHeader("Content-Type", "application/json");
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.status(200).json(relatedIds);
      }
      return res.status(404).json({ error: "Data not found" });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  // --- 【既存】urlが送られた場合：iframe用のHTML/通信プロキシ ---
  if (!url) return res.status(400).send("URL or videoId is required");

  try {
    const targetUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
    const proxyOrigin = `${req.headers["x-forwarded-proto"]}://${req.headers["host"]}`;

    const headers = new Headers();
    const skipHeaders = ['host', 'connection', 'referer', 'origin', 'x-vercel-id', 'x-forwarded-for'];
    Object.keys(req.headers).forEach(key => {
      if (!skipHeaders.includes(key.toLowerCase())) headers.set(key, req.headers[key]);
    });

    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7");
    headers.set("Accept-Language", "ja,en-US;q=0.9,en;q=0.8");
    headers.set("Referer", targetUrl.origin + "/");
    headers.set("Origin", targetUrl.origin);
    headers.set("sec-ch-ua", '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"');
    headers.set("sec-ch-ua-mobile", "?0");
    headers.set("sec-ch-ua-platform", '"Windows"');
    headers.set("sec-fetch-dest", "document");
    headers.set("sec-fetch-mode", "navigate");
    headers.set("sec-fetch-site", "cross-site");
    headers.set("sec-fetch-user", "?1");

    const response = await fetch(targetUrl.href, { method: req.method, headers: headers, redirect: 'manual' });
    res.status(response.status);

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
    res.setHeader("Access-Control-Allow-Origin", "*");

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
    window.self = window.top; window.parent = window.self;
    const proxyPath = '${proxyOrigin}/proxy?url=';
    const targetOrigin = '${targetUrl.origin}';
    const originalFetch = window.fetch;
    window.fetch = function() {
      if (typeof arguments[0] === 'string' && !arguments[0].startsWith(window.location.origin)) {
        arguments[0] = proxyPath + encodeURIComponent(new URL(arguments[0], targetOrigin).href);
      }
      return originalFetch.apply(this, arguments);
    };
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function() {
      if (typeof arguments[1] === 'string' && !arguments[1].startsWith(window.location.origin)) {
        arguments[1] = proxyPath + encodeURIComponent(new URL(arguments[1], targetOrigin).href);
      }
      return originalOpen.apply(this, arguments);
    };
    document.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (a && a.href && !a.href.startsWith(window.location.origin)) {
        e.preventDefault(); window.location.href = proxyPath + encodeURIComponent(a.href);
      }
    }, true);
  })();
</script>
`;
      html = html.replace('<head>', '<head>' + injection);
      const proxyBase = `${proxyOrigin}/proxy?url=`;
      html = html.replace(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g, (match) => {
        if (match.includes(req.headers["host"]) || match.includes('fonts.googleapis.com')) return match;
        return `${proxyBase}${encodeURIComponent(match)}`;
      });
      html = html.replace(/top\.location/g, 'self.location').replace(/window\.top/g, 'window.self');
      return res.send(html);
    }

    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));

  } catch (error) {
    console.error(error);
    res.status(500).send("Proxy Error: " + error.message);
  }
}
