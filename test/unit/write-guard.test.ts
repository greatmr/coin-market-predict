import { describe, expect, it } from "vitest";
import { assertTrustedWrite } from "../../src/dashboard/write-guard.js";

const req = (headers: Record<string, string> = {}, json = true) =>
  ({ is: (t: string) => (json && t === "application/json" ? "application/json" : false), headers: { host: "127.0.0.1:3000", ...headers } }) as never;
const local = { HOST: "127.0.0.1" };

describe("dashboard write guard", () => {
  it("accepts same-origin JSON on loopback, with or without an Origin header", () => {
    expect(() => assertTrustedWrite(req(), local)).not.toThrow();
    expect(() => assertTrustedWrite(req({ origin: "http://127.0.0.1:3000" }), local)).not.toThrow();
  });

  it("refuses cross-site, malformed and null origins", () => {
    for (const origin of ["https://evil.example", "http://127.0.0.1:9999", "null", "not a url"]) {
      expect(() => assertTrustedWrite(req({ origin }), local)).toThrow(/Cross-origin/);
    }
  });

  it("refuses non-JSON bodies (form posts are CORS-simple)", () => {
    expect(() => assertTrustedWrite(req({}, false), local)).toThrow(/JSON/);
  });

  it("refuses writes on a network-reachable dashboard unless basic auth is set", () => {
    expect(() => assertTrustedWrite(req(), { HOST: "0.0.0.0" })).toThrow(/DASHBOARD_BASIC_AUTH/);
    expect(() => assertTrustedWrite(req(), { HOST: "0.0.0.0", DASHBOARD_BASIC_AUTH: "u:p" })).not.toThrow();
  });
});
