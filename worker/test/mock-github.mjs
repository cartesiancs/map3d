// A tiny stand-in for github.com / api.github.com (OAuth web flow + GET /user), for local tests only.
import http from "node:http";

export function startMockGitHub({ port = 8788, clientId = "mock-client", clientSecret = "mock-secret" } = {}) {
  const state = { user: { id: 1001, login: "octo-admin", avatar_url: "https://avatars.example/1001", created_at: "2015-01-01T00:00:00Z" }, codes: new Map(), tokens: new Map(), revoked: 0, tokenCalls: 0 };
  let seq = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    const body = await new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
    const send = (status, data, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(data === undefined ? "" : JSON.stringify(data)); };

    // test helper: who the next sign-in is (browser testing with several accounts)
    //   /__mock/as?id=2002&login=octo-user[&created_at=ISO]
    if (req.method === "GET" && url.pathname === "/__mock/as") {
      const id = Number(url.searchParams.get("id"));
      const login = url.searchParams.get("login");
      if (!Number.isSafeInteger(id) || !login) return send(400, { error: "id and login required" });
      state.user = { id, login, avatar_url: null, created_at: url.searchParams.get("created_at") ?? "2015-01-01T00:00:00Z" };
      return send(200, { next: state.user }, { "Access-Control-Allow-Origin": "*" });
    }

    if (req.method === "GET" && url.pathname === "/login/oauth/authorize") {
      if (url.searchParams.get("client_id") !== clientId) return send(400, { error: "bad client" });
      if (url.searchParams.has("scope") && url.searchParams.get("scope") !== "") return send(400, { error: "unexpected scope" });
      const code = `code-${++seq}`;
      state.codes.set(code, { user: state.user, redirect: url.searchParams.get("redirect_uri") });
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
      state.tokenCalls++;
      const p = JSON.parse(body || "{}");
      const c = state.codes.get(p.code);
      if (p.client_id !== clientId || p.client_secret !== clientSecret || !c || c.redirect !== p.redirect_uri) return send(200, { error: "bad_verification_code" });
      state.codes.delete(p.code); // single use
      const token = `tok-${++seq}`;
      state.tokens.set(token, c.user);
      return send(200, { access_token: token, token_type: "bearer", scope: "" });
    }
    if (req.method === "GET" && url.pathname === "/user") {
      const user = state.tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
      if (!req.headers["user-agent"]) return send(403, { message: "User-Agent required" });
      return user ? send(200, user) : send(401, { message: "Bad credentials" });
    }
    if (req.method === "DELETE" && url.pathname === `/applications/${clientId}/token`) {
      if (req.headers.authorization !== `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`) return send(401, {});
      const { access_token } = JSON.parse(body || "{}");
      if (state.tokens.delete(access_token)) state.revoked++;
      return send(204);
    }
    send(404, { message: "Not Found" });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ state, close: () => server.close() })));
}
