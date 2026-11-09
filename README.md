# Sellpy-fynd

Personligt verktyg som söker på Sellpy efter plagg som är i ropet, i rätt storlek och skick.

- **Appen:** `app/index.html`, publicerad med GitHub Pages. Spara den på hemskärmen i Safari.
- **Trender:** `data/trender.json`, från Sellpys egna sökrapporter, med källa och slutdatum.
- **Bevakning:** `bevakning/kor.mjs` körs varje morgon via `.github/workflows/bevakning.yml`. Inställningar i `data/bevakning.json`. Notisen går via ntfy; ämnet ligger som hemlighet (`NTFY_TOPIC`).
- **Prototyp:** `prototyp/`, testet som bevisade att sökningen fungerar.

Hämtningen av Sellpys publika söknyckel bygger på metoden i [shelfpy](https://github.com/karlerikjonatan/shelfpy) (MIT-licens).

Sökningarna sker sällan och bara för personligt bruk. GitHub kan stänga av schemalagda körningar i kodförråd som inte har haft någon aktivitet på 60 dagar; slå i så fall på bevakningen igen under Actions.
