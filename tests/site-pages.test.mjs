// The guide pages next to the home page, in English (site/<dir>/) and in Russian
// (site/ru/<dir>/): claude-code-codex, wake-up, compare. They are plain HTML without a
// generator, so this test keeps their head, structured data and product vocabulary
// honest by hand-written rules:
// - both languages point at each other with hreflang links and a language switch;
// - the FAQPage JSON-LD says exactly what the visible FAQ says;
// - person-facing text follows contracts/vocabulary.json (same reader as
//   tests/vocabulary.test.mjs), except the names of other projects and terms
//   quoted from their documentation, listed below with a reason;
// - the Russian page has the same shape as the English one (sections, steps, FAQ);
// - npm scopes in visible text are wrapped in email_off comments (see site/README.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const PAGES = ["claude-code-codex", "wake-up", "compare"];
const SITE = "https://murmurconnect.com/";
const vocabulary = JSON.parse(read("contracts/vocabulary.json"));
const compile = (list) => list.map((rule) => ({ ...rule, re: new RegExp(rule.pattern, "giu") }));

const LANGS = [
  {
    code: "en", locale: "en_US", other: "ru",
    file: (dir) => `site/${dir}/index.html`, url: (dir) => `${SITE}${dir}/`, assets: "../", home: "site/index.html",
    updated: /Updated 29 September 2026 · Murmur 2\.12\.0/, published: "2026-09-25", modified: "2026-09-29",
    switcher: (dir) => `<a class="language" href="../ru/${dir}/" hreflang="ru"`,
    rules: compile(vocabulary.forbidden.en),
  },
  {
    code: "ru", locale: "ru_RU", other: "en",
    file: (dir) => `site/ru/${dir}/index.html`, url: (dir) => `${SITE}ru/${dir}/`, assets: "../../", home: "site/ru/index.html",
    updated: /Обновлено 29 сентября 2026 · Murmur 2\.12\.0/, published: "2026-09-29", modified: "2026-09-29",
    switcher: (dir) => `<a class="language" href="../../${dir}/" hreflang="en"`,
    rules: compile(vocabulary.forbidden.ru),
  },
];
const byCode = Object.fromEntries(LANGS.map((l) => [l.code, l]));

// Other projects' names and terms quoted from their own documentation keep their words.
const QUOTED = [
  { text: "xhluca/agent-talk", reason: "repository name of another project" },
  { text: "agent-talk", reason: "name of another project (xhluca/agent-talk)" },
  { text: "Agent Cards", reason: "A2A protocol term, quoted from the a2aproject/A2A README" },
  { text: "Agent2Agent", reason: "the full name of the A2A protocol" },
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const text = (fragment) => decode(fragment.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
const attr = (html, re) => (re.exec(html) || [])[1];
const body = (html) => html.slice(html.search(/<body[\s>]/));
const count = (html, re) => (html.match(re) || []).length;

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

for (const lang of LANGS) for (const dir of PAGES) {
  const file = lang.file(dir);
  const html = read(file);
  const url = lang.url(dir);
  const a = esc(lang.assets);

  test(`${file}: head, links and the visible update line`, () => {
    assert.match(html, new RegExp(`^<!doctype html>\\n<html lang="${lang.code}"`));
    assert.match(attr(html, /<title>([^<]*)<\/title>/), / — Murmur Connect$/);
    assert.ok((attr(html, /<meta name="description" content="([^"]*)">/) || "").length >= 80);
    assert.equal(attr(html, /<meta name="robots" content="([^"]*)">/), "index, follow, max-snippet:-1, max-image-preview:large");
    assert.equal(attr(html, /<link rel="canonical" href="([^"]*)">/), url);
    assert.equal(attr(html, /<meta property="og:url" content="([^"]*)">/), url);
    assert.equal(attr(html, /<meta property="og:locale" content="([^"]*)">/), lang.locale);
    assert.equal(attr(html, /<meta property="og:locale:alternate" content="([^"]*)">/), byCode[lang.other].locale);
    for (const [hreflang, target] of [["en", byCode.en.url(dir)], ["ru", byCode.ru.url(dir)], ["x-default", byCode.en.url(dir)]]) {
      assert.ok(html.includes(`<link rel="alternate" hreflang="${hreflang}" href="${target}">`), `${file} declares hreflang ${hreflang}`);
    }
    for (const re of [/<meta property="og:image" content="([^"]*)">/, /<meta name="twitter:image" content="([^"]*)">/]) {
      assert.equal(attr(html, re), `${SITE}og.png?v=20260925-1`);
    }
    assert.match(html, new RegExp(`<link rel="icon" href="${a}favicon\\.ico\\?v=[^"]+" sizes="48x48">`));
    assert.match(html, new RegExp(`<link rel="icon" href="${a}favicon\\.svg\\?v=[^"]+" type="image/svg\\+xml">`));
    assert.match(html, new RegExp(`<link rel="stylesheet" href="${a}pages\\.css\\?v=[^"]+">`));
    assert.match(body(html), lang.updated);
    assert.deepEqual(html.match(/<script[^>]+\ssrc=/g) || [], [], "no external scripts");
    assert.deepEqual(html.match(/<img\b/g) || [], [], "no images or placeholder screenshots");
    for (const href of ["../", "../#install", "https://github.com/alexfrmn/murmur", ...PAGES.filter((p) => p !== dir).map((p) => `../${p}/`)]) {
      assert.ok(html.includes(`href="${href}"`), `${file} links ${href}`);
    }
    assert.ok(html.includes(lang.switcher(dir)), `${file} switches to the ${lang.other} version`);
    assert.match(html, /<nav class="topnav"/, "the guides are reachable from the top of the page");
    assert.ok(html.includes(`href="../${dir}/" aria-current="page"`), `${file} marks itself in the top navigation`);
    assert.match(html, /<nav class="sections" id="sections"/, "the sections menu is present");
    assert.match(html, /<a class="totop" id="totop"/, "the back-to-top link is present");
  });

  test(`${file}: TechArticle and FAQPage match the page`, () => {
    const [article, faq] = jsonLd(html);
    assert.equal(article["@type"], "TechArticle");
    assert.equal(article.url, url);
    assert.equal(article.headline, text(attr(html, /<h1>([\s\S]*?)<\/h1>/)));
    assert.equal(article.description, decode(attr(html, /<meta name="description" content="([^"]*)">/)));
    assert.equal(article.inLanguage, lang.code);
    assert.equal(article.datePublished, lang.published);
    assert.equal(article.dateModified, lang.modified);
    assert.deepEqual(article.author, { "@type": "Person", "@id": `${SITE}#author`, name: "Alexander Vasiliev", url: "https://github.com/alexfrmn" });
    assert.equal(article.about["@id"], `${SITE}#software`);
    assert.equal(article.isPartOf["@id"], `${SITE}#website`);

    assert.equal(faq["@type"], "FAQPage");
    assert.equal(faq.url, url);
    assert.equal(faq.inLanguage, lang.code);
    const visible = visibleFaq(html);
    assert.ok(visible.length >= 5 && visible.length <= 6, `${visible.length} visible questions`);
    const expected = visible.map(({ q, a }) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } }));
    assert.deepEqual(faq.mainEntity, expected, "the FAQPage JSON-LD must repeat the visible FAQ word for word");
  });

  test(`${file}: person-facing text uses the product vocabulary`, () => {
    const violations = [];
    for (const { key, value } of personFacing(html)) {
      const clean = QUOTED.reduce((s, { text: t }) => s.split(t).join(" "), value.replace(/`[^`]*`/g, " "));
      for (const rule of lang.rules) {
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

for (const dir of PAGES) {
  test(`site/ru/${dir}/: the Russian page has the shape of the English one`, () => {
    const en = read(byCode.en.file(dir));
    const ru = read(byCode.ru.file(dir));
    for (const [what, re] of [["sections", /<section\b/g], ["h2", /<h2>/g], ["h3", /<h3>/g], ["steps", /<li><p>/g], ["code blocks", /<pre>/g], ["tables", /<table>/g], ["table rows", /<tr>/g]]) {
      assert.equal(count(ru, re), count(en, re), `${what}: ru ${count(ru, re)} vs en ${count(en, re)}`);
    }
    assert.equal(visibleFaq(ru).length, visibleFaq(en).length, "same number of questions");
    const [enArticle] = jsonLd(en);
    const [ruArticle] = jsonLd(ru);
    assert.equal(ruArticle.proficiencyLevel, enArticle.proficiencyLevel);
    // Every outbound link of the English page is also on the Russian page.
    const external = (html) => new Set([...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]));
    assert.deepEqual([...external(en)].filter((u) => !external(ru).has(u)), [], "external links missing in Russian");
  });
}

test("the sitemap lists both language versions of every guide and each home page links its own", () => {
  const sitemap = read("site/sitemap.xml");
  for (const lang of LANGS) for (const dir of PAGES) {
    const block = new RegExp(`<url>\\s*<loc>${esc(lang.url(dir))}</loc>\\s*<lastmod>2026-09-29</lastmod>([\\s\\S]*?)</url>`).exec(sitemap);
    assert.ok(block, `${lang.url(dir)} is in the sitemap with today's lastmod`);
    assert.ok(block[1].includes(`hreflang="en" href="${byCode.en.url(dir)}"`), `${lang.url(dir)} names its English alternate`);
    assert.ok(block[1].includes(`hreflang="ru" href="${byCode.ru.url(dir)}"`), `${lang.url(dir)} names its Russian alternate`);
    assert.ok(block[1].includes(`hreflang="x-default" href="${byCode.en.url(dir)}"`), `${lang.url(dir)} names the default`);
  }
  for (const lang of LANGS) {
    const home = read(lang.home);
    for (const dir of PAGES) assert.ok(home.includes(`href="${dir}/"`), `${lang.home} links ${dir}/`);
    assert.doesNotMatch(home, /href="\.\.\/(?:claude-code-codex|wake-up|compare)\//, `${lang.home} links the guides of its own language`);
  }
});
