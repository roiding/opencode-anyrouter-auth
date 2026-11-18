// Test-only: the real Bun host may reach only this loopback mock server.
const nativeFetch = globalThis.fetch;
const base = new URL(process.env.MAGPIE_TEST_ORIGIN);
if (base.hostname !== "127.0.0.1" || base.protocol !== "http:") throw new Error("Integration tests require a loopback mock server.");
globalThis.fetch = (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!["anyrouter.top", "a-ocnfniawgw.cn-shanghai.fcapp.run"].includes(url.hostname)) {
    throw new Error("External network request refused by the offline host fixture.");
  }
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  headers.set("x-test-upstream-origin", url.origin);
  const target = base.origin + url.pathname + url.search;
  return nativeFetch(input instanceof Request ? new Request(target, input) : target, { ...init, headers, proxy: undefined });
};
