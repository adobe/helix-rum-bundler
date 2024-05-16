# helix-rum-bundler

> Process RUM events into bundles by domain/time. Provides API to read bundles.

[![codecov](https://codecov.io/gh/adobe/helix-rum-bundler/branch/main/graph/badge.svg?token=GiNpN6FmPj)](https://codecov.io/gh/adobe/helix-rum-bundler)
[![GitHub license](https://img.shields.io/github/license/adobe/helix-rum-bundler.svg)](https://github.com/adobe/helix-rum-bundler/blob/main/LICENSE.txt)
[![GitHub issues](https://img.shields.io/github/issues/adobe/helix-rum-bundler.svg)](https://github.com/adobe/helix-rum-bundler/issues)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)

## Process

0. RUM events logged to S3 in files
1. triggered by cron (every 10min)
2. read files from logs bucket in batches of N
3. sort RUM event into bundle
4. append or write to RUM bundle
5. move `raw` file to `processed` location

### Related Resources
- EventBridge schedule
- S3 bucket (`/helix-rum-bundles`)
  - contains bundled RUM events in the format: `/{domain}/{year}/{month}/{date}/{utc_hour}.json`
  - each `date/` directory contains a "bundle manifest" to track sessions
- S3 bucket (`/helix-rum-logs`)
  - `/raw/`: raw event log location, each file in this folder is a single unprocessed RUM event
  - `/processed/`: processed event location, unbundled, eg. `/{domain}/{year}/{month}/{date}/{utc_hour}/{date}-{id}.log`

### Bundle Manifest
Contains information needed to efficiently relate new RUM events to an existing session.
```json
{
  "sessions": {
    "id--path": {
      "hour": 1
    },
    "J3Ed2--/some/path": {
      "hour": 2
    }
  }
}
```

### API

#### bundles
> requires authorization, domainkey
- `GET /bundles/{domain}/{year}/${month}/{date}/{hour}`
- `GET /bundles/{domain}/{year}/${month}/{date}`
- `GET /bundles/{domain}/{year}/${month}`
```jsonc
// response
{
  "rumBundles": [
    {
      "id": "foo",
      "time": "2024-01-01T01:02:03+00:00",
      "timeSlot": "2024-01-01T01:00:00+00:00",
      "url": "https://www.example.com/my/path",
      "userAgent": "desktop",
      "weight": 10,
      "events": [
        {
          "checkpoint": "viewmedia",
          "timeDelta": 123, // ms since timeSlot
          "target": "https://www.example.com/my/image.png",
          "source": ".my-block"
        },
        {
          "checkpoint": "loadresource",
          "timeDelta": 123,
          "source": "https://www.example.com/nav.plain.html",
          "target": "1"
        },
        {
          "checkpoint": "cwv"
        },
        {
          "checkpoint": "cwv-lcp",
          "value": 1.1
        }
      ]
    }
  ]
}
```

#### domainkey
> requires authorization, membership in allowlist
- `GET /domainkey/{domain}`
- `POST /domainkey/{domain}`
- `DELETE /domainkey/{domain}`
