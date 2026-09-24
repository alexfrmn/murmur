#!/usr/bin/env node
// Renders site/ru/index.html, the Russian page at https://murmurconnect.com/ru/, from
// site/index.html and the I18N.ru dictionary inside it. The Russian text is in the HTML
// itself, so crawlers without JavaScript (Yandex, most AI crawlers) read Russian.
//
//   node scripts/build-site-ru.mjs          write site/ru/index.html
//   node scripts/build-site-ru.mjs --check  exit 1 if the committed file is stale
//
// The deploy copies site/ as is, with no build step, so the output is committed.
// tests/site-ru.test.mjs fails when the committed file differs from what this renders,
// and when the static English page disagrees with I18N.en.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE = path.join(root, "site/index.html");
export const TARGET = path.join(root, "site/ru/index.html");

export const PAGES = {
  en: { url: "https://murmurconnect.com/", locale: "en_US", other: "ru", link: "ru/", assets: "" },
  ru: { url: "https://murmurconnect.com/ru/", locale: "ru_RU", other: "en", link: "../", assets: "../" },
};

export function readDictionary(html) {
  const start = html.indexOf("const I18N = {");
  if (start === -1) throw new Error("site/index.html must keep its I18N dictionary");
  const end = html.indexOf("\n};", start);
  if (end === -1) throw new Error("the I18N dictionary must end with a line '};'");
  const literal = html.slice(start + "const I18N = ".length, end + 2);
  return vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1000 });
}

const escapeText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s) => escapeText(s).replace(/"/g, "&quot;");
const isRelative = (url) => url !== "" && !/^(?:[a-z][a-z0-9+.-]*:|\/|#|\.\.\/)/i.test(url);

// Every substitution must hit exactly the expected number of places: a renamed attribute
// or a moved tag fails the build instead of leaving English behind.
function replaceExactly(html, pattern, replacement, expected, what) {
  let count = 0;
  const out = html.replace(pattern, (...m) => { count += 1; return replacement(...m); });
  if (count !== expected) throw new Error(`${what}: expected ${expected} match(es), found ${count}`);
  return out;
}

function setAttribute(tag, name, value) {
  const re = new RegExp(`(\\s${name}=")[^"]*(")`);
  if (!re.test(tag)) throw new Error(`${tag.slice(0, 80)} has no ${name}="…" to translate`);
  return tag.replace(re, (_, a, b) => `${a}${escapeAttr(value)}${b}`);
}

function word(t, key, lang) {
  if (typeof t[key] !== "string") throw new Error(`I18N.${lang}.${key} is missing`);
  return t[key];
}

function jsonScript(data) {
  // "<" never appears raw inside a <script>, so text cannot close the element early.
  return JSON.stringify(data, null, 2).replace(/</g, "\\u003c");
}

export function renderPage(html, lang) {
  const page = PAGES[lang];
  if (!page) throw new Error(`unknown language ${lang}`);
  const t = readDictionary(html)[lang];
  const other = PAGES[page.other];
  let out = html;

  out = replaceExactly(out, /<html lang="[a-z]+"/g, () => `<html lang="${lang}"`, 1, "<html lang>");
  out = replaceExactly(out, /<title>[^<]*<\/title>/g, () => `<title>${escapeText(word(t, "title", lang))}</title>`, 1, "<title>");
  const meta = (attr, name, value) => {
    const re = new RegExp(`<meta ${attr}="${name}" content="[^"]*">`, "g");
    out = replaceExactly(out, re, () => `<meta ${attr}="${name}" content="${escapeAttr(value)}">`, 1, `meta ${name}`);
  };
  meta("name", "description", word(t, "description", lang));
  meta("property", "og:url", page.url);
  meta("property", "og:title", t.title);
  meta("property", "og:description", t.description);
  meta("property", "og:locale", page.locale);
  meta("property", "og:locale:alternate", other.locale);
  meta("property", "og:image:alt", word(t, "imageAlt", lang));
  meta("name", "twitter:title", t.title);
  meta("name", "twitter:description", t.description);
  meta("name", "twitter:image:alt", t.imageAlt);
  out = replaceExactly(out, /<link rel="canonical" href="[^"]*">/g, () => `<link rel="canonical" href="${page.url}">`, 1, "canonical");

  // Relative addresses (styles, icons, future screenshots) are one level up from /ru/.
  out = out.replace(/(\s(?:href|src)=")([^"]*)"/g, (m, head, url) => (isRelative(url) ? `${head}${page.assets}${url}"` : m));
  out = out.replace(/(\ssrcset=")([^"]*)"/g, (_, head, list) => `${head}${list.split(",").map((part) => {
    const item = part.trim();
    return isRelative(item) ? `${page.assets}${item}` : item;
  }).join(", ")}"`);

  // The language switch is a link to the other page, built here for both pages.
  out = replaceExactly(out, /<a class="language" id="language"[^>]*>[^<]*<\/a>/g, () =>
    `<a class="language" id="language" href="${page.link}" hreflang="${page.other}" aria-label="${escapeAttr(word(t, "languageLabel", lang))}" title="${escapeAttr(t.languageLabel)}">${escapeText(word(t, "languageButton", lang))}</a>`,
  1, "language link");

  // Labelling attributes, then the text of every data-i18n element. These elements are
  // leaves: their text is replaced whole, so they must not contain other tags.
  out = out.replace(/<[a-z][^>]*\sdata-i18n-aria="([^"]+)"[^>]*>/g, (tag, key) => setAttribute(tag, "aria-label", word(t, key, lang)));
  out = out.replace(/<[a-z][^>]*\sdata-i18n-title="([^"]+)"[^>]*>/g, (tag, key) => setAttribute(tag, "title", word(t, key, lang)));
  out = out.replace(/<[a-z][^>]*\sdata-i18n-alt="([^"]+)"[^>]*>/g, (tag, key) => setAttribute(tag, "alt", word(t, key, lang)));
  const body = out.slice(out.search(/<body[\s>]/)).replace(/<script[\s\S]*?<\/script>/g, "");
  const expected = (body.match(/\sdata-i18n="/g) || []).length;
  out = replaceExactly(out, /(<([a-z][a-z0-9]*)\b[^>]*\sdata-i18n="([^"]+)"[^>]*>)([^<]*)(<\/\2>)/g,
    (_, open, _tag, key, _text, close) => `${open}${escapeText(word(t, key, lang))}${close}`,
    expected, "data-i18n elements (one of them holds a nested tag)");

  // The English prompt lives in the static <pre>; other languages carry theirs in I18N.
  if (typeof t.prompt === "string") {
    out = replaceExactly(out, /(<pre id="prompt">)[\s\S]*?(<\/pre>)/g, (_, a, b) => `${a}${escapeText(t.prompt)}${b}`, 1, "prompt");
  }

  // Structured data. The English block is the source; I18N.ru carries its translations.
  out = replaceExactly(out, /(<script type="application\/ld\+json">\n)([\s\S]*?)(\n<\/script>)/g, (_, a, json, b) => {
    if (typeof t.ldAppDescription !== "string") return `${a}${json}${b}`;
    const data = JSON.parse(json);
    const [site, app] = data["@graph"];
    site.description = word(t, "ldSiteDescription", lang);
    app.description = t.ldAppDescription;
    app.softwareRequirements = word(t, "ldRequirements", lang);
    if (!Array.isArray(t.ldFeatures) || t.ldFeatures.length !== app.featureList.length) {
      throw new Error(`I18N.${lang}.ldFeatures must translate all ${app.featureList.length} features`);
    }
    app.featureList = [...t.ldFeatures];
    return `${a}${jsonScript(data)}${b}`;
  }, 1, "JSON-LD graph");

  // The FAQPage block says exactly what the visible FAQ says, in the page's language.
  const questions = (body.match(/\sdata-i18n="faq\d+q"/g) || []).length;
  out = replaceExactly(out, /(<script type="application\/ld\+json" id="faq-ld">\n)([\s\S]*?)(\n<\/script>)/g, (_, a, json, b) => {
    const data = JSON.parse(json);
    data["@id"] = `${page.url}#faq`;
    data.url = page.url;
    data.inLanguage = lang;
    data.mainEntity = Array.from({ length: questions }, (_, i) => ({
      "@type": "Question",
      name: word(t, `faq${i + 1}q`, lang),
      acceptedAnswer: { "@type": "Answer", text: word(t, `faq${i + 1}a`, lang) },
    }));
    return `${a}${jsonScript(data)}${b}`;
  }, 1, "FAQPage JSON-LD");

  return out;
}

export function buildRu() {
  return renderPage(readFileSync(SOURCE, "utf8"), "ru");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = buildRu();
  if (process.argv.includes("--check")) {
    let current = "";
    try { current = readFileSync(TARGET, "utf8"); } catch {}
    if (current !== html) {
      process.stderr.write("site/ru/index.html is stale: run node scripts/build-site-ru.mjs and commit it\n");
      process.exit(1);
    }
    process.stdout.write("site/ru/index.html is in sync with site/index.html\n");
  } else {
    mkdirSync(path.dirname(TARGET), { recursive: true });
    writeFileSync(TARGET, html);
    process.stdout.write(`wrote ${path.relative(root, TARGET)}\n`);
  }
}
