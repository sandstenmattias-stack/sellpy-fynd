// Sellpy-fynd – daglig bevakning
//
// Körs i GitHub Actions en gång per dygn.
// 1. Hämtar Sellpys publika söknyckel (samma metod som prototypen).
// 2. Söker på varje trend som ska bevakas, med storlek, skick och avdelning
//    från data/bevakning.json.
// 3. Jämför med data/sedda.json och tar fram nya plagg.
// 4. Skriver data/fynd.json som appen läser, och data/diagnos.json.
// 5. Skickar en enda sammanfattande notis via ntfy (ämnet ligger som hemlighet).
//
// Skriptet avslutas alltid utan fel, så att status sparas även när något går fel.

import { readFile, writeFile } from 'node:fs/promises';

const SEARCH_PAGE = 'https://www.sellpy.se/search?query=x';
const LOCALE = 'sv';
const NOW = new Date();
const DAY = 24 * 60 * 60 * 1000;

const readJson = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJson = (path, data) => writeFile(path, JSON.stringify(data, null, 2) + '\n');

// ---------- Söknyckel ----------

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} gav HTTP ${res.status}`);
  return res.text();
}

async function resolveConfig() {
  const html = await fetchText(SEARCH_PAGE);
  const bundleMatch = html.match(/\/market\/config\.prod\.[A-Za-z0-9_-]+\.bundle\.js/);
  if (!bundleMatch) throw new Error('Hittade ingen config-fil i Sellpys sida');
  const bundle = await fetchText(new URL(bundleMatch[0], 'https://www.sellpy.se').href);
  const block = bundle.match(new RegExp(`\\b${LOCALE}:\\{([^}]*)\\}`))?.[1] ?? '';
  const value = (key) => block.match(new RegExp(`${key}:(["'\\x60])([^"'\\x60]+)\\1`))?.[2];
  const indexes = {};
  for (const m of block.matchAll(/(marketItemIndex\w*):(["'\x60])([^"'\x60]+)\2/g)) indexes[m[1]] = m[3];
  const appId = value('applicationId');
  const apiKey = value('searchKey');
  if (!appId || !apiKey || !Object.keys(indexes).length) throw new Error('Ofullständig konfiguration från Sellpy');
  return { appId, apiKey, indexes, locale: LOCALE, hamtad: NOW.toISOString(), reserv: false };
}

const pickIndex = (indexes, re) => {
  const k = Object.keys(indexes).find((key) => re.test(key));
  return k ? indexes[k] : Object.values(indexes)[0];
};

async function algolia(cfg, requests) {
  const res = await fetch(`https://${cfg.appId}-dsn.algolia.net/1/indexes/*/queries`, {
    method: 'POST',
    headers: {
      'x-algolia-application-id': cfg.appId,
      'x-algolia-api-key': cfg.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Sökningen gav HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text).results ?? [];
}

// ---------- Filter ----------

const quote = (v) => `"${String(v).replace(/"/g, '\\"')}"`;
const orGroup = (field, values) => '(' + values.map((v) => `${field}:${quote(v)}`).join(' OR ') + ')';

function allSizes(settings) {
  return [...new Set(Object.values(settings.storlekar ?? {}).flat())];
}

function baseFilter(settings) {
  const parts = [];
  if (settings.avdelningar?.length) parts.push(orGroup('metadata.demography', settings.avdelningar));
  if (settings.skick?.length) parts.push(orGroup('metadata.condition', settings.skick));
  const sizes = allSizes(settings);
  if (sizes.length) parts.push(orGroup('sizes', sizes));
  if (settings.maxpris > 0) parts.push(`pricing.amount <= ${Number(settings.maxpris)}`);
  parts.push('isForSale:true');
  return parts;
}

// Matchar trendens filter mot Sellpys riktiga filtervärden.
async function resolveTrendFilters(cfg, relevance, trends) {
  const fields = [...new Set(trends.flatMap((t) => (t.filter ?? []).map((f) => f.falt)))];
  if (!fields.length) return { values: {}, resolved: {} };
  const [r] = await algolia(cfg, [
    { indexName: relevance, query: '', hitsPerPage: 0, facets: fields, maxValuesPerFacet: 1000 },
  ]);
  const values = r.facets ?? {};
  const resolved = {};
  for (const t of trends) {
    const groups = [];
    let missing = false;
    for (const f of t.filter ?? []) {
      const re = new RegExp(f.matchar, 'i');
      const hits = Object.keys(values[f.falt] ?? {}).filter((v) => re.test(v));
      if (hits.length) groups.push({ falt: f.falt, varden: hits });
      else missing = true;
    }
    resolved[t.id] = { groups, missing };
  }
  return { values, resolved };
}

// ---------- Plagg ----------

function sizeLabel(code) {
  if (!code) return '';
  const c = String(code);
  let m;
  if ((m = c.match(/^MEN-INT-(.+)$/))) return m[1];
  if ((m = c.match(/^MEN-EU-(\d+)$/))) return `EU ${m[1]}`;
  if ((m = c.match(/^PANTS-INCH-(\d+)$/))) return `W${m[1]}`;
  if ((m = c.match(/^SHOES-EU-(.+)$/))) return `EU ${m[1]}`;
  if ((m = c.match(/^WMN-INT-(.+)$/))) return `Dam ${m[1]}`;
  if ((m = c.match(/^WMN-EU-(\d+)$/))) return `Dam EU ${m[1]}`;
  if ((m = c.match(/^CHILD-CM-(\d+)$/))) return `${m[1]} cl`;
  if (c === 'NO SIZE') return 'Ingen storlek';
  if (c === 'ONE SIZE') return 'One size';
  return c;
}

function compact(h) {
  const m = h.metadata ?? {};
  const pris = h.pricing?.amount ?? (h.price_SE?.amount != null ? Math.round(h.price_SE.amount / 100) : null);
  const drop = h.priceDrop_SE;
  const tidigare =
    drop && typeof drop === 'object' && drop.amount != null
      ? Math.round(drop.amount / 100)
      : null;
  return {
    id: h.objectID,
    marke: m.brand ?? null,
    typ: m.type ?? null,
    storlek: sizeLabel(Array.isArray(h.sizes) ? h.sizes[0] : m.size),
    skick: m.condition ?? null,
    pris,
    tidigarePris: tidigare && pris != null && tidigare > pris ? tidigare : null,
    bild: Array.isArray(h.images) ? h.images[0] : null,
    lank: `https://www.sellpy.se/item/${h.objectID}`,
    ut: h.saleStartedAt ?? null,
  };
}

const available = (h) => h.isForSale !== false && h.isReserved !== true;

// ---------- Notis ----------

async function notify(topic, { title, body, click, tags }) {
  if (!topic) return { skickad: false, orsak: 'Inget ntfy-ämne' };
  const headers = { Title: title, Tags: tags ?? 'shirt' };
  if (click) headers.Click = click;
  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: 'POST', headers, body });
  return { skickad: res.ok, status: res.status };
}

// ---------- Huvudflöde ----------

async function main() {
  const settings = await readJson('data/bevakning.json', {});
  const trendFile = await readJson('data/trender.json', { trender: [] });
  const seen = await readJson('data/sedda.json', {});
  const previous = await readJson('data/fynd.json', null);
  const topic = (process.env.NTFY_TOPIC ?? '').trim();
  const firstRun = Object.keys(seen).length === 0;
  const today = NOW.toISOString().slice(0, 10);

  const active = trendFile.trender.filter((t) => t.bevakas && (!t.giltigTill || t.giltigTill >= today));

  let cfg;
  try {
    cfg = await resolveConfig();
    await writeJson('config.json', cfg);
  } catch (e) {
    cfg = await readJson('config.json', null);
    if (!cfg) throw new Error(`Kunde inte hämta söknyckeln: ${e.message}`);
    cfg.varning = `Använder sparad nyckel: ${e.message}`;
  }

  const newest = pickIndex(cfg.indexes, /SaleStart.*Desc|saleStartedAt_desc/i);
  const relevance = pickIndex(cfg.indexes, /Relevance|^marketItemIndex$/i);
  const { resolved } = await resolveTrendFilters(cfg, relevance, active);
  const base = baseFilter(settings);

  const result = [];
  let totalNew = 0;
  let prisfallExempel = [];
  for (const t of active) {
    const res = resolved[t.id] ?? { groups: [], missing: false };
    const parts = [...base, ...res.groups.map((g) => orGroup(g.falt, g.varden))];
    const query = res.missing && t.reservSokord ? t.reservSokord : t.sokord ?? '';
    try {
      const [r] = await algolia(cfg, [
        { indexName: newest, query, hitsPerPage: settings.plaggPerTrend ?? 40, filters: parts.join(' AND ') },
      ]);
      const hits = (r.hits ?? []).filter(available);
      if (!prisfallExempel.length) {
        prisfallExempel = (r.hits ?? [])
          .filter((h) => h.priceDrop_SE != null)
          .slice(0, 3)
          .map((h) => ({ id: h.objectID, pricing: h.pricing, priceDrop_SE: h.priceDrop_SE }));
      }
      const fresh = hits.filter((h) => !seen[h.objectID]);
      for (const h of hits) if (!seen[h.objectID]) seen[h.objectID] = today;
      if (!firstRun) totalNew += fresh.length;
      result.push({
        id: t.id,
        namn: t.namn,
        antalTotalt: r.nbHits,
        sokord: query,
        filter: parts.join(' AND '),
        reservSokordAnvant: res.missing && !!t.reservSokord,
        nya: firstRun ? [] : fresh.map(compact),
        senaste: hits.slice(0, 12).map(compact),
      });
    } catch (e) {
      result.push({ id: t.id, namn: t.namn, fel: e.message, nya: [], senaste: [] });
    }
  }

  // Rensa gamla plagg ur historiken.
  const keepDays = settings.sparaSeddaDagar ?? 60;
  const cutoff = new Date(NOW.getTime() - keepDays * DAY).toISOString().slice(0, 10);
  for (const [id, date] of Object.entries(seen)) if (date < cutoff) delete seen[id];

  // Diagnos: hur Sellpy anger byxlängd, för att kunna filtrera på längd senare.
  const diagnos = { kord: NOW.toISOString(), prisfallExempel };
  try {
    const pants = settings.storlekar?.byxor ?? [];
    if (pants.length) {
      const [d] = await algolia(cfg, [
        {
          indexName: relevance,
          query: '',
          hitsPerPage: 20,
          filters: [orGroup('metadata.demography', settings.avdelningar ?? ['Man']), orGroup('sizes', pants)].join(' AND '),
          facets: ['metadata.size', 'metadata.pantsLength', 'metadata.measurement.innerLegLengthInCm'],
          maxValuesPerFacet: 40,
        },
      ]);
      diagnos.byxor = {
        storlekstext: Object.entries(d.facets?.['metadata.size'] ?? {}).slice(0, 40),
        byxlangd: Object.entries(d.facets?.['metadata.pantsLength'] ?? {}).slice(0, 40),
        innerbenCm: Object.entries(d.facets?.['metadata.measurement.innerLegLengthInCm'] ?? {}).slice(0, 40),
        exempel: (d.hits ?? []).slice(0, 5).map((h) => ({ id: h.objectID, metadata: h.metadata })),
      };
    }
  } catch (e) {
    diagnos.fel = e.message;
  }

  const errors = result.filter((r) => r.fel);
  const fynd = {
    kord: NOW.toISOString(),
    status: errors.length === result.length && result.length ? 'fel' : errors.length ? 'delvis' : 'ok',
    forstaKorningen: firstRun,
    nyaTotalt: totalNew,
    installningar: {
      avdelningar: settings.avdelningar,
      storlekar: Object.fromEntries(Object.entries(settings.storlekar ?? {}).map(([k, v]) => [k, v.map(sizeLabel)])),
      skick: settings.skick,
      maxpris: settings.maxpris ?? null,
    },
    trender: result,
  };

  // Notis
  const app = settings.appAdress;
  let notis;
  if (fynd.status === 'fel') {
    notis = await notify(topic, {
      title: 'Sellpy-fynd: bevakningen misslyckades',
      body: `Ingen trend gick att söka. Första felet: ${errors[0]?.fel ?? 'okänt'}`,
      click: app,
      tags: 'warning',
    });
  } else if (firstRun) {
    const lines = result.filter((r) => !r.fel).map((r) => `${r.namn}: ${r.antalTotalt ?? 0}`);
    notis = await notify(topic, {
      title: 'Sellpy-fynd: bevakningen är igång',
      body: `Plagg i din storlek och ditt skick just nu. ${lines.join(', ')}. Från och med i morgon får du bara nya.`,
      click: app,
    });
  } else if (totalNew > 0) {
    const lines = result.filter((r) => r.nya?.length).map((r) => `${r.nya.length} ${r.namn.toLowerCase()}`);
    notis = await notify(topic, {
      title: `Sellpy-fynd: ${totalNew} nya plagg`,
      body: lines.join(', '),
      click: app,
    });
  } else {
    notis = { skickad: false, orsak: 'Inga nya plagg' };
  }
  fynd.notis = notis;

  await writeJson('data/fynd.json', fynd);
  await writeJson('data/sedda.json', seen);
  await writeJson('data/diagnos.json', diagnos);
  console.log(`Klart: status ${fynd.status}, ${totalNew} nya plagg, notis ${JSON.stringify(notis)}`);
  if (previous?.status === 'fel' && fynd.status !== 'fel') console.log('Bevakningen fungerar igen.');
}

main().catch(async (e) => {
  console.error('Bevakningen misslyckades:', e.message);
  const settings = await readJson('data/bevakning.json', {});
  const fynd = { kord: NOW.toISOString(), status: 'fel', fel: e.message, trender: [] };
  try {
    fynd.notis = await notify((process.env.NTFY_TOPIC ?? '').trim(), {
      title: 'Sellpy-fynd: bevakningen misslyckades',
      body: e.message,
      click: settings.appAdress,
      tags: 'warning',
    });
  } catch {
    /* ingen notis */
  }
  await writeJson('data/fynd.json', fynd);
});
