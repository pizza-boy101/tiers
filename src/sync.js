// Sync through a private GitHub Gist. Sign-in uses GitHub's device flow:
// the app shows a short code, you approve it on github.com, and the app gets
// a token limited to the `gist` scope.

const GIST_FILE = "tiers-data.json";
const GIST_DESCRIPTION = "Tiers app sync data";

export class GitHubSync {
  constructor({ store, getClientId, loadAuth, saveAuth, onStatus, openUrl, fetch,
    githubUrl = "https://github.com", apiUrl = "https://api.github.com" }) {
    this.store = store;
    this.fetch = fetch;
    this.githubUrl = githubUrl;
    this.apiUrl = apiUrl;
    this.getClientId = getClientId;
    this.loadAuth = loadAuth;
    this.saveAuth = saveAuth;
    this.onStatus = onStatus;
    this.openUrl = openUrl;
    this.auth = null; // { token, login, gistId }
    this.state = { syncing: false, lastSyncAt: null, error: null };
    this.deviceLogin = null; // pending device-flow sign-in
    this.pending = null;
    this.timer = null;
  }

  async init() {
    this.auth = await this.loadAuth();
    this.emit();
    if (this.auth) this.syncSoon(0);
    this.timer = setInterval(() => this.auth && this.syncSoon(0), 2 * 60_000);
  }

  status() {
    return {
      available: Boolean(this.getClientId()),
      signedIn: Boolean(this.auth),
      login: this.auth?.login || null,
      pendingCode: this.deviceLogin ? { userCode: this.deviceLogin.userCode, url: this.deviceLogin.url } : null,
      ...this.state,
    };
  }

  emit() {
    this.onStatus(this.status());
  }

  // ---------- sign-in ----------

  async startLogin() {
    const clientId = this.getClientId();
    if (!clientId) throw new Error("No GitHub client ID is set up yet.");
    this.cancelLogin();
    const res = await this.fetch(`${this.githubUrl}/login/device/code`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, scope: "gist" }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.device_code) {
      throw new Error(data.error_description || "GitHub didn't accept the sign-in request. Check the client ID and that Device Flow is enabled.");
    }
    const login = {
      clientId,
      deviceCode: data.device_code,
      userCode: data.user_code,
      url: data.verification_uri,
      interval: (data.interval || 5) * 1000,
      expiresAt: Date.now() + (data.expires_in || 900) * 1000,
      cancelled: false,
    };
    this.deviceLogin = login;
    this.state.error = null;
    this.emit();
    this.openUrl(login.url);
    this.pollLogin(login);
    return { userCode: login.userCode, url: login.url };
  }

  cancelLogin() {
    if (this.deviceLogin) this.deviceLogin.cancelled = true;
    this.deviceLogin = null;
    this.emit();
  }

  async pollLogin(login) {
    while (!login.cancelled && Date.now() < login.expiresAt) {
      await new Promise((r) => setTimeout(r, login.interval));
      if (login.cancelled) return;
      let data;
      try {
        const res = await this.fetch(`${this.githubUrl}/login/oauth/access_token`, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: login.clientId,
            device_code: login.deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        });
        data = await res.json();
      } catch {
        continue; // network blip, keep polling
      }
      if (data.access_token) return this.finishLogin(login, data.access_token);
      if (data.error === "slow_down") login.interval += 5000;
      else if (data.error !== "authorization_pending") return this.failLogin(login, data.error_description || data.error);
    }
    if (!login.cancelled) this.failLogin(login, "The sign-in code expired. Try again.");
  }

  failLogin(login, message) {
    if (this.deviceLogin !== login) return;
    this.deviceLogin = null;
    this.state.error = message;
    this.emit();
  }

  async finishLogin(login, token) {
    if (this.deviceLogin !== login) return;
    try {
      const user = await this.api(token, "GET", "/user");
      const gistId = await this.findGist(token);
      this.auth = { token, login: user.login, gistId };
      await this.saveAuth(this.auth);
      this.deviceLogin = null;
      this.emit();
      await this.sync();
    } catch (err) {
      this.failLogin(login, err.message);
    }
  }

  async signOut() {
    this.cancelLogin();
    this.auth = null;
    this.state = { syncing: false, lastSyncAt: null, error: null };
    await this.saveAuth(null);
    this.emit();
  }

  // ---------- GitHub API ----------

  async api(token, method, route, body) {
    const res = await this.fetch(`${this.apiUrl}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        "User-Agent": "Tiers-app",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      const err = new Error("GitHub sign-in expired. Sign in again.");
      err.signedOut = true;
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.message || `GitHub request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async findGist(token) {
    for (let page = 1; page <= 10; page++) {
      const gists = await this.api(token, "GET", `/gists?per_page=100&page=${page}`);
      const found = gists.find((g) => g.description === GIST_DESCRIPTION && g.files?.[GIST_FILE]);
      if (found) return found.id;
      if (gists.length < 100) break;
    }
    return null;
  }

  async readGist() {
    const gist = await this.api(this.auth.token, "GET", `/gists/${this.auth.gistId}`);
    const file = gist.files?.[GIST_FILE];
    if (!file) return null;
    if (!file.truncated) return JSON.parse(file.content);
    const raw = await this.fetch(file.raw_url, { headers: { Authorization: `Bearer ${this.auth.token}` } });
    return JSON.parse(await raw.text());
  }

  async writeGist(db) {
    const files = { [GIST_FILE]: { content: JSON.stringify(db) } };
    if (this.auth.gistId) {
      await this.api(this.auth.token, "PATCH", `/gists/${this.auth.gistId}`, { files });
    } else {
      const gist = await this.api(this.auth.token, "POST", "/gists", { description: GIST_DESCRIPTION, public: false, files });
      this.auth.gistId = gist.id;
      await this.saveAuth(this.auth);
    }
  }

  // ---------- syncing ----------

  syncSoon(delay = 3000) {
    if (!this.auth) return;
    clearTimeout(this.pending);
    this.pending = setTimeout(() => this.sync(), delay);
  }

  async sync() {
    if (!this.auth) return;
    if (this.state.syncing) {
      this.again = true;
      return;
    }
    this.state.syncing = true;
    this.emit();
    try {
      let remote = null;
      if (this.auth.gistId) {
        try {
          remote = await this.readGist();
        } catch (err) {
          if (err.status !== 404) throw err;
          this.auth.gistId = null; // gist was deleted on GitHub; make a new one
        }
      }
      const merged = remote ? await this.store.mergeRemote(remote) : this.store.db;
      if (!remote || JSON.stringify(remote) !== JSON.stringify(merged)) await this.writeGist(merged);
      this.state.lastSyncAt = Date.now();
      this.state.error = null;
    } catch (err) {
      console.error("Sync failed:", err);
      this.state.error = err.message || "Sync failed";
      if (err.signedOut) {
        this.auth = null;
        await this.saveAuth(null);
      }
    } finally {
      this.state.syncing = false;
      this.emit();
      if (this.again) {
        this.again = false;
        this.syncSoon(0);
      }
    }
  }
}
