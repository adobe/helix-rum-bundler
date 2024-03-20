# helix-rum-bundler

> Process RUM events into bundles by domain/time. Provides API to read bundles.

0. RUM events logged to S3 in individual files
1. triggered by cron (every 10min)
2. read files from logs bucket in batches of N
3. sort RUM event into bundle
4. append or write to RUM bundle
5. move `raw` file to `processed` location

### Related Resources
- EventBridge schedule
- S3 bucket (`/helix-rum-bundles`)
  - contains bundled RUM events in the format: `/{domain}/{year}/{month}/{date}/{utc_hour}.gz`
- S3 bucket (`/helix-rum-logs`)
  - `/raw/`: raw event log location, each file in this folder is a single unprocessed RUM event
  - `/processed/`: processed event location, unbundled, eg. `/{domain}/{year}/{month}/{date}/{utc_hour}/{date}-{id}.log`

### API
> tbd
- `GET /{domain}/{year}/${month}/{date}`
- `GET /{domain}/{year}/${month}`
- `GET /{domain}/{year}`