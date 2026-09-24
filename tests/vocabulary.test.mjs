// Person-facing strings must use the product vocabulary in contracts/vocabulary.md.
// The rules live in contracts/vocabulary.json; one-string exceptions live in
// contracts/vocabulary-allowlist.json and must carry a reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const vocabulary = JSON.parse(read("contracts/vocabulary.json"));
const allowlist = JSON.parse(read("contracts/vocabulary-allowlist.json"));

const rules = Object.fromEntries(Object.entries(vocabulary.forbidden).map(([lang, list]) => [
  lang,
  list.map((rule) => ({ ...rule, re: new RegExp(rule.pattern, lang === "ru" ? "giu" : "giu") })),
]));

function parseStrings(text) {
  // Apple .strings: "key" = "value"; — the value is what a person reads.
  const entries = [];
  const re = /^\s*"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/gmu;
  for (const m of text.matchAll(re)) entries.push({ key: m[1], value: m[2].replace(/\\"/g, '"') });
  return entries;
}

function flatten(value, prefix, out) {
  if (typeof value === "string") out.push({ key: prefix, value });
  else if (Array.isArray(value)) value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

function siteI18n(html) {
  const start = html.indexOf("const I18N = {");
  assert.notEqual(start, -1, "site/index.html must keep its I18N dictionary");
  const end = html.indexOf("\n};", start);
  assert.notEqual(end, -1, "the I18N dictionary must end with a line '};'");
  const literal = html.slice(start + "const I18N = ".length, end + 2);
  return vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1000 });
}

function stripTags(fragment) {
  return fragment.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function siteStatic(html) {
  // Visible English defaults, <title>, meta texts, labelling attributes and JSON-LD.
  const out = [];
  for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    flatten(JSON.parse(m[1]), "ld+json", out);
  }
  for (const m of html.matchAll(/<meta\s+(?:name|property)="([^"]+)"\s+content="([^"]*)"/g)) {
    if (/description|title|og:|twitter:/.test(m[1])) out.push({ key: `meta:${m[1]}`, value: m[2] });
  }
  for (const m of html.matchAll(/\s(aria-label|title|alt)="([^"]*)"/g)) out.push({ key: `@${m[1]}`, value: m[2] });
  // Only <body> is read as page text: <title> and meta are read above, once each.
  const bodyStart = html.search(/<body[\s>]/);
  const body = (bodyStart >= 0 ? html.slice(bodyStart) : html)
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<pre[\s\S]*?<\/pre>/g, " ")
    .replace(/<code[\s\S]*?<\/code>/g, " ");
  const title = /<title>([\s\S]*?)<\/title>/.exec(html);
  if (title) out.push({ key: "<title>", value: title[1] });
  stripTags(body).split(/\n+/).map((s) => s.trim()).filter(Boolean)
    .forEach((line, i) => out.push({ key: `text:${i}`, value: line }));
  return out;
}

function withoutCode(value) {
  // Backticked identifiers are quoted exactly, not narrated.
  return value.replace(/`[^`]*`/g, " ");
}

function sources() {
  const list = [];
  for (const lang of ["en", "ru"]) {
    const mac = `apps/macos-menubar/Sources/MurmurTrayCore/Resources/${lang}.lproj/Localizable.strings`;
    list.push({ file: mac, lang, entries: parseStrings(read(mac)) });
    for (const dir of ["spikes/windows-tray-go", "spikes/windows-service-go"]) {
      const file = `${dir}/locales/${lang}.json`;
      list.push({ file, lang, entries: flatten(JSON.parse(read(file)), "", []) });
    }
    const presentation = JSON.parse(read("contracts/setup/presentation/status-reasons.json"));
    list.push({
      file: "contracts/setup/presentation/status-reasons.json", lang,
      entries: Object.entries(presentation.messages).map(([key, v]) => ({ key, value: v[lang] ?? "" })),
    });
  }
  const html = read("site/index.html");
  const i18n = siteI18n(html);
  for (const lang of ["en", "ru"]) {
    list.push({ file: "site/index.html#I18N", lang, entries: flatten(i18n[lang], lang, []) });
  }
  list.push({ file: "site/index.html", lang: "en", entries: siteStatic(html) });
  const wizardFile = "apps/windows-tray/packaging/murmur-setup.iss";
  const wizard = read(wizardFile).split("[CustomMessages]")[1]?.split(/^\[/m)[0];
  assert.ok(wizard, "installer must expose localized wizard messages");
  for (const [language, lang] of [["english", "en"], ["russian", "ru"]]) {
    const entries = [...wizard.matchAll(new RegExp(`^${language}\\.([^=]+)=(.*)$`, "gm"))]
      .map((m) => ({ key: m[1], value: m[2] }));
    list.push({ file: wizardFile, lang, entries });
  }
  return list;
}

function allowed(file, key, term) {
  return allowlist.exceptions.some((e) => e.file === file && e.key === key && e.term === term);
}

test("allowlist exceptions each name one string and a reason", () => {
  assert.equal(allowlist.schema, "murmur.vocabulary-allowlist/1");
  for (const e of allowlist.exceptions) {
    assert.ok(e.file && e.key && e.term, `exception is missing file/key/term: ${JSON.stringify(e)}`);
    assert.ok(typeof e.reason === "string" && e.reason.length >= 20, `exception needs a real reason: ${JSON.stringify(e)}`);
  }
});

test("every vocabulary pattern compiles and matches its own term", () => {
  for (const [lang, list] of Object.entries(rules)) {
    for (const rule of list) {
      rule.re.lastIndex = 0;
      assert.ok(rule.re.test(rule.term), `${lang} pattern for "${rule.term}" does not match the term itself`);
    }
  }
  const sample = (lang, text) => rules[lang].filter((r) => { r.re.lastIndex = 0; return r.re.test(text); }).map((r) => r.term);
  assert.deepEqual(sample("ru", "Служба работает, помощник прочитал письмо"), []);
  assert.deepEqual(sample("ru", "спиральный копир эмпирика"), [], "пир must not match inside other words");
  assert.deepEqual(sample("en", "Invite a colleague. Wake-up works."), []);
  assert.deepEqual(sample("en", "the daemon woke the peer"), ["peer", "daemon"]);
});

test("installer custom messages have both languages and no missing references", () => {
  const file = "apps/windows-tray/packaging/murmur-setup.iss";
  const dictionaries = sources().filter((source) => source.file === file);
  const keys = dictionaries.map(({ entries }) => entries.map(({ key }) => key).sort());
  assert.deepEqual(keys[0], keys[1], "every installer message needs en and ru");
  for (const match of read(file).matchAll(/CustomMessage\('([^']+)'\)/g)) {
    assert.ok(keys[0].includes(match[1]), `missing installer message: ${match[1]}`);
  }
});

test("person-facing strings use the product vocabulary", () => {
  const violations = [];
  for (const { file, lang, entries } of sources()) {
    assert.ok(entries.length > 0, `${file} (${lang}) yielded no strings — the reader is broken`);
    for (const { key, value } of entries) {
      const text = withoutCode(value);
      for (const rule of rules[lang]) {
        rule.re.lastIndex = 0;
        const hit = rule.re.exec(text);
        if (hit && !allowed(file, key, rule.term)) {
          violations.push(`${file} [${lang}] ${key}: "${hit[0]}" → ${rule.use}   «${value.slice(0, 110)}»`);
        }
      }
    }
  }
  assert.equal(violations.length, 0, `\n${violations.length} forbidden word(s):\n${violations.join("\n")}`);
});
