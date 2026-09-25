// The English guide pages next to the home page: site/claude-code-codex/, site/wake-up/,
// site/compare/. They are plain HTML without a generator, so this test keeps their
// head, structured data and product vocabulary honest by hand-written rules:
// - the FAQPage JSON-LD says exactly what the visible FAQ says;
// - person-facing text follows contracts/vocabulary.json (same reader as
//   tests/vocabulary.test.mjs), except the names of other projects and terms
//   quoted from their documentation, listed below with a reason;
// - npm scopes in visible text are wrapped in email_off comments (see site/README.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const PAGES = ["claude-code-codex", "wake-up", "compare"];
const vocabulary = JSON.parse(read("contracts/vocabulary.json"));
const rules = vocabulary.forbidden.en.map((rule) => ({ ...rule, re: new RegExp(rule.pattern, "giu") }));

// Other projects' names and terms quoted from their own documentation keep their words.
const QUOTED = [
  { text: "xhluca/agent-talk", reason: "repository name of another project" },
  { text: "agent-talk", reason: "name of another project (xhluca/agent-talk)" },
  { text: "Agent Cards", reason: "A2A protocol term, quoted from the a2aproject/A2A README" },
];

const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const text = (fragment) => decode(fragment.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
const attr = (html, re) => (re.exec(html) || [])[1];
const body = (html) => html.slice(html.search(/<body[\s>]/));

function flatten(value, prefix, out) {
  if (typeof value === "string") out.push({ key: prefix, value });
  else if (Array.isArray(value)) value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

function jsonLd(html) {
  return [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
}

// What a person or a search engine reads: <title>, meta texts, labelling attributes,
// JSON-LD strings and the body text outside <script>, <style>, <pre> and <code>.
function personFacing(html) {
  const out = [];
  jsonLd(html).forEach((data, i) => flatten(data, `ld+json[${i}]`, out));
  for (const m of html.matchAll(/<meta\s+(?:name|property)="([^"]+)"\s+content="([^"]*)"/g)) {
    if (/description|title|og:|twitter:/.test(m[1])) out.push({ key: `meta:${m[1]}`, value: decode(m[2]) });
  }
  for (const m of html.matchAll(/\s(aria-label|title|alt|data-label)="([^"]*)"/g)) out.push({ key: `@${m[1]}`, value: decode(m[2]) });
  out.push({ key: "<title>", value: decode(attr(html, /<title>([\s\S]*?)<\/title>/)) });
  const visible = body(html).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<pre[\s\S]*?<\/pre>/g, " ").replace(/<code[\s\S]*?<\/code>/g, " ");
  decode(visible.replace(/<[^>]+>/g, " ")).split(/\n+/).map((s) => s.trim()).filter(Boolean)
    .forEach((line, i) => out.push({ key: `text:${i}`, value: line }));
  return out;
}

function visibleFaq(html) {
  const start = html.indexOf('<div class="qa">');
  assert.notEqual(start, -1, "the visible FAQ lives in <div class=\"qa\">");
  const faq = html.slice(start, html.indexOf("</section>", start));
  return [...faq.matchAll(/<div class="fact">\s*<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>\s*<\/div>/g)]
    .map(([, q, a]) => ({ q: text(q), a: text(a) }));
}

for (const dir of PAGES) {
  const file = `site/${dir}/index.html`;
  const html = read(file);
  const url = `https://murmurconnect.com/${dir}/`;

  test(`${file}: head, links and the visible update line`, () => {
    assert.match(html, /^<!doctype html>\n<html lang="en"/);
    assert.match(attr(html, /<title>([^<]*)<\/title>/), / — Murmur$/);
    assert.ok((attr(html, /<meta name="description" content="([^"]*)">/) || "").length >= 80);
    assert.equal(attr(html, /<meta name="robots" content="([^"]*)">/), "index, follow, max-snippet:-1, max-image-preview:large");
    assert.equal(attr(html, /<link rel="canonical" href="([^"]*)">/), url);
    assert.equal(attr(html, /<meta property="og:url" content="([^"]*)">/), url);
    for (const re of [/<meta property="og:image" content="([^"]*)">/, /<meta name="twitter:image" content="([^"]*)">/]) {
      assert.equal(attr(html, re), "https://murmurconnect.com/og.png?v=20260925-1");
    }
    assert.match(html, /<link rel="icon" href="\.\.\/favicon\.ico\?v=[^"]+" sizes="48x48">/);
    assert.match(html, /<link rel="icon" href="\.\.\/favicon\.svg\?v=[^"]+" type="image\/svg\+xml">/);
    assert.match(html, /<link rel="stylesheet" href="\.\.\/pages\.css\?v=[^"]+">/);
    assert.match(body(html), /Updated 25 September 2026 · Murmur 2\.11\.0/);
    assert.deepEqual(html.match(/<script[^>]+\ssrc=/g) || [], [], "no external scripts");
    assert.deepEqual(html.match(/<img\b/g) || [], [], "no images or placeholder screenshots");
    for (const href of ["../", "../#install", "https://github.com/alexfrmn/murmur", ...PAGES.filter((p) => p !== dir).map((p) => `../${p}/`)]) {
      assert.ok(html.includes(`href="${href}"`), `${file} links ${href}`);
    }
  });

  test(`${file}: TechArticle and FAQPage match the page`, () => {
    const [article, faq] = jsonLd(html);
    assert.equal(article["@type"], "TechArticle");
    assert.equal(article.url, url);
    assert.equal(article.headline, text(attr(html, /<h1>([\s\S]*?)<\/h1>/)));
    assert.equal(article.description, decode(attr(html, /<meta name="description" content="([^"]*)">/)));
    assert.equal(article.datePublished, "2026-09-25");
    assert.equal(article.dateModified, "2026-09-25");
    assert.deepEqual(article.author, { "@type": "Person", "@id": "https://murmurconnect.com/#author", name: "Alexander Vasiliev", url: "https://github.com/alexfrmn" });
    assert.equal(article.about["@id"], "https://murmurconnect.com/#software");
    assert.equal(article.isPartOf["@id"], "https://murmurconnect.com/#website");

    assert.equal(faq["@type"], "FAQPage");
    assert.equal(faq.url, url);
    const visible = visibleFaq(html);
    assert.ok(visible.length >= 5 && visible.length <= 6, `${visible.length} visible questions`);
    const expected = visible.map(({ q, a }) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } }));
    assert.deepEqual(faq.mainEntity, expected, "the FAQPage JSON-LD must repeat the visible FAQ word for word");
  });

  test(`${file}: person-facing text uses the product vocabulary`, () => {
    const violations = [];
    for (const { key, value } of personFacing(html)) {
      const clean = QUOTED.reduce((s, { text: t }) => s.split(t).join(" "), value.replace(/`[^`]*`/g, " "));
      for (const rule of rules) {
        rule.re.lastIndex = 0;
        const hit = rule.re.exec(clean);
        if (hit) violations.push(`${key}: "${hit[0]}" → ${rule.use}   «${value.slice(0, 110)}»`);
      }
    }
    assert.deepEqual(violations, []);
  });

  test(`${file}: npm scopes in visible text are shielded from email obfuscation`, () => {
    const visible = body(html).replace(/<!--email_off-->[\s\S]*?<!--\/email_off-->/g, "");
    assert.deepEqual(visible.match(/@[a-z0-9][\w.-]*\/[\w.-]+@/gi) || [], []);
    assert.deepEqual(visible.match(/@murmurv2\/[\w.-]+/gi) || [], []);
  });
}

test("the sitemap lists the guide pages and the home page links them", () => {
  const sitemap = read("site/sitemap.xml");
  for (const dir of PAGES) {
    assert.match(sitemap, new RegExp(`<loc>https://murmurconnect\\.com/${dir}/</loc>\\s*<lastmod>2026-09-25</lastmod>`));
  }
  const home = read("site/index.html");
  for (const dir of PAGES) assert.ok(home.includes(`href="${dir}/"`), `site/index.html links ${dir}/`);
});
