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

## Geplande terugkerende bestellingen

Voor actieve terugkerende bestellingen maakt de scheduler de Supply Panel-order 14 dagen vóór `next_payment` aan. Dezelfde geplande datum krijgt twee herinneringen:
- 7 dagen vóór de besteldatum.
- 3 dagen vóór de besteldatum.

Verzendmomenten worden in `recurring_order_reminders` opgeslagen. Een herinnering wordt pas als verzonden gemarkeerd nadat SMTP de e-mail heeft geaccepteerd. Bij een SMTP-fout blijft de herinnering open voor een nieuwe poging. De scheduler gebruikt standaard de tijdzone `Europe/Amsterdam`; dit kan worden aangepast met `BUSINESS_TIME_ZONE`.

Voor het versturen moeten `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` en `PANEL_PUBLIC_URL` zijn ingesteld. De SMTP-login (`SMTP_USER`) mag bijvoorbeeld `info@bendemen.nl` zijn; het vaste afzenderadres is `supplypanel@bendemen.nl`. De afzendernaam wordt per mailtype ingesteld. `SMTP_FROM` is niet nodig. Configureer `SMTP_USER=supplypanel@bendemen.nl` wanneer dit de mailboxlogin van je provider is. Gebruik als afzender `SMTP_FROM="Mailnaam | Bendemen Supply Panel BETA <supplypanel@bendemen.nl>"`. Vervang `SMTP_HOST` en `SMTP_PASS` door de servergegevens en het wachtwoord van deze mailbox. De header en footer worden geladen vanaf `PANEL_PUBLIC_URL/automailheader.png` en `PANEL_PUBLIC_URL/automailfooter.png`.

### Betaalde bestellingen en herinneringen

Vlak vóór iedere herinneringsmail controleert de scheduler de actuele WooCommerce-orderstatus. Bestellingen met status `processing` of `completed`, een ingevulde betaaldatum, of een lokale betaalde status krijgen geen herinnering. Ook geannuleerde en terugbetaalde bestellingen worden overgeslagen. Als WooCommerce tijdelijk niet bereikbaar is, wordt de mail niet verstuurd en blijft de herinnering klaarstaan voor een nieuwe controle.


## Mailbeheer en testmails

Onder **Beheer → Mail logs** worden de laatste 250 e-mailpogingen getoond, met type, ontvanger, order, status, tijdstip en foutmelding. Vanuit dit scherm kunnen beheerders testmails sturen voor:
- Nieuwe bestelling (inclusief PDF-pro-forma bijlage).
- Herinnering 7 dagen vooraf.
- Herinnering 3 dagen vooraf.

Testmails gebruiken voorbeeldgegevens en maken geen echte order aan. Elke test en resend wordt apart gelogd. Bij resend van een herinnering controleert Supply Panel opnieuw de actuele WooCommerce-betaalstatus; betaalde, terugbetaalde of geannuleerde bestellingen worden niet opnieuw gemaild.

De SMTP-verbinding en daadwerkelijke aflevering moeten na installatie worden getest met de testmailfunctie. Een status 'Verzonden' betekent dat de SMTP-server de mail heeft geaccepteerd, niet dat de ontvanger hem al in de inbox heeft ontvangen.
