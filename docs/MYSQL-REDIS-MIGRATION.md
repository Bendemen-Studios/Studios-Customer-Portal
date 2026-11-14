# MySQL- en Redis-migratie

## Huidige status

De applicatie gebruikt voor de bedrijfsgegevens (gebruikers, producten, bestellingen en abonnementen) nog SQLite via `src/db.js`. De MySQL-kopie uit `npm run migrate:mysql` is een datamigratie en schakelt de applicatie niet automatisch over.

De sessieopslag kan afzonderlijk naar MySQL worden verplaatst. Redis wordt daarbij als snelle sessiecache gebruikt; MySQL blijft de persistente bron. Als Redis tijdelijk niet bereikbaar is, worden sessies uit MySQL gelezen en daar opgeslagen.

## MySQL-sessieopslag activeren

Stel in de Pterodactyl environment in:

```env
SESSION_STORE_DRIVER=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=supply_panel
DB_USER=supply_panel
DB_PASSWORD=CHANGE_ME
```

Gebruik de bestaande MySQL-database waarin de migratie is uitgevoerd. Bij het starten maakt Supply Panel de tabel `sessions` aan als die nog niet bestaat. Zet `SESSION_STORE_DRIVER` niet op `mysql` voordat de databasegegevens correct zijn ingesteld en de database bereikbaar is.

## Redis

Redis blijft optioneel. Gebruik óf een volledige URL:

```env
REDIS_URL=redis://:PASSWORD@127.0.0.1:6379/0
```

óf losse instellingen:

```env
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DB=0
REDIS_USERNAME=
REDIS_PASSWORD=CHANGE_ME
REDIS_TLS=false
REDIS_SESSION_PREFIX=bendemen:supply-panel:sess:
```

Gebruik voor iedere applicatie een eigen Redis-prefix. Zo kunnen meerdere Supply Panel-installaties dezelfde Redis-server delen zonder elkaars sessiekeys te overschrijven. Gebruik een eigen Redis-database indien de Redis-provider dat ondersteunt.

## Wat nog niet is omgeschakeld

- De overige applicatiequeries en transacties in `server.js` gebruiken nog SQLite.
- Gebruikers-, product-, order- en abonnementsrepositories moeten nog naar asynchrone MySQL-queries worden omgezet.
- De volledige WooCommerce-, scheduler- en webhookflows moeten daarna met MySQL worden getest.
- Een geslaagde CI-run bewijst niet dat de opgegeven productie-MySQL- en Redis-servers bereikbaar zijn.

Schakel de bedrijfsdatabase dus niet om door alleen `SESSION_STORE_DRIVER` te wijzigen. Deze instelling verplaatst uitsluitend sessies.
