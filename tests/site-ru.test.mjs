// The Russian page https://murmurconnect.com/ru/ is generated from site/index.html by
// scripts/build-site-ru.mjs and committed, because the deploy copies site/ as is. These
// tests keep the two files from drifting and check that Russian needs no JavaScript.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { renderPage, readDictionary } from "../scripts/build-site-ru.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const en = read("site/index.html");
const ru = read("site/ru/index.html");
const I18N = readDictionary(en);

const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const cyrillic = /[А-Яа-яЁё]/;
const body = (html) => html.slice(html.search(/<body[\s>]/)).replace(/<script[\s\S]*?<\/script>/g, "");
const i18nElements = (html) => [...body(html).matchAll(/<([a-z][a-z0-9]*)\b[^>]*\sdata-i18n="([^"]+)"[^>]*>([^<]*)<\/\1>/g)]
  .map(([, , key, text]) => ({ key, text: unescape(text) }));
const attr = (html, re) => (re.exec(html) || [])[1];

test("the committed Russian page is exactly what the generator renders", () => {
  assert.equal(ru, renderPage(en, "ru"),
    "site/ru/index.html is stale or edited by hand: change site/index.html, then run node scripts/build-site-ru.mjs");
});

test("the static English page agrees with I18N.en", () => {
  assert.equal(renderPage(en, "en"), en,
    "site/index.html and I18N.en say different things: change both, the static text and the dictionary");
});

test("the Russian page is Russian without JavaScript", () => {
  assert.match(ru, /^<!doctype html>\n<html lang="ru"[ >]/);
  const title = unescape(attr(ru, /<title>([^<]*)<\/title>/));
  assert.equal(title, I18N.ru.title);
  assert.match(title, cyrillic);
  assert.equal(unescape(attr(ru, /<meta name="description" content="([^"]*)">/)), I18N.ru.description);
  assert.equal(attr(ru, /<link rel="canonical" href="([^"]*)">/), "https://murmurconnect.com/ru/");
  assert.equal(attr(ru, /<meta property="og:url" content="([^"]*)">/), "https://murmurconnect.com/ru/");
  assert.equal(attr(ru, /<meta property="og:locale" content="([^"]*)">/), "ru_RU");
  assert.equal(unescape(attr(ru, /<meta property="og:title" content="([^"]*)">/)), I18N.ru.title);
  assert.equal(unescape(attr(ru, /<meta name="twitter:description" content="([^"]*)">/)), I18N.ru.description);

  const elements = i18nElements(ru);
  assert.ok(elements.length > 60, `only ${elements.length} data-i18n elements found — the reader is broken`);
  const leftovers = elements.filter(({ key, text }) =>
    text !== I18N.ru[key] || (I18N.en[key] !== I18N.ru[key] && !cyrillic.test(text)));
  assert.deepEqual(leftovers, [], "data-i18n elements on /ru/ that are not in Russian");
  assert.equal(i18nElements(en).length, elements.length, "both pages must carry the same data-i18n elements");

  for (const m of ru.matchAll(/<[a-z][^>]*\sdata-i18n-(aria|title|alt)="([^"]+)"[^>]*>/g)) {
    const name = m[1] === "aria" ? "aria-label" : m[1];
    assert.equal(unescape(attr(m[0], new RegExp(`\\s${name}="([^"]*)"`))), I18N.ru[m[2]], `${name} of ${m[2]}`);
  }
  assert.match(unescape(attr(ru, /<pre id="prompt">([\s\S]*?)<\/pre>/)), /^Поставь мне murmur/);
});

test("the Russian structured data is in Russian", () => {
  const blocks = [...ru.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const [graph, faq] = blocks;
  assert.equal(graph["@graph"][0].description, I18N.ru.ldSiteDescription);
  assert.equal(graph["@graph"][1].description, I18N.ru.ldAppDescription);
  assert.deepEqual(graph["@graph"][1].featureList, [...I18N.ru.ldFeatures]);
  assert.equal(faq.inLanguage, "ru");
  assert.equal(faq.url, "https://murmurconnect.com/ru/");
  assert.equal(faq.mainEntity.length, 6);
  faq.mainEntity.forEach((q, i) => {
    assert.equal(q.name, I18N.ru[`faq${i + 1}q`]);
    assert.equal(q.acceptedAnswer.text, I18N.ru[`faq${i + 1}a`]);
  });
});

test("each page links the other one", () => {
  for (const html of [en, ru]) {
    assert.equal(attr(html, /<link rel="alternate" hreflang="en" href="([^"]*)">/), "https://murmurconnect.com/");
    assert.equal(attr(html, /<link rel="alternate" hreflang="ru" href="([^"]*)">/), "https://murmurconnect.com/ru/");
    assert.equal(attr(html, /<link rel="alternate" hreflang="x-default" href="([^"]*)">/), "https://murmurconnect.com/");
  }
  assert.match(en, /<a class="language" id="language" href="ru\/" hreflang="ru"[^>]*>RU<\/a>/);
  assert.match(ru, /<a class="language" id="language" href="\.\.\/" hreflang="en"[^>]*>EN<\/a>/);
  const sitemap = read("site/sitemap.xml");
  assert.match(sitemap, /<loc>https:\/\/murmurconnect\.com\/ru\/<\/loc>/);
  assert.doesNotMatch(sitemap, /\?lang=/, "the Russian page has its own address now");
});

test("the Russian page reaches assets one level up", () => {
  const relative = [...ru.matchAll(/\s(?:href|src)="([^"]*)"/g)].map((m) => m[1])
    .filter((url) => url && !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url));
  assert.ok(relative.length >= 5, "the icons and the stylesheet must be linked");
  assert.deepEqual(relative.filter((url) => !url.startsWith("../")), []);
});
