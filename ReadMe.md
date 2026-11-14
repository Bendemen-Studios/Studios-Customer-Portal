# Bendemen Supply Panel

De applicatiebestanden staan rechtstreeks in de hoofdmap van deze repository. Gebruik de hoofdmap als projectmap in Pterodactyl.

## Installatie

```bash
npm install
npm start
```

Maak eerst een `.env` op basis van `.env.example` en vul de WooCommerce- en SMTP-instellingen in. Bewaar `.env` en de SQLite-database buiten versiebeheer.

Redis is optioneel. Stel `REDIS_URL` in of gebruik `REDIS_HOST`, `REDIS_PORT`, `REDIS_USERNAME`, `REDIS_PASSWORD` en `REDIS_TLS`. Sessies blijven persistent in SQLite wanneer Redis niet beschikbaar is.\n\n**Let op:** MySQL is op dit moment alleen voorbereid voor de datamigratie; de applicatie gebruikt SQLite nog als primaire database. Schakel MySQL niet in als runtime-database voordat de volledige querylaag is omgezet.\n\nZie `PTERODACTYL.txt` voor de Pterodactyl-instellingen.
