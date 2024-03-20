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
  - each `date/` directory contains a "bundle manifest" to track sessions
- S3 bucket (`/helix-rum-logs`)
  - `/raw/`: raw event log location, each file in this folder is a single unprocessed RUM event
  - `/processed/`: processed event location, unbundled, eg. `/{domain}/{year}/{month}/{date}/{utc_hour}/{date}-{id}.log`

### Bundle Manifest
Contains information needed to efficiently relate new RUM events to an existing session.
```json
{
  "sessions": {
    "id": {
      "hour": 1
    },
    "foo": {
      "hour": 2
    }
  }
}
```

### API
> tbd
- `GET /{domain}/{year}/${month}/{date}`
```jsonc
// response
{
  "rumBundles": [
    {
      "id": "foo",
      "time": "2024-03-18T10:00:00+00:00",
      "url": "https://www.example.com/my/path",
      "user_agent": "desktop",
      "weight": 10,
      "events": [
        {
          "checkpoint": "viewmedia",
          "time": "2024-03-18T10:00:06+00:00",
          "target": "https://www.example.com/my/image.png",
          "source": ".my-block"
        },
        {
          "checkpoint": "loadresource",
          "time": "2024-03-18T10:00:03+00:00",
          "source": "https://www.example.com/nav.plain.html",
          "target": "1"
        }
      ]
    }
  ]
}
```
- `GET /{domain}/{year}/${month}`
- `GET /{domain}/{year}`