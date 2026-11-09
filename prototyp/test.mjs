// Sellpy-fynd – prototyp
//
// Testar mot Sellpy innan appen byggs. Körs i GitHub Actions.
// 1. Hämtar Sellpys publika söknyckel och indexnamn från deras sajt
//    (samma metod som det öppna projektet shelfpy, MIT-licens).
// 2. Kör riktiga sökningar: fält, filtervärden, filter för avdelning,
//    skick, storlek, köpbara varor, pris och gränsen för antal träffar.
// 3. Skickar en testnotis via ntfy om ett ämne har angetts.
// 4. Skriver config.json (för appen) och prototyp/resultat.json (för Claude),
//    plus en sammanfattning på svenska i körningens sida.
//
// Skriptet avslutas alltid utan fel, så att resultaten sparas även när
// ett test misslyckas.

import { writeFile, appendFile } from 'node:fs/promises';

const SEARCH_PAGE = 'https://www.sellpy.se/search?query=x';
const LOCALE = 'sv';
const TEST_QUERY = 'pikétröja';

// Reserv: Sellpys publika söknyckel som den står i öppen kod (2026).
// Används bara om hämtningen från sajten misslyckas, för att se var felet sitter.
const FALLBACK = {
  appId: 'M6WNFR0LVI',
  apiKey: '313e09c3b00b6e2da5dbe382cd1c8f4b',
  indexes: { relevans: 'prod_marketItem_se_relevance' },
};

const results = {
  kordes: new Date().toISOString(),
  tester: [],
};

function record(namn, ok, detaljer = {}) {
  results.tester.push({ namn, ok, ...detaljer });
  const mark = ok === null ? '-- ' : ok ? 'OK ' : 'FEL';
  console.log(`[${mark}] ${namn}`);
  if (!ok && detaljer.fel) console.log(`      ${detaljer.fel}`);
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

// ---------- 1. Söknyckel och index ----------

async function resolveConfig() {
  const html = await fetchText(SEARCH_PAGE);
  const bundleMatch = html.match(/\/market\/config\.prod\.[A-Za-z0-9_-]+\.bundle\.js/);
  if (!bundleMatch) {
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]).slice(0, 15);
    throw Object.assign(new Error('Hittade ingen config-fil i Sellpys sida'), { scripts });
  }
  const bundleUrl = new URL(bundleMatch[0], 'https://www.sellpy.se').href;
  const bundle = await fetchText(bundleUrl);

  const localeMatch = bundle.match(new RegExp(`\\b${LOCALE}:\\{([^}]*)\\}`));
  const block = localeMatch?.[1] ?? '';
  const value = (key) => block.match(new RegExp(`${key}:(["'\\x60])([^"'\\x60]+)\\1`))?.[2];

  const indexes = {};
  for (const m of block.matchAll(/(marketItemIndex\w*):(["'\x60])([^"'\x60]+)\2/g)) {
    indexes[m[1]] = m[3];
  }
  const appId = value('applicationId');
  const apiKey = value('searchKey');
  if (!appId || !apiKey || Object.keys(indexes).length === 0) {
    throw new Error(
      `Ofullständig konfiguration (appId=${!!appId}, nyckel=${!!apiKey}, index=${Object.keys(indexes).length})`,
    );
  }
  return { appId, apiKey, indexes, locale: LOCALE, bundle: bundleUrl, hamtad: new Date().toISOString() };
}

// ---------- Sökanrop ----------

async function algolia(cfg, requests) {
  const url = `https://${cfg.appId}-dsn.algolia.net/1/indexes/*/queries`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-algolia-application-id': cfg.appId,
      'x-algolia-api-key': cfg.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Sökning gav HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text).results ?? [];
}

async function search(cfg, index, params) {
  const [r] = await algolia(cfg, [{ indexName: index, ...params }]);
  return r;
}

function pickIndex(indexes, wanted) {
  const key = Object.keys(indexes).find((k) => wanted.test(k));
  return key ? indexes[key] : Object.values(indexes)[0];
}

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function quote(v) {
  return `"${String(v).replace(/"/g, '\\"')}"`;
}

function normalize(h) {
  const m = h.metadata ?? {};
  const keys = Object.keys(h);
  return {
    id: h.objectID,
    marke: m.brand ?? null,
    typ: m.type ?? null,
    storlek: m.size ?? null,
    storlekskoder: h.sizes ?? null,
    skick: m.condition ?? null,
    avdelning: m.demography ?? null,
    pris_pricing: h.pricing?.amount ?? null,
    pris_SE_ore: h.price_SE?.amount ?? null,
    tidigare_pris_falt: keys.filter((k) => /old|drop|before/i.test(k)),
    favorit_falt: keys.filter((k) => /favou?rite/i.test(k)).map((k) => [k, h[k]]),
    tillSalu: h.isForSale ?? null,
    reserverad_falt: keys.filter((k) => /reserv/i.test(k)).map((k) => [k, h[k]]),
    saleStartedAt: h.saleStartedAt ?? null,
    bild: Array.isArray(h.images) ? h.images[0] : null,
    lank: `https://www.sellpy.se/item/${h.objectID}`,
  };
}

// Hur ofta ett fält är ifyllt i ett urval träffar.
function fillRate(hits, paths) {
  const out = {};
  for (const p of paths) {
    const filled = hits.filter((h) => {
      const v = get(h, p);
      return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
    }).length;
    out[p] = `${filled}/${hits.length}`;
  }
  return out;
}

// ---------- Testerna ----------

async function main() {
  let cfg = null;

  // T1
  try {
    cfg = await resolveConfig();
    record('1. Hämta söknyckel och index från Sellpys sajt', true, {
      appId: cfg.appId,
      index: cfg.indexes,
    });
  } catch (e) {
    record('1. Hämta söknyckel och index från Sellpys sajt', false, { fel: e.message, scripts: e.scripts });
  }

  // T1b – reservnyckeln
  try {
    const r = await search(FALLBACK, FALLBACK.indexes.relevans, { query: TEST_QUERY, hitsPerPage: 1 });
    record('1b. Reservnyckeln från öppen kod fungerar', true, { traffar: r.nbHits });
    if (!cfg) cfg = { ...FALLBACK, locale: LOCALE, hamtad: new Date().toISOString(), reserv: true };
  } catch (e) {
    record('1b. Reservnyckeln från öppen kod fungerar', false, { fel: e.message });
  }

  if (!cfg) {
    await finish(null);
    return;
  }

  const newest = pickIndex(cfg.indexes, /SaleStart.*Desc|saleStartedAt_desc/i);
  const relevance = pickIndex(cfg.indexes, /Relevance|^marketItemIndex$/i);
  results.valtIndex = { nyast: newest, relevans: relevance };

  // T2 – enkel sökning och vilka fält som finns
  let sampleHits = [];
  try {
    const r = await search(cfg, newest, { query: TEST_QUERY, hitsPerPage: 50 });
    sampleHits = r.hits ?? [];
    const first = sampleHits[0] ?? {};
    record(`2. Sökning på "${TEST_QUERY}"`, sampleHits.length > 0, {
      traffar: r.nbHits,
      sidor: r.nbPages,
      perSida: r.hitsPerPage,
      faltIForstaTraffen: Object.keys(first),
      metadataFalt: Object.keys(first.metadata ?? {}),
      ifyllda: fillRate(sampleHits, [
        'metadata.brand', 'metadata.type', 'metadata.size', 'sizes', 'metadata.condition',
        'metadata.demography', 'pricing.amount', 'price_SE.amount', 'images', 'isForSale',
        'favouriteCount', 'favoriteCount', 'saleStartedAt',
      ]),
    });
  } catch (e) {
    record(`2. Sökning på "${TEST_QUERY}"`, false, { fel: e.message });
  }

  // T3 – filtervärden (facetter)
  let facets = {};
  try {
    const r = await search(cfg, relevance, { query: '', hitsPerPage: 0, facets: ['*'], maxValuesPerFacet: 100 });
    facets = r.facets ?? {};
    const top = (attr, n = 40) =>
      Object.entries(facets[attr] ?? {}).sort((a, b) => b[1] - a[1]).slice(0, n);
    record('3. Filtervärden från Sellpys data', Object.keys(facets).length > 0, {
      filterbaraFalt: Object.keys(facets),
      avdelning: top('metadata.demography'),
      skick: top('metadata.condition'),
      kategori: top('categories.lvl0'),
      plaggtyp: top('metadata.type', 60),
      storlekskoder: top('sizes', 60),
    });
  } catch (e) {
    record('3. Filtervärden från Sellpys data', false, { fel: e.message });
  }

  // T4 – filter steg för steg
  const demVals = Object.keys(facets['metadata.demography'] ?? {});
  const herr = demVals.find((v) => /^(man|män|herr|men)/i.test(v)) ?? demVals[0];
  const condVals = Object.keys(facets['metadata.condition'] ?? {});
  const cond = condVals.find((v) => /mycket bra/i.test(v)) ?? condVals[0];

  let herrSize = null;
  if (herr) {
    try {
      const r = await search(cfg, relevance, {
        query: TEST_QUERY,
        hitsPerPage: 0,
        facets: ['sizes'],
        maxValuesPerFacet: 40,
        filters: `metadata.demography:${quote(herr)}`,
      });
      const sizes = Object.entries(r.facets?.sizes ?? {}).sort((a, b) => b[1] - a[1]);
      results.storlekarForHerrPiketroja = sizes;
      herrSize = sizes.find(([v]) => /-L$/i.test(v))?.[0] ?? sizes[0]?.[0] ?? null;
    } catch (e) {
      results.storlekarForHerrPiketroja = { fel: e.message };
    }
  }

  const steps = [];
  if (herr) steps.push(['avdelning', `metadata.demography:${quote(herr)}`]);
  if (cond) steps.push(['skick', `metadata.condition:${quote(cond)}`]);
  if (herrSize) steps.push(['storlek', `sizes:${quote(herrSize)}`]);
  steps.push(['till salu', 'isForSale:true']);

  const filterRuns = [];
  let filters = '';
  for (const [namn, f] of steps) {
    const tryFilters = filters ? `${filters} AND ${f}` : f;
    try {
      const r = await search(cfg, newest, { query: TEST_QUERY, hitsPerPage: 6, filters: tryFilters });
      filterRuns.push({ steg: namn, filter: tryFilters, traffar: r.nbHits });
      filters = tryFilters;
    } catch (e) {
      filterRuns.push({ steg: namn, filter: tryFilters, fel: e.message });
    }
  }
  for (const [namn, f] of [
    ['pris max 300 (pricing.amount)', 'pricing.amount <= 300'],
    ['pris max 300 (price_SE.amount i öre)', 'price_SE.amount <= 30000'],
  ]) {
    try {
      const r = await search(cfg, newest, { query: TEST_QUERY, hitsPerPage: 0, filters: filters ? `${filters} AND ${f}` : f });
      filterRuns.push({ steg: namn, filter: f, traffar: r.nbHits });
    } catch (e) {
      filterRuns.push({ steg: namn, filter: f, fel: e.message });
    }
  }
  const filtersOk = filterRuns.filter((x) => !x.fel && ['avdelning', 'skick', 'storlek'].includes(x.steg)).length;
  record('4. Filter för avdelning, skick, storlek, till salu och pris', filtersOk >= 2, {
    valdaVarden: { avdelning: herr ?? null, skick: cond ?? null, storlek: herrSize },
    steg: filterRuns,
  });

  // T5 – exempelträffar med alla filter
  try {
    const r = await search(cfg, newest, { query: TEST_QUERY, hitsPerPage: 6, filters });
    const hits = (r.hits ?? []).map(normalize);
    record('5. Exempelträffar med bild, märke, storlek, skick, pris och länk', hits.length > 0, {
      filter: filters,
      traffar: hits,
    });
  } catch (e) {
    record('5. Exempelträffar med bild, märke, storlek, skick, pris och länk', false, { fel: e.message });
  }

  // T6 – gränsen för antal träffar per sökning
  try {
    const p9 = await search(cfg, relevance, { query: '', hitsPerPage: 100, page: 9 });
    const p10 = await search(cfg, relevance, { query: '', hitsPerPage: 100, page: 10 });
    record('6. Gräns för antal träffar som går att bläddra fram', true, {
      totaltIIndex: p9.nbHits,
      sidorEnligtSvar: p9.nbPages,
      traffarSida10: (p9.hits ?? []).length,
      traffarSida11: (p10.hits ?? []).length,
      tolkning:
        (p10.hits ?? []).length === 0 && (p9.hits ?? []).length > 0
          ? 'Högst 1 000 träffar går att bläddra fram per sökning'
          : 'Ingen gräns vid 1 000 syntes',
    });
  } catch (e) {
    record('6. Gräns för antal träffar som går att bläddra fram', false, { fel: e.message });
  }

  // T7 – testnotis
  const topic = (process.env.NTFY_TOPIC ?? '').trim();
  if (topic) {
    try {
      const n = results.tester.find((t) => t.namn.startsWith('5.'))?.traffar?.length ?? 0;
      const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, {
        method: 'POST',
        headers: { Title: 'Sellpy-fynd', Tags: 'shirt' },
        body: `Testnotis från prototypen. ${n} exempelträffar på ${TEST_QUERY} i din storlek och ditt skick.`,
      });
      record('7. Testnotis till iPhone via ntfy', res.ok, res.ok ? {} : { fel: `HTTP ${res.status}` });
    } catch (e) {
      record('7. Testnotis till iPhone via ntfy', false, { fel: e.message });
    }
  } else {
    record('7. Testnotis till iPhone via ntfy', null, { fel: 'Inget ntfy-ämne angavs, testet hoppades över' });
  }

  await finish(cfg);
}

async function finish(cfg) {
  if (cfg) {
    const { appId, apiKey, indexes, locale, hamtad, reserv } = cfg;
    await writeFile('config.json', JSON.stringify({ appId, apiKey, indexes, locale, hamtad, reserv: !!reserv }, null, 2) + '\n');
  }
  await writeFile('prototyp/resultat.json', JSON.stringify(results, null, 2) + '\n');

  const lines = [
    '# Sellpy-fynd: prototyptest',
    '',
    ...results.tester.map((t) => `- ${t.ok === null ? 'HOPPADES ÖVER' : t.ok ? 'OK' : 'FEL'}: ${t.namn}${t.fel ? ` (${t.fel})` : ''}`),
    '',
    'Alla detaljer finns i prototyp/resultat.json.',
  ];
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  console.log('\n' + lines.join('\n'));
}

main().catch(async (e) => {
  record('Oväntat fel', false, { fel: e.message });
  await finish(null);
});
