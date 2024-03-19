# helix-rum-bundler

> Process RUM events into bundles by domain/time. Provides API to read bundles.

0. RUM events logged to S3 in individual files, message added to queue
1. triggered by cron (every 10min)
2. read events from queue in batches of N
3. read RUM event file for each queue event
4. sort RUM event into bundle
5. append or write to RUM bundle
6. move raw file to `processed` location

### Related Resources
- SQS queue
- S3 bucket (`/helix-rum-logs`)
  - `/raw/`: raw event log location, each file in this root is a single unprocessed RUM event
  - `/raw/processed/`: raw event processed location, contains similar sub-folder structure as `/bundles/`
  - `/bundles/`: processed and bundled location, contains:
    - `/{domain}/{year}/{month}/{date}/{utc_hour}.gz`

### API
> tbd
- `GET /{domain}/{year}/${month}/{date}`
- `GET /{domain}/{year}/${month}`
- `GET /{domain}/{year}`