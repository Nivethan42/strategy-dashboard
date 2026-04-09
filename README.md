# strategy-dashboard

Static GitHub Pages dashboard for two prior-data-only strategies:
- **TQQQ strategy** (QQQ-driven signal, trade TQQQ)
- **SPXL strategy** (SPY-driven signal, trade SPXL)

## Stack
- Static frontend: `index.html`, `style.css`, `app.js`
- Data pipeline: `scripts/fetch_and_update.py`
- Scheduler/deploy updates: GitHub Actions (`.github/workflows/update-data.yml`)

## Data layout
Generated files live in `data/`:

- `data/current.json` → top-level dashboard summary for all strategies
- `data/strategies/tqqq.json` → full TQQQ strategy payload
- `data/strategies/spxl.json` → full SPXL strategy payload
- `data/refresh_log.json` → automated yFinance refresh log (OK/WARN/FAIL)
- `data/changelog.json` → manual/UI/code changelog entries

Backward-compatible files are still written:
- `data/latest.json`
- `data/history.json`

## How refresh works
1. GitHub Action runs on schedule (weekday cron) or manual `workflow_dispatch`.
2. `scripts/fetch_and_update.py` fetches market data via yFinance.
3. Script computes both strategies, backtest metrics, chart series, and signal history.
4. Script updates all JSON files and appends a refresh record to `refresh_log.json`.
5. Action commits changed JSON files back to the repository.

## Update History page behavior
- **Automated Refresh Log** uses `data/refresh_log.json`.
- **Manual Site Changelog** uses `data/changelog.json`.
- Latest successful refresh is highlighted at the top.

## Add another strategy later
To add another strategy with minimal UI changes:
1. Add strategy calculation logic in `scripts/fetch_and_update.py`.
2. Write a new payload file under `data/strategies/<id>.json`.
3. Add the strategy summary object into `data/current.json` generation.
4. Frontend automatically picks up strategy IDs from loaded JSON and populates compare/select controls.

## Local update run
```bash
pip install -r requirements.txt
python scripts/fetch_and_update.py
```
Then open `index.html` (or serve via any static file server).
