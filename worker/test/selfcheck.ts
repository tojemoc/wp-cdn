import assert from "node:assert/strict";
import { parseRangeHeader, buildContentRangeHeader } from "../src/range";
import { parseUrl, isValidDomain, matchesDomainList } from "../src/validation";
import { etagMatches } from "../src/cache";
import { mediaSafetyHeaders, parseFileSize } from "../src/utils";

// --- range parsing ----------------------------------------------------------
assert.deepEqual(parseRangeHeader("bytes=0-99", 1000), { start: 0, end: 99, length: 100, isPartial: true });
assert.deepEqual(parseRangeHeader("BYTES=0-99", 1000)?.length, 100, "unit is case-insensitive");
assert.deepEqual(parseRangeHeader("bytes=-500", 1000)?.start, 500, "suffix range");
assert.equal(parseRangeHeader("bytes=0-", 1000)?.isPartial, false, "full range is not partial");
assert.equal(parseRangeHeader("bytes=10x-20", 1000), null, "numeric prefix rejected");
assert.equal(parseRangeHeader("bytes=-", 1000), null);
assert.equal(parseRangeHeader("bytes=2000-3000", 1000), null, "out of range");
assert.equal(parseRangeHeader("bytes=0-99,200-299", 1000), null, "multi-range unsupported");
assert.equal(buildContentRangeHeader(0, 99, 1000), "bytes 0-99/1000");

// --- URL parsing ------------------------------------------------------------
const p = parseUrl(new URL("https://cdn.example.com/example.com/dir/a%2Fb.jpg"));
assert.equal(p.domain, "example.com");
assert.equal(p.cacheKey, "example.com/dir/a%2Fb.jpg", "encoded slash stays in its segment");
assert.equal(p.sourceUrl, "https://example.com/dir/a%2Fb.jpg");
assert.equal(parseUrl(new URL("https://cdn.example.com/example.com/dir/a/b.jpg")).cacheKey, "example.com/dir/a/b.jpg");
// URL parsing already resolves literal ".."; encoded %2E%2E is popped by us.
assert.throws(() => parseUrl(new URL("https://cdn.example.com/example.com/../../etc/passwd")), /Invalid domain/);
assert.throws(() => parseUrl(new URL("https://cdn.example.com/example.com/a/%2E%2E")), /traversal/);
assert.throws(() => parseUrl(new URL("https://cdn.example.com/")), /Invalid URL format/);
assert.throws(() => parseUrl(new URL("https://cdn.example.com/169.254.169.254/x.jpg")), /Invalid domain/);
const q = parseUrl(new URL("https://cdn.example.com/www.example.com/i.png?force=1&view=true"));
assert.equal(q.forceReprocess, true);
assert.equal(q.viewImage, true);
assert.equal(q.cacheKey, "www.example.com/i.png", "query does not enter the cache key");

// --- domain rules -----------------------------------------------------------
assert.equal(isValidDomain("example.com"), true);
assert.equal(isValidDomain("localhost"), false);
assert.equal(isValidDomain("10.0.0.1"), false);
assert.equal(isValidDomain("metadata.google.internal"), false);
assert.equal(matchesDomainList("a.example.com", "*.example.com"), true);
assert.equal(matchesDomainList("example.com", "*.example.com"), false, "wildcard does not match bare domain");
assert.equal(matchesDomainList("example.com", "example.com, www.example.com"), true);

// --- etag / conditional -----------------------------------------------------
assert.equal(etagMatches('"abc"', '"abc"'), true);
assert.equal(etagMatches('W/"abc"', '"abc"'), true, "weak tag matches");
assert.equal(etagMatches('"x", "abc", "y"', '"abc"'), true, "tag list");
assert.equal(etagMatches("*", '"abc"'), true);
assert.equal(etagMatches('"other"', '"abc"'), false);
assert.equal(etagMatches(null, '"abc"'), false);

// --- misc -------------------------------------------------------------------
assert.ok(mediaSafetyHeaders("image/svg+xml")["Content-Security-Policy"], "svg gets a sandbox policy");
assert.equal(mediaSafetyHeaders("image/png")["Content-Security-Policy"], undefined);
assert.equal(parseFileSize("500MB"), 500 * 1024 * 1024);

console.log("selfcheck: all assertions passed");
