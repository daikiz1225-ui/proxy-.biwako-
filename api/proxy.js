export default async function handler(req, res) {
  const { url } = req.query;

  if (!url || typeof url !== 'string') {
    return res.status(400).send("URL parameter is required.");
  }

  try {
    const rawUrl = url.startsWith('http') ? url : `https://${url}`;
    const targetUrl = new URL(rawUrl);
    const proxyOrigin = `${req.headers["x-forwarded-proto"] || 'https'}://${req.headers["host"]}`;
    const proxyBase = `${proxyOrigin}/proxy?url=`;

    // --- 1. リクエストヘッダーの徹底偽装 ---
    const headers = new Headers();
    const skipHeaders = ['host', 'connection', 'referer', 'origin', 'x-vercel-id', 'x-forwarded-for', 'accept-encoding', 'content-length'];
    Object.keys(req.headers).forEach(key => {
      if (!skipHeaders.includes(key.toLowerCase())) {
        headers.set(key, req.headers[key]);
      }
    });

    headers.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36");
    headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8");
    headers.set("Accept-Language", "ja,en-US;q=0.9,en;q=0.8");
    headers.set("Referer", targetUrl.origin + "/");
    headers.set("Origin", targetUrl.origin);

    // --- 2. ターゲットサイトへの通信実行 ---
    const response = await fetch(targetUrl.href, {
      method: req.method,
      headers: headers,
      body: (req.method !== 'GET' && req.method !== 'HEAD') ? JSON.stringify(req.body) : undefined,
      redirect: 'manual'
    });

    // --- 3. リダイレクト(301/302)の完全解決 ---
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        const redirUrl = new URL(location, targetUrl.origin).href;
        return res.redirect(`${proxyBase}${encodeURIComponent(redirUrl)}`);
      }
    }

    // --- 4. レスポンスヘッダーの徹底クリーニング ---
    const blockHeaders = ['content-encoding', 'content-length', 'x-frame-options', 'content-security-policy', 'strict-transport-security', 'set-cookie', 'cross-origin-opener-policy', 'report-to', 'server', 'x-content-type-options'];
    response.headers.forEach((value, key) => {
      if (!blockHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });
    res.setHeader("X-Frame-Options", "ALLOWALL");
    res.setHeader("Access-Control-Allow-Origin", "*");

    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const cookies = setCookie.split(/,(?=[^;]+=[^;]+)/).map(c => 
        c.replace(/Domain=[^;]+;?/gi, '').replace(/Secure;?/gi, '').replace(/SameSite=(Lax|Strict)/gi, 'SameSite=None')
      );
      res.setHeader('Set-Cookie', cookies);
    }

    const contentType = response.headers.get("content-type") || "";
    res.status(response.status);

    // --- 5. コンテンツ変換エンジン (最大化) ---

    if (contentType.includes("text/html")) {
      let html = await response.text();

      // [サーバー側] 1. 全ての属性(src, href, action等)を力技で置換
      // Wikipediaのアイコン崩れ防止のため、data-srcやsrcsetも対象
      html = html.replace(/(src|href|action|poster|data-src|data-thumb|srcset|data-srcset)=(['"])(?!data:|javascript:|#)(.*?)\2/gi, (match, attr, q, p) => {
        try {
          const absolute = new URL(p, targetUrl.href).href;
          return `${attr}=${q}${proxyBase}${encodeURIComponent(absolute)}${q}`;
        } catch(e) { return match; }
      });

      // [サーバー側] 2. <style>内のurl()を置換
      html = html.replace(/url\((?!['"]?(?:data:|about:))(['"]?)([^'")]+)\1\)/g, (match, q, p) => {
        try {
          const absolute = new URL(p, targetUrl.href).href;
          return `url(${q}${proxyBase}${encodeURIComponent(absolute)}${q})`;
        } catch(e) { return match; }
      });

      // [サーバー側] 3. JS文字列内のURLを強引に書き換え
      // ※ YouTube等の動的パス解決を壊さない程度に強化
      html = html.replace(/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g, (match) => {
        if (match.includes(req.headers["host"]) || match.includes('fonts.googleapis.com') || match.includes('gstatic.com')) return match;
        return `${proxyBase}${encodeURIComponent(match)}`;
      });

      // [クライアント側] 4. フロントエンド・ハイジャック・エンジンの注入
      // ここを大幅に長文化し、あらゆるAPIをフックします。
      const injection = `
<base href="${targetUrl.origin}/">
<script>
  (function() {
    const PROXY_URL = '${proxyBase}';
    const TARGET_ORIG = '${targetUrl.origin}';

    function rewrite(u) {
      if (!u || typeof u !== 'string' || u.startsWith('data:') || u.startsWith('javascript:') || u.startsWith('#') || u.includes(location.host)) return u;
      try {
        const absolute = new URL(u, TARGET_ORIG).href;
        return PROXY_URL + encodeURIComponent(absolute);
      } catch(e) { return u; }
    }

    // 1. フォーム送信の完全インターセプト
    window.addEventListener('submit', function(e) {
      const form = e.target;
      if (form.method.toUpperCase() === 'GET') {
        e.preventDefault();
        const formData = new FormData(form);
        const params = new URLSearchParams();
        for (let [key, value] of formData.entries()) params.append(key, value);
        const action = form.getAttribute('action') || '';
        const target = new URL(action, TARGET_ORIG);
        const finalUrl = target.origin + target.pathname + '?' + params.toString();
        window.location.href = rewrite(finalUrl);
      }
    }, true);

    // 2. DOM Mutation Observer (動的に追加される全要素の監視)
    const obs = new MutationObserver(muts => {
      muts.forEach(m => m.addedNodes.forEach(n => {
        if (n.nodeType === 1) {
          const check = (el) => {
            if (el.src) el.src = rewrite(el.src);
            if (el.href && el.tagName !== 'A') el.href = rewrite(el.href);
            if (el.action) el.action = rewrite(el.action);
            if (el.getAttribute('srcset')) el.setAttribute('srcset', rewrite(el.getAttribute('srcset')));
          };
          check(n);
          n.querySelectorAll && n.querySelectorAll('[src], [href], [action], [srcset]').forEach(check);
        }
      }));
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });

    // 3. ブラウザ標準APIの徹底的ハイジャック
    const originalFetch = window.fetch;
    window.fetch = function() {
      if (typeof arguments[0] === 'string') arguments[0] = rewrite(arguments[0]);
      return originalFetch.apply(this, arguments);
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function() {
      if (typeof arguments[1] === 'string') arguments[1] = rewrite(arguments[1]);
      return originalOpen.apply(this, arguments);
    };

    const { pushState, replaceState } = history;
    history.pushState = function() { if(arguments[2]) arguments[2] = rewrite(arguments[2]); return pushState.apply(this, arguments); };
    history.replaceState = function() { if(arguments[2]) arguments[2] = rewrite(arguments[2]); return replaceState.apply(this, arguments); };

    // 4. クリックジャック
    window.addEventListener('click', e => {
      const a = e.target.closest('a');
      if (a && a.href && !a.href.startsWith('javascript:') && !a.getAttribute('href')?.startsWith('#')) {
        e.preventDefault();
        window.location.href = rewrite(a.href);
      }
    }, true);

    // 5. 履歴保存
    try {
      const h = JSON.parse(localStorage.getItem('proxy_history') || '[]');
      const u = new URL(window.location.href).searchParams.get('url');
      if (u && (!h[0] || h[0].url !== u)) {
        h.unshift({ title: document.title, url: u, time: Date.now() });
        localStorage.setItem('proxy_history', JSON.stringify(h.slice(0, 50)));
      }
    } catch(e) {}

    // 脱出防止
    window.self = window.top;
    window.onbeforeunload = function() {}; // 脱出防止のためのガード
  })();
</script>
`;
      html = html.replace(/<head[^>]*>/i, '$&' + injection);
      return res.send(html);

    } else if (contentType.includes("text/css")) {
      // [サーバー側] CSSファイル内のurl()を全スキャンして置換
      let css = await response.text();
      css = css.replace(/url\((?!['"]?(?:data:|about:))(['"]?)([^'")]+)\1\)/g, (match, q, p) => {
        try {
          const absolute = new URL(p, targetUrl.href).href;
          return `url(${q}${proxyBase}${encodeURIComponent(absolute)}${q})`;
        } catch(e) { return match; }
      });
      return res.send(css);

    } else {
      // JS、画像、フォント等のバイナリデータ
      const buffer = await response.arrayBuffer();
      res.setHeader('Content-Type', contentType);
      return res.send(Buffer.from(buffer));
    }

  } catch (err) {
    console.error("CRITICAL_PROXY_ERROR:", err);
    res.status(500).send("Proxy Fail: " + err.message);
  }
}
