import assert from "node:assert/strict";
import test from "node:test";
import { accountCapabilities, assertSameUser, beijingDay, normalizeApiBase, protocolBase, readAccount, saveAccount, withSiteIdentity } from "../lib/accounts.mjs";

const account = (extra = {}) => ({
  schema: 2, provider: "anyrouter", mode: "password", site: "top",
  siteURL: "https://anyrouter.top", apiBase: "", key: "inference-secret",
  userId: "123", username: "alice", password: "one-time-password",
  session: "session=site-secret", accessToken: "", headers: "", checkinEnabled: false,
  ...extra
});

test("passwords are persisted only with explicit password-mode check-in consent", () => {
  for (const mode of ["password", "github", "linuxdo", "access-token"]) {
    const auth = saveAccount(account({ mode }));
    assert.doesNotMatch(JSON.stringify(auth), /one-time-password/);
    assert.equal(readAccount(auth).checkinEnabled, false);
    assert.equal(readAccount(auth).key, "inference-secret");
  }
  const auth = saveAccount(account({ checkinEnabled: true }));
  assert.equal(readAccount(auth).password, "one-time-password");
  assert.equal(accountCapabilities(readAccount(auth)).checkin, true);
  assert.equal(auth.uid, "anyrouter:123");
  assert.equal(auth.expires, 0);
});

test("API-key-only credentials cannot acquire account capabilities from stray fields", () => {
  const auth = saveAccount(account({ mode: "api-key", accessToken: "site-token", checkinEnabled: true }));
  assert.doesNotMatch(JSON.stringify(auth), /one-time-password|site-secret|site-token/);
  assert.deepEqual(accountCapabilities(readAccount(auth)), { inference: true, usage: false, checkin: false });
});

test("legacy API and mixed credentials migrate without opting into check-in", () => {
  const pure = readAccount({ type: "api", key: "key", metadata: { site: "top" } });
  assert.equal(pure.siteURL, "https://anyrouter.top");
  assert.equal(pure.apiBase, "");
  assert.deepEqual(accountCapabilities(pure), { inference: true, usage: false, checkin: false });
  const mixed = readAccount({ type: "api", key: "key", metadata: {
    username: "alice", password: "legacy-password", cookie: "session=legacy", userId: 123,
    endpoint: "https://a-ocnfniawgw.cn-shanghai.fcapp.run", siteURL: "https://anyrouter.top", site: "top"
  } });
  assert.equal(mixed.apiBase, "https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1");
  assert.equal(mixed.siteURL, "https://anyrouter.top");
  assert.equal(mixed.checkinEnabled, false);
  assert.equal(accountCapabilities(mixed).usage, true);
  assert.doesNotMatch(saveAccount(mixed).refresh, /legacy-password/);
  const selected = readAccount({ type: "api", key: "key", metadata: { site: "top", apiEndpoint: "fcapp" } });
  assert.equal(selected.apiBase, "https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1");
});

test("corrupt versioned credentials and unsafe endpoint formats fail visibly", () => {
  assert.throws(() => readAccount({ type: "oauth", refresh: "broken", access: "key" }), /无法识别/);
  for (const url of ["sk-not-a-url", "file:///tmp/key", "https://user:secret@site.example", "https://site.example?key=secret"]) {
    assert.throws(() => readAccount({ type: "api", key: "key", metadata: { endpoint: url } }));
  }
  assert.throws(() => readAccount({ type: "api", key: "key", metadata: { endpoint: "https://relay.example/v1" } }), /API 端点/);
  assert.throws(() => readAccount({ type: "api", key: "key", metadata: { apiEndpoint: "other" } }), /API 端点/);
  assert.throws(() => readAccount({ type: "api", key: "key", metadata: { siteURL: "https://relay.example" } }), /只支持 anyrouter\.top/);
  assert.throws(() => readAccount({ type: "api", key: "key", metadata: { site: "untrusted" } }), /只支持/);
  assert.throws(() => readAccount({ type: "api", key: "key", metadata: { site: "dns" } }), /只支持/);
  assert.throws(() => saveAccount(account({ key: "" })), /推理 key/);
  assert.throws(() => saveAccount(account({ userId: "" })), /账号 ID/);
});

test("protocol base paths do not accumulate versions", () => {
  assert.equal(protocolBase("https://anyrouter.top/"), "https://anyrouter.top/v1");
  assert.equal(protocolBase("https://anyrouter.top/v1", "gemini"), "https://anyrouter.top/v1beta");
  assert.equal(protocolBase("https://anyrouter.top/v1beta", "anthropic"), "https://anyrouter.top/v1");
  assert.equal(normalizeApiBase("https://anyrouter.top"), "https://anyrouter.top/v1");
  assert.equal(normalizeApiBase("https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1beta"), "https://a-ocnfniawgw.cn-shanghai.fcapp.run/v1");
  assert.throws(() => normalizeApiBase("https://relay.example/v1"), /API 端点/);
});

test("UID validation prevents cross-account session replacement", () => {
  assert.equal(assertSameUser(account(), { id: 123 }), "123");
  assert.throws(() => assertSameUser(account(), { id: 124 }), /不一致/);
  assert.throws(() => assertSameUser(account(), {}), /缺失/);
  assert.equal(saveAccount(account()).uid, "anyrouter:123");
});

test("account names prefer real email, then site username or UID, never the display remark", () => {
  for (const mode of ["password", "github", "linuxdo", "access-token", "legacy-session"]) {
    const state = account({ mode, label: "shared-label", email: " alice@example.test " });
    assert.equal(saveAccount(state).accountId, "alice@example.test");
    assert.equal(saveAccount({ ...state, email: "" }).accountId, "alice");
    assert.equal(saveAccount({ ...state, email: "not-an-email" }).accountId, "alice");
    assert.equal(saveAccount({ ...state, email: "", username: "" }).accountId, "AnyRouter 123");
  }
});

test("shared remarks do not create equal account names or collapse distinct UIDs", () => {
  const alice = saveAccount(account({ label: "shared-label", email: "alice@example.test" }));
  const bob = saveAccount(account({ label: "shared-label", email: "bob@example.test", userId: "456", username: "bob" }));
  assert.equal(alice.accountId, "alice@example.test");
  assert.equal(bob.accountId, "bob@example.test");
  assert.notEqual(alice.uid, bob.uid);
  assert.equal(readAccount(alice).label, "shared-label");
  assert.equal(readAccount(bob).label, "shared-label");
  const another = saveAccount(account({ email: "alice@example.test", userId: "789" }));
  assert.notEqual(another.uid, alice.uid, "a shared email cannot override distinct site identities");
});

test("session refresh preserves both corrected and legacy native names until an explicit host migration", () => {
  for (const accountId of ["alice@example.test", "old-remark"]) {
    const original = { ...saveAccount(account({ label: "old-remark", email: "alice@example.test" })), accountId };
    const before = JSON.stringify(original);
    const refreshed = saveAccount({ ...readAccount(original), email: "new@example.test", username: "new-site-name", session: "session=new" }, original);
    assert.equal(refreshed.accountId, accountId, "do not orphan native aliases or account-name routing settings");
    assert.equal(refreshed.uid, original.uid);
    assert.equal(readAccount(refreshed).label, "old-remark");
    assert.equal(readAccount(refreshed).session, "session=new");
    assert.equal(JSON.stringify(original), before);
  }
});

test("legacy API metadata remarks are not emails and refresh preserves their native name", () => {
  const original = { type: "api", key: "model-secret", metadata: {
    email: "old-remark", username: "alice", password: "site-secret", userId: "123", session: "session=original", checkinEnabled: true
  } };
  const before = JSON.stringify(original);
  const state = readAccount(original);
  assert.equal(state.email, "");
  assert.equal(state.label, "old-remark");
  const refreshed = saveAccount({ ...state, session: "session=new" }, original);
  assert.equal(refreshed.accountId, "old-remark", "preserve the host's metadata.email-derived name without treating it as a site email");
  assert.equal(readAccount(refreshed).email, "");
  assert.equal(readAccount(refreshed).label, "old-remark");
  assert.equal(refreshed.uid, "anyrouter:123");
  assert.equal(JSON.stringify(original), before);
});

test("site identity enrichment verifies UID and never promotes a remark into an email", () => {
  const source = account({ label: "initial-alias", email: "" });
  const enriched = withSiteIdentity(source, { id: 123, username: " site-alice ", email: " alice@example.test " });
  assert.equal(enriched.email, "alice@example.test");
  assert.equal(enriched.username, "site-alice");
  assert.equal(enriched.label, "initial-alias");
  assert.equal(source.email, "");
  assert.equal(withSiteIdentity(source, { id: 123 }).email, "");
  assert.equal(withSiteIdentity(enriched, { id: 123 }).email, "alice@example.test");
  assert.equal(withSiteIdentity(enriched, { id: 123, email: "" }).email, "");
  assert.equal(withSiteIdentity(enriched, { id: 123, email: "not-an-email" }).email, "");
  assert.throws(() => withSiteIdentity(source, { id: 456, email: "other@example.test" }), /不一致/);
});

test("Beijing-day boundaries are independent of the runtime timezone", () => {
  assert.equal(beijingDay(Date.parse("2026-10-28T15:59:59Z")), "2026-10-28");
  assert.equal(beijingDay(Date.parse("2026-10-28T16:00:00Z")), "2026-10-29");
});
